import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IpcMain } from "electron";
import { CredentialStore, type Credential } from "@cjhyy/code-shell-core";
import {
  acquireGatewayInstanceLock,
  BUILTIN_CHANNEL_CAPABILITIES,
  ChatGateway,
  createAllowlistMiddleware,
  createDesktopNotificationHandler,
  FileNotificationDeliveryProgressStore,
  GatewayAlreadyRunningError,
  notificationDeliveryProgressPath,
  createRateLimitMiddleware,
  type AdapterRuntimeState,
  type ChannelAdapter,
  type ChatAttachmentKind,
  type ChannelCapabilities,
  type ChannelMessage,
  type ChatCommandDefinition,
  type ChatMiddleware,
  type GatewayInstanceLease,
  type OutgoingAttachment,
} from "@cjhyy/code-shell-chat";
import {
  CODE_SHELL_REMOTE_COMMANDS,
  createCodeShellRemoteCommands,
  createMimiPetChat,
  type ConfiguredChannel,
  type DesktopControlEvent,
  defaultGatewayConfigPath,
  DesktopControlClient,
  type DesktopEventContext,
  gatewayConfigTemplate,
  hasWechatStoredContextToken,
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
  capabilities: ChannelCapabilities;
  enabled: boolean;
  state: "disabled" | "needs-config" | "ready" | "starting" | "running" | "retrying";
  attempts?: number;
  error?: string;
  /** Dynamic readiness for context-bound proactive delivery (currently WeChat). */
  proactiveReady?: boolean;
  proactiveReason?: "awaiting-inbound-context";
}

export interface ImGatewayActivity {
  id: string;
  requestId: string;
  channel: ImGatewayChannel;
  direction: "inbound" | "outbound";
  status: "received" | "accepted" | "failed";
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
  adapters: Map<ImGatewayChannel, ChannelAdapter>;
  startedAt: number;
  lease: GatewayInstanceLease;
}

