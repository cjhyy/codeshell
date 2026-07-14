import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IpcMain } from "electron";
import { ChatGateway, createAllowlistMiddleware } from "@cjhyy/code-shell-chat";
import {
  CODE_SHELL_REMOTE_COMMANDS,
  createCodeShellRemoteCommands,
  createMimiPetChat,
  defaultGatewayConfigPath,
  DesktopControlClient,
  gatewayConfigTemplate,
  loadGatewayConfig,
  loginCodeShellWechat,
} from "@cjhyy/code-shell-chat/codeshell";

export type ImGatewayChannel =
  | "telegram"
  | "discord"
  | "slack"
  | "lark"
  | "dingtalk"
  | "wecom"
  | "wechat"
  | "matrix"
  | "mattermost"
  | "line"
  | "whatsapp"
  | "teams";

export interface ImGatewayStatus {
  running: boolean;
  configPath: string;
  configExists: boolean;
  channels: ImGatewayChannel[];
  wechatConnected: boolean;
  startedAt?: number;
  error?: string;
}

export type ImGatewayUiEvent =
  | { type: "status-changed"; status: ImGatewayStatus }
  | { type: "wechat-qr"; loginId: string; url: string }
  | { type: "wechat-status"; loginId: string; status: string }
  | { type: "wechat-verification-required"; loginId: string };

export interface ImGatewayServiceOptions {
  configPath?: string;
  emit?: (event: ImGatewayUiEvent) => void;
}

interface ActiveGateway {
  abort: AbortController;
  task: Promise<void>;
  channels: ImGatewayChannel[];
  startedAt: number;
}

interface PendingVerification {
  loginId: string;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
}

/** Desktop-owned lifecycle for the reusable chat package. */
export class ImGatewayService {
  readonly configPath: string;
  private active?: ActiveGateway;
  private lastError?: string;
  private login?: { id: string; abort: AbortController };
  private verification?: PendingVerification;

  constructor(private readonly options: ImGatewayServiceOptions = {}) {
    this.configPath = resolve(
      options.configPath ?? process.env.CODE_SHELL_IM_GATEWAY_CONFIG ?? defaultGatewayConfigPath(),
    );
  }

