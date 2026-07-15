import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IpcMain } from "electron";
import {
  acquireGatewayInstanceLock,
  ChatGateway,
  createAllowlistMiddleware,
  createDesktopNotificationHandler,
  createRateLimitMiddleware,
  type AdapterRuntimeState,
  type ChatMiddleware,
  type GatewayInstanceLease,
} from "@cjhyy/code-shell-chat";
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

export const IM_GATEWAY_CHANNELS: readonly ImGatewayChannel[] = [
  "telegram",
  "discord",
  "slack",
  "lark",
  "dingtalk",
  "wecom",
  "wechat",
  "matrix",
  "mattermost",
  "line",
  "whatsapp",
  "teams",
];

export interface ImGatewayChannelStatus {
  channel: ImGatewayChannel;
  enabled: boolean;
  state: "disabled" | "needs-config" | "ready" | "starting" | "running" | "retrying";
  attempts?: number;
  error?: string;
}

export interface ImGatewayActivity {
  id: string;
  requestId: string;
  channel: ImGatewayChannel;
  direction: "inbound" | "outbound";
  status: "received" | "sent" | "failed";
  target: string;
  senderId?: string;
  text: string;
  attachmentCount?: number;
  createdAt: number;
}

export interface ImGatewayStatus {
  running: boolean;
  configPath: string;
  configExists: boolean;
  channels: ImGatewayChannel[];
  channelStatuses: ImGatewayChannelStatus[];
  recentActivity: ImGatewayActivity[];
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
  lease: GatewayInstanceLease;
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
  private readonly adapterStates = new Map<ImGatewayChannel, AdapterRuntimeState>();
  private readonly recentActivity: ImGatewayActivity[] = [];
  /** Set while a stopped gateway's instance lease is still being released. */
  private pendingRelease?: Promise<void>;

  constructor(private readonly options: ImGatewayServiceOptions = {}) {
    this.configPath = resolve(
      options.configPath ?? process.env.CODE_SHELL_IM_GATEWAY_CONFIG ?? defaultGatewayConfigPath(),
    );
  }

