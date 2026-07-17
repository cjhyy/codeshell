import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IpcMain } from "electron";
import { CredentialStore, type Credential } from "@cjhyy/code-shell-core";
import {
  acquireGatewayInstanceLock,
  ChatGateway,
  createAllowlistMiddleware,
  createDesktopNotificationHandler,
  createRateLimitMiddleware,
  type AdapterRuntimeState,
  type ChannelAdapter,
  type ChannelMessage,
  type ChatCommandDefinition,
  type ChatMiddleware,
  type GatewayInstanceLease,
} from "@cjhyy/code-shell-chat";
import {
  CODE_SHELL_REMOTE_COMMANDS,
  createCodeShellRemoteCommands,
  createMimiPetChat,
  type ConfiguredChannel,
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

export interface DingTalkSetup {
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  secretStorage: "missing" | "environment" | "secure" | "legacy-config";
  allowedConversationIds: string[];
  allowedUserIds: string[];
}

export interface DingTalkSetupInput {
  enabled: boolean;
  clientId: string;
  clientSecret?: string;
  allowedConversationIds: string[];
  allowedUserIds: string[];
}

export interface DingTalkDiscoveredUser {
  id: string;
  name?: string;
}

export interface DingTalkDiscoveredConversation {
  conversationId: string;
  title?: string;
  conversationType?: string;
  users: DingTalkDiscoveredUser[];
  lastMessagePreview: string;
  discoveredAt: number;
}

export type DingTalkDiscoveryState = "connecting" | "listening" | "stopped" | "error";

export type ImGatewayUiEvent =
  | { type: "status-changed"; status: ImGatewayStatus }
  | { type: "wechat-qr"; loginId: string; url: string }
  | { type: "wechat-status"; loginId: string; status: string }
  | { type: "wechat-verification-required"; loginId: string }
  | {
      type: "dingtalk-discovery-state";
      discoveryId: string;
      state: DingTalkDiscoveryState;
      error?: string;
    }
  | {
      type: "dingtalk-conversation-discovered";
      discoveryId: string;
      conversation: DingTalkDiscoveredConversation;
    };

interface ImGatewayCredentialStore {
  resolve(id: string, scope?: "full" | "project"): Credential | undefined;
  save(scope: "user" | "project", credential: Credential): void;
}

export interface ImGatewayServiceOptions {
  configPath?: string;
  emit?: (event: ImGatewayUiEvent) => void;
  credentialStore?: ImGatewayCredentialStore;
  createDingTalkAdapter?: (config: {
    clientId: string;
    clientSecret: string;
    onConnected?: () => void;
  }) => ChannelAdapter | Promise<ChannelAdapter>;
  createChannelAdapter?: (
    config: ConfiguredChannel,
    options?: { discordCommands?: readonly ChatCommandDefinition[] },
  ) => ChannelAdapter | Promise<ChannelAdapter>;
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

interface ActiveDingTalkDiscovery {
  id: string;
  abort: AbortController;
  task: Promise<void>;
  conversations: Map<string, DingTalkDiscoveredConversation>;
}

const DINGTALK_CREDENTIAL_ID = "im-gateway-dingtalk";

function resolveCredentialStore(
  credentialStore?: ImGatewayCredentialStore,
): ImGatewayCredentialStore {
  return credentialStore ?? new CredentialStore();
}

function readDingTalkCredentialSecret(
  credentialStore?: ImGatewayCredentialStore,
): string | undefined {
  const credential = resolveCredentialStore(credentialStore).resolve(DINGTALK_CREDENTIAL_ID);
  if (!credential?.secret) return undefined;
  try {
    const parsed = JSON.parse(credential.secret) as { clientSecret?: unknown };
    return typeof parsed.clientSecret === "string" && parsed.clientSecret.trim()
      ? parsed.clientSecret.trim()
      : undefined;
  } catch {
    if (credential.secret.startsWith("enc:")) return undefined;
    return credential.secret.trim() || undefined;
  }
}

function resolveDingTalkClientSecret(
  configPath: string,
  credentialStore?: ImGatewayCredentialStore,
): string | undefined {
  const environmentSecret = process.env.CODE_SHELL_DINGTALK_CLIENT_SECRET?.trim();
  if (environmentSecret) return environmentSecret;
  const secureSecret = readDingTalkCredentialSecret(credentialStore);
  if (secureSecret) return secureSecret;
  const raw = readGatewayConfigRecord(configPath);
  return readOptionalString(readRecord(raw.dingtalk).clientSecret);
}

function loadDesktopGatewayConfig(configPath: string, credentialStore?: ImGatewayCredentialStore) {
  const clientSecret = resolveDingTalkClientSecret(configPath, credentialStore);
  const env =
    clientSecret && !process.env.CODE_SHELL_DINGTALK_CLIENT_SECRET
      ? { ...process.env, CODE_SHELL_DINGTALK_CLIENT_SECRET: clientSecret }
      : process.env;
  return loadGatewayConfig({ configPath, env });
}

function saveDingTalkCredential(
  credentialStore: ImGatewayCredentialStore | undefined,
  clientId: string,
  clientSecret: string,
): void {
  resolveCredentialStore(credentialStore).save("user", {
    id: DINGTALK_CREDENTIAL_ID,
    type: "link",
    label: "DingTalk Chat Gateway",
    secret: JSON.stringify({ version: 1, clientSecret }),
    meta: { platform: "dingtalk", clientId },
  });
}

/** Desktop-owned lifecycle for the reusable chat package. */
export class ImGatewayService {
  readonly configPath: string;
  private active?: ActiveGateway;
  private lastError?: string;
  private login?: { id: string; abort: AbortController };
  private verification?: PendingVerification;
  private dingtalkDiscovery?: ActiveDingTalkDiscovery;
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
      const configuredChannels = loadDesktopGatewayConfig(
        this.configPath,
        this.options.credentialStore,
      ).channels.map(({ channel }) => channel);
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
    await this.stopDingTalkDiscovery();
    // Load only the selected platform modules when starting the gateway so
    // status/config operations stay lightweight and mixed test processes do
    // not evaluate unrelated SDK globals.
    const createChannelAdapter =
      this.options.createChannelAdapter ??
      (await import("@cjhyy/code-shell-chat/factory")).createChannelAdapterAsync;
    const config = loadDesktopGatewayConfig(this.configPath, this.options.credentialStore);
    // A previous stop() may still be releasing its cross-process lease while
    // its adapters wind down. Wait for that to finish before re-acquiring so a
    // fast stop→start in the same process does not race the lock.
    if (this.pendingRelease) await this.pendingRelease;
    const lease = acquireGatewayInstanceLock(config.runtime.lockPath, "CodeShell Desktop");
    try {
      this.adapterStates.clear();
      const desktop = new DesktopControlClient(config.desktop);
      const abort = new AbortController();
      const adapters = await Promise.all(
        config.channels.map((channel) =>
          createChannelAdapter(channel, { discordCommands: CODE_SHELL_REMOTE_COMMANDS }),
        ),
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

  getDingTalkSetup(): DingTalkSetup {
    const raw = readGatewayConfigRecord(this.configPath);
    const section = readRecord(raw.dingtalk);
    const environmentSecret = process.env.CODE_SHELL_DINGTALK_CLIENT_SECRET?.trim();
    const secureSecret = readDingTalkCredentialSecret(this.options.credentialStore);
    const legacySecret = readOptionalString(section.clientSecret);
    const secretStorage: DingTalkSetup["secretStorage"] = environmentSecret
      ? "environment"
      : secureSecret
        ? "secure"
        : legacySecret
          ? "legacy-config"
          : "missing";
    return {
      enabled: section.enabled !== false && Boolean(raw.dingtalk),
      clientId:
        process.env.CODE_SHELL_DINGTALK_CLIENT_ID?.trim() ??
        readOptionalString(section.clientId) ??
        "",
      hasClientSecret: secretStorage !== "missing",
      secretStorage,
      allowedConversationIds: readUniqueStringList(section.allowedConversationIds),
      allowedUserIds: readUniqueStringList(section.allowedUserIds),
    };
  }

  saveDingTalkSetup(input: DingTalkSetupInput): DingTalkSetup {
    const enabled = Boolean(input.enabled);
    const clientId = input.clientId.trim();
    const incomingSecret = input.clientSecret?.trim();
    const allowedConversationIds = uniqueTrimmedStrings(input.allowedConversationIds);
    const allowedUserIds = uniqueTrimmedStrings(input.allowedUserIds);
    const raw = readGatewayConfigRecord(this.ensureConfig());
    const previous = readRecord(raw.dingtalk);
    const legacySecret = readOptionalString(previous.clientSecret);
    const secureSecret = readDingTalkCredentialSecret(this.options.credentialStore);
    const effectiveSecret =
      process.env.CODE_SHELL_DINGTALK_CLIENT_SECRET?.trim() ||
      incomingSecret ||
      secureSecret ||
      legacySecret;

    if (enabled && !clientId) throw new Error("钉钉 Client ID 不能为空");
    if (enabled && !effectiveSecret) throw new Error("钉钉 Client Secret 不能为空");
    if (enabled && allowedConversationIds.length === 0) {
      throw new Error("请先发现或填写至少一个钉钉会话");
    }

    // A legacy config Secret may have been edited after a secure credential was
    // created. Treat the visible config value as an explicit update before
    // scrubbing it so the form never silently restores an older vault value.
    const secretToStore = incomingSecret || legacySecret;
    if (secretToStore) {
      saveDingTalkCredential(this.options.credentialStore, clientId, secretToStore);
    }

    const nextSection: Record<string, unknown> = {
      ...previous,
      enabled,
      clientId,
      allowedConversationIds,
      allowedUserIds,
    };
    delete nextSection.clientSecret;
    raw.dingtalk = nextSection;
    writeGatewayConfigRecord(this.configPath, raw);
    this.lastError = undefined;
    this.emitStatus();
    return this.getDingTalkSetup();
  }

  async startDingTalkDiscovery(): Promise<{ discoveryId: string }> {
    if (this.dingtalkDiscovery) return { discoveryId: this.dingtalkDiscovery.id };
    if (this.active?.channels.includes("dingtalk")) {
      throw new Error("请先停止正在运行的钉钉渠道，再开始发现会话");
    }
    const setup = this.getDingTalkSetup();
    const clientSecret = resolveDingTalkClientSecret(this.configPath, this.options.credentialStore);
    if (!setup.clientId) throw new Error("请先填写钉钉 Client ID");
    if (!clientSecret) throw new Error("请先填写钉钉 Client Secret");

    const active: ActiveDingTalkDiscovery = {
      id: randomUUID(),
      abort: new AbortController(),
      task: Promise.resolve(),
      conversations: new Map(),
    };
    // Claim the slot BEFORE the first await: two rapid IPC calls must not both
    // pass the guard above and spawn two Stream connections (the loser's
    // AbortController would never fire — leaked connection).
    this.dingtalkDiscovery = active;
    let markConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolveConnected) => {
      markConnected = resolveConnected;
    });
    const adapterConfig = {
      clientId: setup.clientId,
      clientSecret,
      onConnected: markConnected,
    };
    let adapter: Awaited<ReturnType<NonNullable<typeof this.options.createDingTalkAdapter>>>;
    try {
      adapter = this.options.createDingTalkAdapter
        ? await this.options.createDingTalkAdapter(adapterConfig)
        : new (await import("@cjhyy/code-shell-chat/dingtalk")).DingTalkAdapter(adapterConfig);
    } catch (error) {
      if (this.dingtalkDiscovery === active) this.dingtalkDiscovery = undefined;
      throw error;
    }
    this.emit({
      type: "dingtalk-discovery-state",
      discoveryId: active.id,
      state: "connecting",
    });
    active.task = adapter.run(
      async (message) => this.captureDingTalkDiscovery(active, message),
      active.abort.signal,
    );

    let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connected,
        active.task.then(
          () => Promise.reject(new Error("钉钉发现连接意外结束")),
          (error) => Promise.reject(error),
        ),
        new Promise<void>((_resolveWait, rejectWait) => {
          connectionTimeout = setTimeout(
            () => rejectWait(new Error("钉钉 Stream 连接超时")),
            15_000,
          );
        }),
      ]);
    } catch (error) {
      if (this.dingtalkDiscovery === active) this.dingtalkDiscovery = undefined;
      active.abort.abort();
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "dingtalk-discovery-state",
        discoveryId: active.id,
        state: "error",
        error: message,
      });
      throw error;
    } finally {
      if (connectionTimeout) clearTimeout(connectionTimeout);
    }

    if (this.dingtalkDiscovery !== active) throw new Error("钉钉发现连接已取消");
    this.emit({
      type: "dingtalk-discovery-state",
      discoveryId: active.id,
      state: "listening",
    });
    void active.task.then(
      () => this.onDingTalkDiscoverySettled(active, undefined),
      (error) => this.onDingTalkDiscoverySettled(active, error),
    );
    return { discoveryId: active.id };
  }

  async stopDingTalkDiscovery(): Promise<boolean> {
    const active = this.dingtalkDiscovery;
    if (!active) return false;
    this.dingtalkDiscovery = undefined;
    active.abort.abort();
    await Promise.race([
      active.task.catch(() => undefined),
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    this.emit({
      type: "dingtalk-discovery-state",
      discoveryId: active.id,
      state: "stopped",
    });
    return true;
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
    await this.stopDingTalkDiscovery();
    await this.stop();
  }

  private captureDingTalkDiscovery(active: ActiveDingTalkDiscovery, message: ChannelMessage): void {
    if (this.dingtalkDiscovery !== active) return;
    const existing = active.conversations.get(message.target);
    const users = new Map((existing?.users ?? []).map((user) => [user.id, user]));
    const senderName = readOptionalString(message.metadata?.senderName);
    users.set(message.senderId, {
      id: message.senderId,
      ...(senderName ? { name: senderName } : {}),
    });
    const conversation: DingTalkDiscoveredConversation = {
      conversationId: message.target,
      title: readOptionalString(message.metadata?.conversationTitle) ?? existing?.title,
      conversationType:
        readOptionalString(message.metadata?.conversationType) ?? existing?.conversationType,
      users: [...users.values()],
      lastMessagePreview: activityPreview(message.text),
      discoveredAt: Date.now(),
    };
    active.conversations.set(message.target, conversation);
    this.emit({
      type: "dingtalk-conversation-discovered",
      discoveryId: active.id,
      conversation,
    });
  }

  private onDingTalkDiscoverySettled(active: ActiveDingTalkDiscovery, error: unknown): void {
    if (this.dingtalkDiscovery !== active || active.abort.signal.aborted) return;
    this.dingtalkDiscovery = undefined;
    this.emit({
      type: "dingtalk-discovery-state",
      discoveryId: active.id,
      state: "error",
      error: error
        ? error instanceof Error
          ? error.message
          : String(error)
        : "钉钉发现连接意外结束",
    });
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

function readGatewayConfigRecord(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("IM gateway 配置必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function writeGatewayConfigRecord(configPath: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, configPath);
  if (process.platform !== "win32") chmodSync(configPath, 0o600);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readUniqueStringList(value: unknown): string[] {
  return Array.isArray(value) ? uniqueTrimmedStrings(value) : [];
}

function uniqueTrimmedStrings(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : [])),
    ),
  ];
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
  ipcMain.handle("im-gateway:dingtalkGetSetup", () => service.getDingTalkSetup());
  ipcMain.handle("im-gateway:dingtalkSaveSetup", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("缺少钉钉配置参数");
    }
    const input = raw as Record<string, unknown>;
    if (typeof input.enabled !== "boolean" || typeof input.clientId !== "string") {
      throw new Error("钉钉配置参数无效");
    }
    if (input.clientSecret !== undefined && typeof input.clientSecret !== "string") {
      throw new Error("钉钉 Client Secret 参数无效");
    }
    if (!Array.isArray(input.allowedConversationIds) || !Array.isArray(input.allowedUserIds)) {
      throw new Error("钉钉白名单参数无效");
    }
    return service.saveDingTalkSetup({
      enabled: input.enabled,
      clientId: input.clientId,
      ...(typeof input.clientSecret === "string" ? { clientSecret: input.clientSecret } : {}),
      allowedConversationIds: uniqueTrimmedStrings(input.allowedConversationIds),
      allowedUserIds: uniqueTrimmedStrings(input.allowedUserIds),
    });
  });
  ipcMain.handle("im-gateway:dingtalkStartDiscovery", () => service.startDingTalkDiscovery());
  ipcMain.handle("im-gateway:dingtalkStopDiscovery", () => service.stopDingTalkDiscovery());
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