  status(): ImGatewayStatus {
    let channels: ImGatewayChannel[] = this.active?.channels ?? [];
    let configError: string | undefined;
    try {
      const configuredChannels = loadGatewayConfig({ configPath: this.configPath }).channels.map(
        ({ channel }) => channel,
      );
      if (!this.active) channels = configuredChannels;
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
    return {
      running: Boolean(this.active),
      configPath: this.configPath,
      configExists: existsSync(this.configPath),
      channels,
      wechatConnected: channels.includes("wechat"),
      ...(this.active ? { startedAt: this.active.startedAt } : {}),
      ...((this.lastError ?? configError) ? { error: this.lastError ?? configError } : {}),
    };
  }

  async start(): Promise<ImGatewayStatus> {
    if (this.active) return this.status();
    // Adapter imports include optional third-party SDKs. Load them only when
    // starting the gateway so status/config operations stay lightweight and
    // do not probe a renderer-like global `window` in mixed test processes.
    const { createChannelAdapter } = await import("@cjhyy/code-shell-chat/factory");
    const config = loadGatewayConfig({ configPath: this.configPath });
    const desktop = new DesktopControlClient(config.desktop);
    const abort = new AbortController();
    const gateway = new ChatGateway({
      adapters: config.channels.map((channel) =>
        createChannelAdapter(channel, { discordCommands: CODE_SHELL_REMOTE_COMMANDS }),
      ),
      webhook: config.webhook,
    });
    gateway.use(
      createAllowlistMiddleware(
        Object.fromEntries(
          config.channels.map((channel) => [
            channel.channel,
            { targetIds: channel.allowedTargetIds, userIds: channel.allowedUserIds },
          ]),
        ),
      ),
    );
    gateway.use(createCodeShellRemoteCommands({ desktop }));
    gateway.use(createMimiPetChat({ desktop }));

    this.lastError = undefined;
    const active: ActiveGateway = {
      abort,
      task: Promise.resolve(),
      channels: config.channels.map(({ channel }) => channel),
      startedAt: Date.now(),
    };
    this.active = active;
    active.task = gateway.run(abort.signal);
    void active.task.then(
      () => this.onGatewaySettled(active, undefined),
      (error) => this.onGatewaySettled(active, error),
    );

    // Surface adapters that reject during their first turn as a failed start,
    // instead of briefly showing a misleading green state in the Link page.
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 25));
    if (this.active !== active) throw new Error(this.lastError ?? "Chat Gateway 启动后立即退出");
    this.emitStatus();
    return this.status();
  }

  async stop(): Promise<ImGatewayStatus> {
    const active = this.active;
    if (!active) return this.status();
    this.active = undefined;
    active.abort.abort();
    await Promise.race([
      active.task.catch(() => undefined),
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);
    this.emitStatus();
    return this.status();
  }

  ensureConfig(): string {
    if (existsSync(this.configPath)) return this.configPath;
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(gatewayConfigTemplate(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.configPath);
    if (process.platform !== "win32") chmodSync(this.configPath, 0o600);
    this.emitStatus();
    return this.configPath;
  }

  async loginWechat(): Promise<{ accountId: string; configPath: string }> {
    if (this.login) throw new Error("个人微信登录正在进行中");
    const restartAfterLogin = Boolean(this.active);
    const id = randomUUID();
    const abort = new AbortController();
    this.login = { id, abort };
    try {
      const result = await loginCodeShellWechat({
        configPath: this.configPath,
        signal: abort.signal,
        onQrCode: (url) => this.emit({ type: "wechat-qr", loginId: id, url }),
        onStatus: (status) =>
          this.emit({ type: "wechat-status", loginId: id, status: String(status) }),
        requestVerificationCode: () => this.requestVerificationCode(id),
      });
      this.lastError = undefined;
      if (restartAfterLogin) {
        await this.stop();
        await this.start();
      } else {
        this.emitStatus();
      }
      return result;
    } finally {
      if (this.login?.id === id) this.login = undefined;
      if (this.verification?.loginId === id) {
        this.verification.reject(new Error("微信登录已结束"));
        this.verification = undefined;
      }
    }
  }

  submitWechatVerification(loginId: string, code: string): boolean {
    const pending = this.verification;
    const normalized = code.trim();
    if (!pending || pending.loginId !== loginId || !normalized) return false;
    this.verification = undefined;
    pending.resolve(normalized);
    return true;
  }

  cancelWechatLogin(): boolean {
    const login = this.login;
    if (!login) return false;
    this.login = undefined;
    login.abort.abort();
    if (this.verification?.loginId === login.id) {
      const pending = this.verification;
      this.verification = undefined;
      pending.reject(new Error("微信登录已取消"));
    }
    return true;
  }

  async dispose(): Promise<void> {
    this.cancelWechatLogin();
    await this.stop();
  }

  private requestVerificationCode(loginId: string): Promise<string> {
    if (this.verification) throw new Error("已有微信验证数字等待输入");
    return new Promise<string>((resolveCode, rejectCode) => {
      this.verification = { loginId, resolve: resolveCode, reject: rejectCode };
      this.emit({ type: "wechat-verification-required", loginId });
    });
  }

  private onGatewaySettled(active: ActiveGateway, error: unknown): void {
    if (this.active !== active) return;
    this.active = undefined;
    if (!active.abort.signal.aborted) {
      this.lastError = error
        ? error instanceof Error
          ? error.message
          : String(error)
        : "Chat Gateway 意外退出";
    }
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit({ type: "status-changed", status: this.status() });
  }

  private emit(event: ImGatewayUiEvent): void {
    this.options.emit?.(event);
  }
}

export function registerImGatewayIpc(ipcMain: IpcMain, service: ImGatewayService): void {
  ipcMain.handle("im-gateway:status", () => service.status());
  ipcMain.handle("im-gateway:start", () => service.start());
  ipcMain.handle("im-gateway:stop", () => service.stop());
  ipcMain.handle("im-gateway:ensureConfig", () => service.ensureConfig());
  ipcMain.handle("im-gateway:wechatLogin", () => service.loginWechat());
  ipcMain.handle("im-gateway:wechatCancelLogin", () => service.cancelWechatLogin());
  ipcMain.handle("im-gateway:wechatSubmitVerification", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("缺少微信验证参数");
    const input = raw as Record<string, unknown>;
    if (typeof input.loginId !== "string" || typeof input.code !== "string") {
      throw new Error("微信验证参数无效");
    }
    return service.submitWechatVerification(input.loginId, input.code);
  });
}