  status(): ImGatewayStatus {
    let channels: ImGatewayChannel[] = this.active?.channels ?? [];
    let configError: string | undefined;
    let rawEnabled = new Set<ImGatewayChannel>();
    try {
      rawEnabled = readEnabledChannels(this.configPath);
      const configuredChannels = loadGatewayConfig({ configPath: this.configPath }).channels.map(
        ({ channel }) => channel,
      );
      if (!this.active) channels = configuredChannels;
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
    for (const channel of channels) rawEnabled.add(channel);
    const activeChannels = new Set(this.active?.channels ?? []);
    const channelStatuses = IM_GATEWAY_CHANNELS.map((channel): ImGatewayChannelStatus => {
      const enabled = rawEnabled.has(channel);
      if (!enabled) return { channel, enabled: false, state: "disabled" };
      if (configError && !this.active) {
        return { channel, enabled: true, state: "needs-config", error: configError };
      }
      if (!this.active) return { channel, enabled: true, state: "ready" };
      if (!activeChannels.has(channel)) {
        return configError
          ? { channel, enabled: true, state: "needs-config", error: configError }
          : { channel, enabled: true, state: "ready" };
      }
      const runtime = this.adapterStates.get(channel);
      if (!runtime) return { channel, enabled: true, state: "starting" };
      if (runtime.state === "backoff") {
        return {
          channel,
          enabled: true,
          state: "retrying",
          attempts: runtime.attempts,
          ...(runtime.error ? { error: runtime.error } : {}),
        };
      }
      return {
        channel,
        enabled: true,
        state: runtime.state === "running" ? "running" : "starting",
        attempts: runtime.attempts,
      };
    });
    return {
      running: Boolean(this.active),
      configPath: this.configPath,
      configExists: existsSync(this.configPath),
      channels,
      channelStatuses,
      recentActivity: [...this.recentActivity],
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
    // A previous stop() may still be releasing its cross-process lease while
    // its adapters wind down. Wait for that to finish before re-acquiring so a
    // fast stop→start in the same process does not race the lock.
    if (this.pendingRelease) await this.pendingRelease;
    const lease = acquireGatewayInstanceLock(config.runtime.lockPath, "CodeShell Desktop");
    try {
      this.adapterStates.clear();
      const desktop = new DesktopControlClient(config.desktop);
      const abort = new AbortController();
      const adapters = config.channels.map((channel) =>
        createChannelAdapter(channel, { discordCommands: CODE_SHELL_REMOTE_COMMANDS }),
      );
      // Track each adapter's first-turn outcome. superviseAdapter catches
      // adapter.run rejections and restarts with backoff, so gateway.run never
      // rejects; without observing adapter state a crash-looping bad token
      // would show a permanently-green gateway. Record the latest backoff error
      // and whether every adapter has already failed its first turn.
      const adapterFirstError = new Map<string, string>();
      const adapterEverRan = new Set<string>();
      const gateway = new ChatGateway({
        adapters,
        webhook: config.webhook,
        delivery: {
          path: config.runtime.inboxPath,
          maxPending: config.runtime.maxPending,
          maxConcurrent: config.runtime.maxConcurrent,
          maxPerTarget: config.runtime.maxPerTarget,
        },
        adapterRestart: {
          baseMs: config.runtime.adapterRestartBaseMs,
          maxMs: config.runtime.adapterRestartMaxMs,
        },
        onAdapterState: (state) => {
          if (this.active !== active) return;
          const previous = isImGatewayChannel(state.channel)
            ? this.adapterStates.get(state.channel)
            : undefined;
          if (isImGatewayChannel(state.channel)) this.adapterStates.set(state.channel, state);
          // `running` is set optimistically before the adapter connects, so a
          // later transition to `backoff` (a real connect/auth failure) is the
          // meaningful signal. Clear a recorded failure once an adapter reruns.
          if (state.state === "running") {
            adapterEverRan.add(state.id);
            adapterFirstError.delete(state.id);
            if (
              previous?.state === "backoff" &&
              previous.error === this.lastError &&
              adapterFirstError.size === 0
            ) {
              this.lastError = undefined;
            }
          }
          if (state.state === "backoff" && state.error) {
            adapterFirstError.set(state.id, `${state.channel}: ${state.error}`);
            // Surface a live adapter failure so the Link page stops showing a
            // healthy gateway once tokens crash-loop in backoff.
            this.lastError = state.error;
            this.emitStatus();
          }
        },
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
      gateway.use(createRateLimitMiddleware(config.runtime.maxMessagesPerUserPerMinute));
      gateway.use(createImGatewayActivityMiddleware((activity) => this.recordActivity(activity)));
      gateway.use(createCodeShellRemoteCommands({ desktop }));
      gateway.use(createMimiPetChat({ desktop }));

      this.lastError = undefined;
      const active: ActiveGateway = {
        abort,
        task: Promise.resolve(),
        channels: config.channels.map(({ channel }) => channel),
        startedAt: Date.now(),
        lease,
      };
      this.active = active;
      const gatewayTask = gateway.run(abort.signal);
      const notificationTask =
        config.notifications.length > 0
          ? desktop.watchEvents(
              abort.signal,
              createDesktopNotificationHandler(adapters, config.notifications),
              {
                checkpointPath: config.runtime.eventCursorPath,
                onError: (error) => {
                  this.lastError = `Desktop 通知等待重试：${error instanceof Error ? error.message : String(error)}`;
                  this.emitStatus();
                },
                onRecovered: () => {
                  if (!this.lastError?.startsWith("Desktop 通知等待重试：")) return;
                  this.lastError = undefined;
                  this.emitStatus();
                },
              },
            )
          : new Promise<void>((resolveDone) =>
              abort.signal.addEventListener("abort", () => resolveDone(), { once: true }),
            );
      active.task = Promise.all([gatewayTask, notificationTask]).then(() => undefined);
      void active.task.then(
        () => this.onGatewaySettled(active, undefined),
        (error) => this.onGatewaySettled(active, error),
      );

      // Surface adapters that reject during their first turn as a failed start,
      // instead of briefly showing a misleading green state in the Link page.
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 25));
      if (this.active !== active) throw new Error(this.lastError ?? "Chat Gateway 启动后立即退出");
      // superviseAdapter keeps gateway.run alive by restarting failed adapters,
      // so a bad-token start does not settle the task. If every configured
      // adapter has already crash-looped into backoff within the probe window,
      // treat the start as failed rather than reporting a green gateway.
      if (adapters.length > 0 && adapterFirstError.size >= adapters.length) {
        throw new Error([...adapterFirstError.values()].join("; "));
      }
      this.emitStatus();
      return this.status();
    } catch (error) {
      // If we already published this run before failing the fail-fast probe,
      // tear it down: abort the gateway task and clear active so the lease is
      // not released out from under still-running adapters. onGatewaySettled
      // releases the lease once the aborted task settles.
      const active = this.active;
      if (active?.lease === lease) {
        this.active = undefined;
        this.adapterStates.clear();
        active.abort.abort();
        void active.task.catch(() => undefined).then(() => lease.release());
      } else {
        lease.release();
      }
      throw error;
    }
  }

  async stop(): Promise<ImGatewayStatus> {
    const active = this.active;
    if (!active) return this.status();
    this.active = undefined;
    this.adapterStates.clear();
    active.abort.abort();
    // Release the single-instance lease only once the gateway task actually
    // settles — an adapter mid-long-poll may not observe the abort for tens of
    // seconds. Releasing on the 5s UI timeout would free the cross-process lock
    // while adapters still poll, letting a second process double-consume the
    // same account. Defer the release to a task-settled continuation and keep
    // it in `pendingRelease` so a fast restart can wait for the old run to end.
    const release = active.task.catch(() => undefined).then(() => active.lease.release());
    this.pendingRelease = release;
    void release.then(() => {
      if (this.pendingRelease === release) this.pendingRelease = undefined;
    });
    await Promise.race([
      release,
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
    this.adapterStates.clear();
    const stoppedByOwner = active.abort.signal.aborted;
    active.abort.abort();
    active.lease.release();
    if (!stoppedByOwner) {
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

  private recordActivity(activity: ImGatewayActivity): void {
    this.recentActivity.unshift(activity);
    if (this.recentActivity.length > 30) this.recentActivity.length = 30;
    this.emitStatus();
  }

  private emit(event: ImGatewayUiEvent): void {
    this.options.emit?.(event);
  }
}

export function createImGatewayActivityMiddleware(
  record: (activity: ImGatewayActivity) => void,
): ChatMiddleware {
  return async (context, next) => {
    const channel = context.message.channel;
    if (!isImGatewayChannel(channel)) {
      await next();
      return;
    }
    const requestId = randomUUID();
    const message = context.message;
    record({
      id: randomUUID(),
      requestId,
      channel,
      direction: "inbound",
      status: "received",
      target: message.target,
      senderId: message.senderId,
      text: activityPreview(message.text),
      ...(message.attachments?.length ? { attachmentCount: message.attachments.length } : {}),
      createdAt: Date.now(),
    });
    const reply = context.reply;
    context.reply = async (outgoing) => {
      try {
        await reply(outgoing);
        record({
          id: randomUUID(),
          requestId,
          channel,
          direction: "outbound",
          status: "sent",
          target: message.target,
          text: activityPreview(outgoing.text),
          createdAt: Date.now(),
        });
      } catch (error) {
        record({
          id: randomUUID(),
          requestId,
          channel,
          direction: "outbound",
          status: "failed",
          target: message.target,
          text: activityPreview(outgoing.text),
          createdAt: Date.now(),
        });
        throw error;
      }
    };
    await next();
  };
}

function activityPreview(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= 280) return normalized;
  return `${normalized.slice(0, 279)}…`;
}

function isImGatewayChannel(value: string): value is ImGatewayChannel {
  return (IM_GATEWAY_CHANNELS as readonly string[]).includes(value);
}

function readEnabledChannels(configPath: string): Set<ImGatewayChannel> {
  const enabled = new Set<ImGatewayChannel>();
  if (!existsSync(configPath)) return enabled;
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return enabled;
  const record = raw as Record<string, unknown>;
  for (const channel of IM_GATEWAY_CHANNELS) {
    const section = record[channel];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    if ((section as Record<string, unknown>).enabled !== false) enabled.add(channel);
  }
  return enabled;
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