export interface ImGatewayOwnerTarget {
  id: string;
  channel: ImGatewayChannel;
  label: string;
  maxTextLength: number;
  attachments: readonly ChatAttachmentKind[];
  maxAttachments: number;
  maxAttachmentBytes: number;
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
  /** Serializes fresh-adapter sends per channel, including state-file access. */
  private readonly ownerSendTails = new Map<ImGatewayChannel, Promise<void>>();
  /** Set while a stopped gateway's instance lease is still being released. */
  private pendingRelease?: Promise<void>;
  /** One lifecycle owner while adapters and the event watcher are being constructed. */
  private startTask?: Promise<ImGatewayStatus>;
  private startingAdapters = false;
  /** Serializes host delivery ownership and the polling-Gateway start hand-off. */
  private deliveryHandoffTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ImGatewayServiceOptions = {}) {
    this.configPath = resolve(
      options.configPath ?? process.env.CODE_SHELL_IM_GATEWAY_CONFIG ?? defaultGatewayConfigPath(),
    );
  }

  status(): ImGatewayStatus {
    let channels: ImGatewayChannel[] = this.active?.channels ?? [];
    let configError: string | undefined;
    let rawEnabled = new Set<ImGatewayChannel>();
    let configuredDetails: ConfiguredChannel[] = [];
    try {
      rawEnabled = readEnabledChannels(this.configPath);
      configuredDetails = loadDesktopGatewayConfig(
        this.configPath,
        this.options.credentialStore,
      ).channels;
      const configuredChannels = configuredDetails.map(({ channel }) => channel);
      if (!this.active) channels = configuredChannels;
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
    for (const channel of channels) rawEnabled.add(channel);
    const activeChannels = new Set(this.active?.channels ?? []);
    const channelStatuses = IM_GATEWAY_CHANNELS.map((channel): ImGatewayChannelStatus => {
      const enabled = rawEnabled.has(channel);
      const configured = configuredDetails.find((candidate) => candidate.channel === channel);
      const proactiveReady =
        configured?.channel === "wechat"
          ? configured.allowedTargetIds.some((target) =>
              hasRequiredProactiveContext(configured, target),
            )
          : undefined;
      const base = {
        channel,
        capabilities: BUILTIN_CHANNEL_CAPABILITIES[channel],
        ...(proactiveReady !== undefined
          ? {
              proactiveReady,
              ...(!proactiveReady ? { proactiveReason: "awaiting-inbound-context" as const } : {}),
            }
          : {}),
      };
      if (!enabled) return { ...base, enabled: false, state: "disabled" };
      if (configError && !this.active) {
        return { ...base, enabled: true, state: "needs-config", error: configError };
      }
      if (!this.active) return { ...base, enabled: true, state: "ready" };
      if (!activeChannels.has(channel)) {
        return configError
          ? { ...base, enabled: true, state: "needs-config", error: configError }
          : { ...base, enabled: true, state: "ready" };
      }
      const runtime = this.adapterStates.get(channel);
      if (!runtime) return { ...base, enabled: true, state: "starting" };
      if (runtime.state === "backoff") {
        return {
          ...base,
          enabled: true,
          state: "retrying",
          attempts: runtime.attempts,
          ...(runtime.error ? { error: runtime.error } : {}),
        };
      }
      return {
        ...base,
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

  /**
   * Start the configured gateway during Desktop boot. A fresh/disabled or
   * incomplete config is intentionally a no-op so first launch and broken
   * credentials never block the main window from opening.
   */
  async startConfiguredAtLaunch(): Promise<ImGatewayStatus> {
    const current = this.status();
    if (current.running || current.channels.length === 0) return current;
    return await this.start();
  }

  async start(): Promise<ImGatewayStatus> {
    if (this.active) return this.status();
    if (this.startTask) return await this.startTask;
    const task = this.startInOrder();
    this.startTask = task;
    try {
      return await task;
    } finally {
      if (this.startTask === task) this.startTask = undefined;
      this.startingAdapters = false;
    }
  }

  private async startInOrder(): Promise<ImGatewayStatus> {
    // A notification published while stopped owns fresh adapters until it
    // settles. Starting the polling Gateway afterwards would otherwise race
    // the same channel state and could consume the retained event twice.
    await this.deliveryHandoffTail;
    if (this.active) return this.status();
    this.startingAdapters = true;
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
      gateway.use(createMimiPetChat({ desktop, channels: adapters }));

      this.lastError = undefined;
      const active: ActiveGateway = {
        abort,
        task: Promise.resolve(),
        channels: config.channels.map(({ channel }) => channel),
        adapters: new Map(
          adapters
            .filter((adapter): adapter is ChannelAdapter & { channel: ImGatewayChannel } =>
              isImGatewayChannel(adapter.channel),
            )
            .map((adapter) => [adapter.channel, adapter]),
        ),
        startedAt: Date.now(),
        lease,
      };
      this.active = active;
      const gatewayTask = gateway.run(abort.signal);
      // Keep the event stream active even when general broadcasts are disabled:
      // a targeted Mimi completion must return to its exact originating chat.
      const notificationTask = desktop.watchEvents(
        abort.signal,
        createDesktopNotificationHandler(adapters, config.notifications, {
          progressStore: new FileNotificationDeliveryProgressStore(
            notificationDeliveryProgressPath(config.runtime.eventCursorPath),
          ),
          authorizeTarget: (target) => this.isNotificationTargetAuthorized(target),
        }),
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

  /**
   * Opaque, allowlisted owner destinations exposed to Mimi. Raw platform ids
   * never cross into the model; sendOwnerMessage resolves the same id again
   * against the current config before every side effect.
   */
  listOwnerMessageTargets(): ImGatewayOwnerTarget[] {
    if (!existsSync(this.configPath)) return [];
    let config: ReturnType<typeof loadDesktopGatewayConfig>;
    try {
      config = loadDesktopGatewayConfig(this.configPath, this.options.credentialStore);
    } catch {
      return [];
    }
    return config.channels.flatMap((channel) => {
      const capabilities = BUILTIN_CHANNEL_CAPABILITIES[channel.channel];
      if (!capabilities.outbound.proactive) return [];
      // A running adapter remains the default. HTTP/fresh-adapter channels that
      // explicitly expose direct delivery may also be used by Mimi and other
      // host-side one-shot callers while the polling Gateway is stopped.
      if (!this.active?.adapters.has(channel.channel) && !capabilities.outbound.direct) return [];
      const maxTextLength = Math.min(capabilities.outbound.maxTextLength ?? 8_000, 8_000);
      return channel.allowedTargetIds.flatMap((target, index) =>
        hasRequiredProactiveContext(channel, target)
          ? [
              {
                id: ownerTargetId(channel.channel, target),
                channel: channel.channel,
                label: `${channelDisplayName(channel.channel)}${channel.allowedTargetIds.length > 1 ? ` ${index + 1}` : ""}`,
                maxTextLength,
                attachments: capabilities.outbound.attachments,
                maxAttachments: capabilities.outbound.maxAttachments ?? 0,
                maxAttachmentBytes: capabilities.outbound.maxAttachmentBytes ?? 0,
              },
            ]
          : [],
      );
    });
  }

  private isNotificationTargetAuthorized(target: { channel: string; target: string }): boolean {
    const current = loadDesktopGatewayConfig(this.configPath, this.options.credentialStore);
    return current.channels.some(
      (channel) =>
        channel.channel === target.channel && channel.allowedTargetIds.includes(target.target),
    );
  }

  async sendOwnerMessage(
    targetId: string,
    text: string,
    attachments: readonly OutgoingAttachment[] = [],
  ): Promise<ImGatewayOwnerTarget> {
    const selected = this.listOwnerMessageTargets().find((target) => target.id === targetId);
    if (!selected) throw new Error("消息目标未授权、已移除或 Gateway 尚未运行");
    return this.enqueueDeliveryHandoff(() =>
      this.withOwnerSendLock(selected.channel, () =>
        this.sendOwnerMessageInOrder(targetId, text, attachments),
      ),
    );
  }

  /**
   * Deliver a Desktop notification with fresh direct-capable adapters while
   * the polling Gateway is stopped. The caller may acknowledge a fully handled
   * head event immediately; otherwise shared per-event progress lets a later
   * Gateway watcher resume without repeating chunks already accepted here.
   */
  deliverPublishedNotification(
    event: DesktopControlEvent,
    context: DesktopEventContext,
  ): Promise<boolean> {
    return this.enqueueDeliveryHandoff(() =>
      this.deliverPublishedNotificationInOrder(event, context),
    );
  }

  private async deliverPublishedNotificationInOrder(
    event: DesktopControlEvent,
    context: DesktopEventContext,
  ): Promise<boolean> {
    // The live watcher is the sole owner while active. It uses the same relay
    // and progress store, so this boundary is channel-neutral.
    if (this.active || this.startingAdapters) return false;
    if (!existsSync(this.configPath)) return false;
    const config = loadDesktopGatewayConfig(this.configPath, this.options.credentialStore);
    const requestedTargets = event.target ? [event.target] : config.notifications;
    let authorizedRequestedTargets = 0;
    const directTargets = requestedTargets.flatMap(({ channel, target }) => {
      if (!isImGatewayChannel(channel)) {
        if (event.target) throw new Error("Desktop 通知目标渠道未授权");
        return [];
      }
      const configured = config.channels.find((candidate) => candidate.channel === channel);
      if (!configured?.allowedTargetIds.includes(target)) {
        if (event.target) throw new Error("Desktop 通知目标已移除或未授权");
        return [];
      }
      // Revocation above is an owner decision; every target from here on is
      // authorized and still owed a delivery even when this one-shot path
      // cannot reach it (channel not direct-capable, WeChat context missing).
      authorizedRequestedTargets += 1;
      if (!BUILTIN_CHANNEL_CAPABILITIES[channel].outbound.direct) return [];
      if (!hasRequiredProactiveContext(configured, target)) return [];
      return [{ channel, target, configured }];
    });
    if (directTargets.length === 0) return false;
    // Only full coverage may be reported as "fully handled" — the caller acks
    // and permanently drops the durable event on true. A partial send still
    // runs (the shared progress store keeps a resumed Gateway watcher from
    // repeating these targets), but the event must stay in the outbox for the
    // remaining authorized targets.
    const coversAllAuthorizedTargets = directTargets.length === authorizedRequestedTargets;

    const channels = [...new Set(directTargets.map(({ channel }) => channel))].sort();
    return this.withOwnerSendLocks(channels, async () => {
      if (this.active || this.startingAdapters) return false;
      if (this.pendingRelease) await this.pendingRelease;
      if (this.active || this.startingAdapters) return false;
      let lease: GatewayInstanceLease;
      try {
        lease = acquireGatewayInstanceLock(
          config.runtime.lockPath,
          "CodeShell Desktop direct notification",
        );
      } catch (error) {
        // A separate CLI Gateway owns the retained event and will consume it.
        // Never open a competing short-lived channel session in this process.
        if (error instanceof GatewayAlreadyRunningError) return false;
        throw error;
      }
      try {
        const createChannelAdapter =
          this.options.createChannelAdapter ??
          (await import("@cjhyy/code-shell-chat/factory")).createChannelAdapterAsync;
        const adapters = await Promise.all(
          channels.map(async (channel) => {
            const configured = directTargets.find(
              (target) => target.channel === channel,
            )?.configured;
            if (!configured) throw new Error(`Desktop 通知渠道配置已失效：${channel}`);
            return await createChannelAdapter(configured, {
              discordCommands: CODE_SHELL_REMOTE_COMMANDS,
            });
          }),
        );
        const handler = createDesktopNotificationHandler(
          adapters,
          event.target ? [] : directTargets.map(({ channel, target }) => ({ channel, target })),
          {
            progressStore: new FileNotificationDeliveryProgressStore(
              notificationDeliveryProgressPath(config.runtime.eventCursorPath),
            ),
            authorizeTarget: (target) => this.isNotificationTargetAuthorized(target),
          },
        );
        await handler(event, context);
        return coversAllAuthorizedTargets;
      } finally {
        lease.release();
      }
    });
  }

  private enqueueDeliveryHandoff<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.deliveryHandoffTail;
    const current = previous.catch(() => undefined).then(operation);
    this.deliveryHandoffTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async sendOwnerMessageInOrder(
    targetId: string,
    text: string,
    attachments: readonly OutgoingAttachment[],
  ): Promise<ImGatewayOwnerTarget> {
    // If Gateway construction claimed delivery first, wait and use its live
    // adapter. When this send claimed first, startInOrder waits on the hand-off
    // tail and startingAdapters remains false, so there is no circular wait.
    if (this.startingAdapters && this.startTask) await this.startTask;
    const normalized = text.trim();
    const targets = this.listOwnerMessageTargets();
    const selected = targets.find((target) => target.id === targetId);
    if (!selected) throw new Error("消息目标未授权、已移除或 Gateway 尚未运行");
    if (!normalized || normalized.length > selected.maxTextLength) {
      throw new Error(`消息长度必须在 1 到 ${selected.maxTextLength} 个字符之间`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
      throw new Error("消息不能包含控制字符");
    }
    if (
      attachments.length > selected.maxAttachments ||
      attachments.some(
        (attachment) =>
          !selected.attachments.includes(attachment.kind) ||
          typeof attachment.name !== "string" ||
          !attachment.name.trim() ||
          attachment.name.length > 255 ||
          /[\\/\u0000-\u001f\u007f]/u.test(attachment.name) ||
          typeof attachment.mimeType !== "string" ||
          !attachment.mimeType.trim() ||
          attachment.mimeType.length > 255 ||
          /[\u0000-\u001f\u007f]/u.test(attachment.mimeType) ||
          (attachment.kind === "image"
            ? !attachment.mimeType.startsWith("image/")
            : attachment.kind === "audio"
              ? !attachment.mimeType.startsWith("audio/")
              : attachment.kind === "video"
                ? !attachment.mimeType.startsWith("video/")
                : false) ||
          !(attachment.data instanceof Uint8Array) ||
          attachment.data.byteLength < 1 ||
          attachment.data.byteLength > selected.maxAttachmentBytes,
      )
    ) {
      throw new Error("附件类型、数量或大小超出目标渠道能力");
    }
    const config = loadDesktopGatewayConfig(this.configPath, this.options.credentialStore);
    const channel = config.channels.find((candidate) => candidate.channel === selected.channel);
    const rawTarget = channel?.allowedTargetIds.find(
      (candidate) => ownerTargetId(selected.channel, candidate) === selected.id,
    );
    let adapter = this.active?.adapters.get(selected.channel);
    let directLease: GatewayInstanceLease | undefined;
    if (!channel || !rawTarget) {
      throw new Error("消息目标在发送前失效，请检查 Gateway 配置");
    }
    if (!adapter) {
      // Do not overlap a one-shot adapter with the previous polling adapter's
      // final state write. This matters for WeChat's persisted context cache.
      if (this.pendingRelease) await this.pendingRelease;
      adapter = this.active?.adapters.get(selected.channel);
    }
    if (!adapter) {
      const capabilities = BUILTIN_CHANNEL_CAPABILITIES[selected.channel];
      if (!capabilities.outbound.direct) {
        throw new Error("当前渠道需要 Gateway 正在运行才能发送");
      }
      const createChannelAdapter =
        this.options.createChannelAdapter ??
        (await import("@cjhyy/code-shell-chat/factory")).createChannelAdapterAsync;
      directLease = acquireGatewayInstanceLock(
        config.runtime.lockPath,
        "CodeShell Desktop direct send",
      );
      try {
        adapter = await createChannelAdapter(channel, {
          discordCommands: CODE_SHELL_REMOTE_COMMANDS,
        });
      } catch (error) {
        directLease.release();
        throw error;
      }
    }
    const requestId = randomUUID();
    try {
      await adapter.send(rawTarget, {
        text: normalized,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      this.recordActivity({
        id: randomUUID(),
        requestId,
        channel: selected.channel,
        direction: "outbound",
        status: "accepted",
        target: rawTarget,
        text: activityPreview(normalized),
        ...(attachments.length > 0 ? { attachmentCount: attachments.length } : {}),
        createdAt: Date.now(),
      });
      return selected;
    } catch (error) {
      this.recordActivity({
        id: randomUUID(),
        requestId,
        channel: selected.channel,
        direction: "outbound",
        status: "failed",
        target: rawTarget,
        text: activityPreview(normalized),
        ...(attachments.length > 0 ? { attachmentCount: attachments.length } : {}),
        createdAt: Date.now(),
      });
      throw error;
    } finally {
      directLease?.release();
    }
  }

  private async withOwnerSendLock<T>(
    channel: ImGatewayChannel,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerSendTails.get(channel) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.ownerSendTails.set(channel, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.ownerSendTails.get(channel) === tail) this.ownerSendTails.delete(channel);
    }
  }

  private async withOwnerSendLocks<T>(
    channels: readonly ImGatewayChannel[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const [channel, ...remaining] = channels;
    if (!channel) return await operation();
    return await this.withOwnerSendLock(channel, () =>
      this.withOwnerSendLocks(remaining, operation),
    );
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
    await this.deliveryHandoffTail;
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
          status: "accepted",
          target: message.target,
          text: activityPreview(outgoing.text),
          ...(outgoing.attachments?.length ? { attachmentCount: outgoing.attachments.length } : {}),
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
          ...(outgoing.attachments?.length ? { attachmentCount: outgoing.attachments.length } : {}),
          createdAt: Date.now(),
        });
        throw error;
      }
    };
    await next();
  };
}

function ownerTargetId(channel: ImGatewayChannel, target: string): string {
  return `owner-${createHash("sha256")
    .update(channel)
    .update("\0")
    .update(target)
    .digest("hex")
    .slice(0, 24)}`;
}

function hasRequiredProactiveContext(channel: ConfiguredChannel, target: string): boolean {
  if (channel.channel !== "wechat") return true;
  return hasWechatStoredContextToken(channel.statePath, target);
}

function channelDisplayName(channel: ImGatewayChannel): string {
  const labels: Record<ImGatewayChannel, string> = {
    telegram: "Telegram",
    discord: "Discord",
    slack: "Slack",
    lark: "飞书",
    dingtalk: "钉钉",
    wecom: "企业微信",
    wechat: "微信",
    matrix: "Matrix",
    mattermost: "Mattermost",
    line: "LINE",
    whatsapp: "WhatsApp",
    teams: "Teams",
  };
  return labels[channel];
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
