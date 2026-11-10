import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  PET_PENDING_NOTICE_BODY_MAX,
  PET_PENDING_NOTICE_TITLE_MAX,
  PET_PENDING_NOTICES_MAX,
  type ConversationSessionRoute,
  type PetLongTask,
} from "@cjhyy/code-shell-pet";
import {
  PET_RULE_UPSERT_ACTION,
  parseNoticeRuleUpsert,
  type BoundChannel,
  type NoticeChannel,
  type NoticeRuleUpsertReply,
  type RuleEffect,
} from "@cjhyy/code-shell-pet/protocol";
import { SettingsSchema } from "@cjhyy/code-shell-core";
import { dlog } from "../desktop-logger.js";
import type { DesktopNotificationInput } from "../desktop-notifier.js";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { OutgoingAttachment } from "@cjhyy/code-shell-chat";
import type { PetNotificationSettingsView } from "../../shared/pet-notices.js";
import type {
  ImGatewayOwnerChannel,
  ImGatewayOwnerSendOptions,
  ImGatewayOwnerTarget,
} from "../im-gateway-service.js";
import type { PetPendingNoticeSource } from "./pet-dispatch-service.js";
import { createPetDeliveryResolver, type PetDeliveryResolver } from "./pet-delivery-plan.js";
import type { ImDecisionDeliveryResolver } from "./pet-im-decisions.js";
import type { PetIpcAttention } from "./pet-ipc.js";
import { PetNoticeLedger } from "./pet-notice-ledger.js";
import { PetNoticeMediaStore } from "./pet-notice-media.js";
import {
  DEFAULT_MAX_P0_PER_HOUR,
  DEFAULT_MAX_PER_HOUR,
  type ImReadiness,
} from "./pet-notice-policy.js";
import {
  PetNoticeRouter,
  type NoticeImPayload,
  type NoticeImSendResult,
  type NoticeMedia,
  type NoticeMediaAttachment,
  type NoticeRouterSettings,
  type NoticeSubmission,
  type NoticeTarget,
  type PetAttentionOptions,
} from "./pet-notice-router.js";
import { parseNoticeMedia } from "./pet-notice-types.js";
import { createPresenceDetector, DEFAULT_PRESENCE_IDLE_SEC } from "./pet-presence.js";
import { PetReceiptStore } from "./pet-receipt-store.js";
import { PetRuleStore, type NoticeRule } from "./pet-rule-store.js";
import { PetSessionRuleWatcher, type NoticeDraft } from "./pet-session-rule-watcher.js";
import type { SessionOutcome } from "./session-outcome.js";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";

/** Notification preferences read from `settings.pet.notifications` (all optional). */
export interface PetNotificationSettings extends Required<NoticeRouterSettings> {
  presenceIdleSec: number;
  /** Where a desktop-started delegation's result goes when no rule names a channel. */
  delegatedFromDesktop: "auto" | "desktop";
}

export const DEFAULT_QUIET_HOURS = { start: "23:00", end: "08:30" } as const;
const DEFAULT_MERGE_WINDOW_SEC = 600;
const SETTINGS_TTL_MS = 5_000;
const MAX_VIEWED_SESSIONS = 500;
const MAX_TITLE = 200;
const MAX_SUMMARY = 2_000;
const MAX_ERROR = 500;
/** Owner channel / target lookups read the gateway config from disk; a burst shares one read. */
const OWNER_LOOKUP_TTL_MS = 1_000;

/** `read()`'s result for a short while (wall time), so a burst of notices reads it once. */
function shortLived<T>(read: () => T, ttlMs = OWNER_LOOKUP_TTL_MS): () => T {
  let entry: { at: number; value: T } | undefined;
  return () => {
    const at = performance.now();
    if (entry && at - entry.at < ttlMs) return entry.value;
    const value = read();
    entry = { at, value };
    return value;
  };
}

export interface PetNoticeWiringGateway {
  ownerChannels(): ImGatewayOwnerChannel[];
  /** Owner targets with their outbound attachment capabilities. */
  listOwnerMessageTargets(): ImGatewayOwnerTarget[];
  sendOwnerMessage(
    targetId: string,
    text: string,
    attachments: readonly OutgoingAttachment[],
    options?: ImGatewayOwnerSendOptions,
  ): Promise<unknown>;
  supportsIdempotentOwnerSend(channel: string): boolean;
  lastOwnerInboundChannel(): string | undefined;
  /** An allowlisted owner conversation on this channel (callers also require a direct message). */
  isOwnerConversation(channel: string, target: string): boolean;
}

/** The `powerMonitor` events the digest listens to (overloads keep Electron's type assignable). */
export interface PetNoticePowerEvents {
  on(event: "resume", listener: () => void): unknown;
  on(event: "unlock-screen", listener: () => void): unknown;
  removeListener(event: "resume", listener: () => void): unknown;
  removeListener(event: "unlock-screen", listener: () => void): unknown;
}

export interface PetNoticeWiringDeps {
  /** Electron `app.getPath("userData")`; stores live under `<userData>/pet/`. */
  userDataDir: string;
  bridge: { setHostActionHandler(action: string, handler: HostActionHandler): () => void };
  /** The pet projection (PetStateAggregator): attention source and Session facts. */
  projection: PetAttentionOptions["source"];
  longTasks: {
    activeForSession(sessionId: string): PetLongTask | undefined;
    getSnapshot(): { tasks: readonly PetLongTask[] };
  };
  /**
   * IM conversations that receive a Session's turn replies; resolved lazily
   * (built after this wiring). A done / failed notice for a conversation the
   * reply already reaches is recorded on the desktop and never sent to IM.
   */
  sessionRoutes: () =>
    | { notifyRoutesForSession(sessionId: string): Promise<ConversationSessionRoute[]> }
    | undefined;
  gateway: PetNoticeWiringGateway;
  /** Durable gateway outbox publish (`publishGatewayControlEvent`), for replies to a route. */
  publishRoute(event: GatewayControlEventInput): Promise<void>;
  /** Reads validated attachment descriptors into sendable bytes (owner sends only). */
  materializeAttachments(
    attachments: readonly NoticeMediaAttachment[],
  ): Promise<OutgoingAttachment[]>;
  /** Native desktop notification (`DesktopNotifier.notify`); click opens `sessionId`. */
  notifyDesktop(input: DesktopNotificationInput): Promise<unknown>;
  /** The user settings object (raw); only `pet.notifications` is read. */
  readSettings(): unknown;
  presence: { getSystemIdleTimeSec(): number; hasFocusedWindow(): boolean };
  /** Mimi's own Sessions never fire notice rules. */
  isMimiSession?: (sessionId: string) => boolean;
  /**
   * Electron `powerMonitor`: a digest whose timer slept through its moment is
   * sent when the machine wakes or the screen unlocks.
   */
  powerEvents?: PetNoticePowerEvents;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Test seams: the router's IM timeout and the owner's UTC offset. */
  imTimeoutMs?: number;
  timezoneOffsetMin?: (ms: number) => number;
}

export interface PetTaskClosureNotice {
  /** Mimi's owner-facing closure message, when the closure turn produced one. */
  text?: string;
  /** Files / URL action from the closure turn's validated GatewayReply draft. */
  media?: NoticeMedia;
}

/** A queued notice as Mimi's runtime context carries it (`pendingNotices`): data only. */
export interface PetPendingNotice {
  kind: string;
  title?: string;
  body: string;
}

/** The owner's IM message that starts a Mimi turn. */
export interface PetInboundOrigin {
  channel: string;
  target: string;
  senderId?: string;
  isDirectMessage?: boolean;
}

/**
 * Notices for one inbound message, handed to the dispatcher. They are taken
 * from the ledger only when that message's own Mimi turn starts (`take`), and
 * settled for good the moment the turn starts with them (`started`), so a
 * message that waits in the chat queue never holds them and never hands them
 * out twice. `finish` (always call it after dispatch) releases notices that
 * were taken but whose turn never started.
 */
export interface PetInboundReplay extends PetPendingNoticeSource {
  finish(): void;
}

export interface PetNoticeWiring {
  router: PetNoticeRouter;
  ruleStore: PetRuleStore;
  watcher: PetSessionRuleWatcher;
  ledger: PetNoticeLedger;
  receipts: PetReceiptStore;
  /** The router as pet IPC sees it; also records which Session the owner is viewing. */
  attention: PetIpcAttention;
  /**
   * Stores loaded. Startup recovery then runs in the background; the
   * router's submit, replay and digest flush wait for it themselves.
   */
  ready: Promise<void>;
  /** Feed what one Session stream event meant (from `createSessionOutcomeTap`). */
  observeSessionOutcomes(sessionId: string, outcomes: readonly SessionOutcome[]): void;
  /** A long task reached a terminal state and was not continued: one notice, then spend rules. */
  notifyTaskClosed(task: PetLongTask, closure?: PetTaskClosureNotice): Promise<void>;
  /**
   * Mimi started (or re-drove) a delegated Session: arm its automatic notice
   * rule so blocked prompts and the bell follow it. Never throws.
   */
  armDelegationRule(task: PetLongTask): Promise<void>;
  /** Queued notices for an owner's IM message; undefined without an IM origin. */
  inboundReplay(origin: PetInboundOrigin | undefined): PetInboundReplay | undefined;
  /** Pending decisions: PetImDecisions asks here where a decision's prompt goes. */
  decisions: PetDecisionNoticeHooks;
  /**
   * Who must be told about a Session's outcome: the single source for the
   * rule watcher, the task closure, decision prompts and the bound-Session bridge.
   */
  deliveries: PetDeliveryResolver;
  /** Waits for pending rule and notice writes (shutdown). */
  flush(): Promise<void>;
  /** The settings this wiring currently routes with. */
  settings(): PetNotificationSettings;
  /** Fresh `pet.notifications` for the settings form (bypasses the routing cache). */
  settingsView(): PetNotificationSettingsView;
  /** `pet.notifications` was written: drop the routing cache and tell listeners. */
  settingsChanged(): void;
  onSettingsChange(listener: () => void): () => void;
  /** The IM a rule with this channel and target is predicted to use; undefined → desktop. */
  predictIm(channel: NoticeChannel, target: NoticeRule["target"]): RuleEffect["im"];
  /** A top-level work Session (not Mimi's, not external) that rules may watch. */
  isEligibleSession(sessionId: string): boolean;
  dispose(): void;
}

export interface PetDecisionNoticeHooks {
  /**
   * Where a pending decision in this Session is prompted: the IM conversation
   * that started its active long task (`task`), else the Session's active
   * rules that watch blocked (the Session is blocked now, so a rule armed
   * after the request appeared still counts). Undefined: desktop only.
   */
  deliveryFor: ImDecisionDeliveryResolver;
  /** An IM conversation that belongs to the owner (direct messages only). */
  isOwnerConversation(origin: { channel: string; target: string; senderId?: string }): boolean;
  /** Hear about a pending decision in a rule-watched Session as it appears. */
  onBlocked(listener: (sessionId: string) => void): () => void;
  /** The owner is away (the router's presence): a desktop-kept prompt may now go to IM. */
  isAway(): boolean;
  /** The owner target the router would use on this channel is a confirmed private chat. */
  ownerChannelIsDirect(channel: string): boolean;
  /** The projection's status for a decision; undefined once it is gone. */
  decisionStatus(sessionId: string, requestId: string): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The settings schema's own `pet.notifications` validator: it holds the
 * bounds, and drops (rather than rejects) any malformed field.
 */
const NOTIFICATIONS_SCHEMA = SettingsSchema.shape.pet.removeDefault().shape.notifications;
type StoredPetNotifications = NonNullable<ReturnType<typeof NOTIFICATIONS_SCHEMA.parse>>;

function storedNotifications(userSettings: unknown): StoredPetNotifications {
  const pet = isRecord(userSettings) ? userSettings.pet : undefined;
  const parsed = NOTIFICATIONS_SCHEMA.safeParse(isRecord(pet) ? pet.notifications : undefined);
  return (parsed.success ? parsed.data : undefined) ?? {};
}

/**
 * `settings.pet.notifications` as the form edits it: defaults applied,
 * quiet-hour times kept while `enabled: false`. Quiet hours are only ever
 * switched off that way; an absent (or null) window is the default one.
 */
export function petNotificationSettingsView(userSettings: unknown): PetNotificationSettingsView {
  const stored = storedNotifications(userSettings);
  const window = stored.quietHours ?? DEFAULT_QUIET_HOURS;
  return {
    quietHours: {
      enabled: stored.quietHours?.enabled !== false,
      start: window.start,
      end: window.end,
    },
    maxPerHour: stored.maxPerHour ?? DEFAULT_MAX_PER_HOUR,
    maxP0PerHour: stored.maxP0PerHour ?? DEFAULT_MAX_P0_PER_HOUR,
    mergeWindowSec: stored.mergeWindowSec ?? DEFAULT_MERGE_WINDOW_SEC,
    presenceIdleSec: stored.presenceIdleSec ?? DEFAULT_PRESENCE_IDLE_SEC,
    delegatedFromDesktop: stored.delegatedFromDesktop ?? "auto",
  };
}

/** `settings.pet.notifications` with every field bounded; anything malformed falls back. */
export function parsePetNotificationSettings(userSettings: unknown): PetNotificationSettings {
  const { quietHours, ...rest } = petNotificationSettingsView(userSettings);
  return {
    quietHours: quietHours.enabled ? { start: quietHours.start, end: quietHours.end } : null,
    ...rest,
  };
}

function quietHoursText(settings: PetNotificationSettings): string | undefined {
  const window = settings.quietHours;
  if (!window || window.start === window.end) return undefined;
  return `${window.start}–${window.end} 只推需要你决定的事`;
}

function textLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DESKTOP_TITLES: Readonly<Record<string, string>> = {
  "session.done": "Mimi 任务已完成",
  "session.failed": "Mimi 任务执行失败",
  "session.blocked": "Mimi：需要你决定",
  "decision.expired": "Mimi 任务确认",
  digest: "Mimi：你不在时",
};

/**
 * Pending decisions already have one desktop surface: the pet's attention
 * peek / pending count. Their routed notices (the code-bearing prompt and its
 * expiry) therefore never add a native notification on top.
 */
function hasDesktopSurface(notice: NoticeSubmission): boolean {
  return (
    (notice.kind === "session.blocked" && notice.requestId !== undefined) ||
    notice.kind === "decision.expired"
  );
}

const ROUTE_EVENT_TYPES: Readonly<Record<string, GatewayControlEventInput["type"]>> = {
  "session.done": "pet.task.completed",
  "session.failed": "pet.task.failed",
};

/** Attachments this owner target accepts, in order, within its count and size limits. */
function attachmentsFor(
  target: ImGatewayOwnerTarget | undefined,
  attachments: readonly NoticeMediaAttachment[] | undefined,
): NoticeMediaAttachment[] {
  if (!target || !attachments) return [];
  return attachments
    .filter(
      (attachment) =>
        target.attachments.includes(attachment.kind) &&
        attachment.size <= target.maxAttachmentBytes,
    )
    .slice(0, target.maxAttachments);
}

/**
 * Remembers which work Session the owner had open on the desktop, so a
 * queued done / failed notice the owner has already looked at is not
 * replayed later over IM.
 */
class SessionViewTracker {
  private active: string | null = null;
  private readonly lastViewed = new Map<string, number>();

  setActive(sessionId: string | null, now: number): void {
    if (this.active) this.touch(this.active, now);
    this.active = sessionId;
    if (sessionId) this.touch(sessionId, now);
  }

  viewedSince(sessionId: string, ms: number, focused: boolean): boolean {
    if (this.active === sessionId && focused) return true;
    return (this.lastViewed.get(sessionId) ?? Number.NEGATIVE_INFINITY) >= ms;
  }

  private touch(sessionId: string, now: number): void {
    this.lastViewed.delete(sessionId);
    this.lastViewed.set(sessionId, now);
    while (this.lastViewed.size > MAX_VIEWED_SESSIONS) {
      const oldest = this.lastViewed.keys().next().value;
      if (oldest === undefined) break;
      this.lastViewed.delete(oldest);
    }
  }
}

/**
 * Composition root for owner notices: rule store, notice ledger, presence,
 * the router (which also keeps the pet's pending-decision attention), the
 * rule watcher and the NotifyMe host action. Everything Electron-specific is
 * injected so the wiring is unit-tested without a window or a gateway.
 */
export function wirePetNotices(deps: PetNoticeWiringDeps): PetNoticeWiring {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((event, data) => dlog("main", event, data));
  const petDir = join(deps.userDataDir, "pet");
  // Desktop main is the only writer of rules.json / notices.json, so their
  // in-process serialisation is enough (no cross-process lock).
  const ruleStore = new PetRuleStore({ path: join(petDir, "rules.json"), now });
  const ledger = new PetNoticeLedger({ path: join(petDir, "notices.json"), now });
  // Each notice's files are copied here when it is recorded, so a resend sends the same bytes.
  const mediaStore = new PetNoticeMediaStore({ root: join(petDir, "notice-media"), log });
  const receipts = new PetReceiptStore(join(petDir, "attention-receipts.json"), now);
  const views = new SessionViewTracker();

  let cachedSettings: { at: number; value: PetNotificationSettings } | undefined;
  const settings = (): PetNotificationSettings => {
    const at = now();
    if (cachedSettings && at - cachedSettings.at < SETTINGS_TTL_MS) return cachedSettings.value;
    let value: PetNotificationSettings;
    try {
      value = parsePetNotificationSettings(deps.readSettings());
    } catch (error) {
      log("pet.notice.settings_read_failed", { error: errorText(error) });
      value = parsePetNotificationSettings(undefined);
    }
    cachedSettings = { at, value };
    return value;
  };
  const settingsListeners = new Set<() => void>();
  const settingsView = (): PetNotificationSettingsView => {
    try {
      return petNotificationSettingsView(deps.readSettings());
    } catch (error) {
      log("pet.notice.settings_read_failed", { error: errorText(error) });
      return petNotificationSettingsView(undefined);
    }
  };
  const settingsChanged = (): void => {
    cachedSettings = undefined;
    for (const listener of settingsListeners) {
      try {
        listener();
      } catch (error) {
        log("pet.notice.settings_listener_failed", { error: errorText(error) });
      }
    }
  };

  const snapshot = (): DesktopPetProjectionSnapshot => deps.projection.getSnapshot();
  const workSession = (sessionId: string) =>
    snapshot().sessions.find(
      (session) => session.agentSessionId === sessionId && !session.external,
    );
  // The projection only lists top-level work Sessions (no Mimi, child or hidden kinds).
  const isEligibleSession = (sessionId: string): boolean =>
    deps.isMimiSession?.(sessionId) !== true && workSession(sessionId) !== undefined;

  const ownerChannels = shortLived(() => deps.gateway.ownerChannels());
  const ownerTargets = shortLived(() => deps.gateway.listOwnerMessageTargets());
  const imChannels = (): Record<string, ImReadiness> => {
    const result: Record<string, ImReadiness> = {};
    for (const channel of ownerChannels()) result[channel.id] = channel.ready;
    return result;
  };

  const presence = {
    isPresent: () =>
      createPresenceDetector({
        getSystemIdleTimeSec: deps.presence.getSystemIdleTimeSec,
        hasFocusedWindow: deps.presence.hasFocusedWindow,
        idleSec: settings().presenceIdleSec,
      }).isPresent(),
  };

  const router = new PetNoticeRouter({
    source: deps.projection,
    receipts,
    now,
    ledger,
    presence,
    settings: () => {
      const { quietHours, maxPerHour, maxP0PerHour, mergeWindowSec } = settings();
      return { quietHours, maxPerHour, maxP0PerHour, mergeWindowSec };
    },
    imChannels,
    lastInboundChannel: () => deps.gateway.lastOwnerInboundChannel(),
    supportsIdempotentSend: (channel) => deps.gateway.supportsIdempotentOwnerSend(channel),
    isDecisionStillPending: (sessionId, requestId) =>
      snapshot().pending.some(
        (pending) =>
          pending.agentSessionId === sessionId &&
          pending.requestId === requestId &&
          pending.status === "pending",
      ),
    wasSessionViewedSince: (sessionId, ms) => {
      let focused: boolean;
      try {
        focused = deps.presence.hasFocusedWindow();
      } catch {
        focused = false;
      }
      return views.viewedSince(sessionId, ms, focused);
    },
    isGoalRuleCancelled: (ruleId) => {
      const rule = ruleStore.get(ruleId);
      return (
        rule?.when.kind === "session" && rule.when.scope === "goal" && rule.state === "cancelled"
      );
    },
    outlets: {
      desktop: (notice, body) => {
        if (hasDesktopSurface(notice)) return;
        const key = createHash("sha256")
          .update("pet-notice\0")
          .update(notice.dedupeKey)
          .update("\0")
          .update(body)
          .digest("hex");
        const files = notice.media?.attachments?.length ?? 0;
        void Promise.resolve(
          deps.notifyDesktop({
            key,
            title: DESKTOP_TITLES[notice.kind] ?? "Mimi",
            // Clicking opens the Session, where the files are.
            body: files > 0 ? `${body}\n（含 ${files} 个附件，打开会话查看）` : body,
            ...(notice.priority === "P0" ? { urgent: true } : {}),
            ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
          }),
        ).catch((error) =>
          log("pet.notice.desktop_notify_failed", { kind: notice.kind, error: errorText(error) }),
        );
      },
      im: (channel, target, body, key, payload) => sendIm(channel, target, body, key, payload),
    },
    ...(deps.imTimeoutMs !== undefined ? { imTimeoutMs: deps.imTimeoutMs } : {}),
    ...(deps.timezoneOffsetMin ? { timezoneOffsetMin: deps.timezoneOffsetMin } : {}),
    media: mediaStore,
    log,
  });

  /**
   * Route notices are published to the durable gateway outbox (accepted =
   * enqueued); the deliveryKey derives from the record's claim key, so a
   * resend of the same record resumes the same delivery instead of repeating
   * it. Owner notices go to the channel's owner target, with the attachments
   * that target accepts.
   */
  async function sendIm(
    channel: string,
    target: NoticeTarget,
    body: string,
    key: string | undefined,
    payload: NoticeImPayload,
  ): Promise<NoticeImSendResult> {
    const media = parseNoticeMedia(payload.media);
    try {
      if (target.kind === "route") {
        const title = DESKTOP_TITLES[payload.kind];
        await deps.publishRoute({
          ...(key
            ? {
                deliveryKey: createHash("sha256")
                  .update("pet-notice-route\0")
                  .update(key)
                  .digest("hex"),
              }
            : {}),
          type: ROUTE_EVENT_TYPES[payload.kind] ?? "pet.task.reported",
          ...(title ? { title } : {}),
          text: body,
          ...(media?.button ? { button: media.button } : {}),
          ...(media?.attachments
            ? { attachments: media.attachments.map(({ sha256: _digest, ...file }) => file) }
            : {}),
          target: { channel: target.route.channel, target: target.route.target },
        });
        return { accepted: true };
      }
      const targetId = ownerChannels().find((entry) => entry.id === channel)?.targetId;
      if (!targetId) return { accepted: false, error: "no-owner-target" };
      const ownerTarget = ownerTargets().find((entry) => entry.id === targetId);
      // A group (or unconfirmed) owner target never gets private decision details.
      if (ownerTarget?.isDirect !== true && payload.nonDirectBody) body = payload.nonDirectBody;
      const files = attachmentsFor(ownerTarget, media?.attachments);
      let attachments: OutgoingAttachment[] = [];
      try {
        attachments = files.length > 0 ? await deps.materializeAttachments(files) : [];
      } catch (error) {
        // The text still matters; the files stay reachable from the Session.
        log("pet.notice.attachments_failed", { channel, error: errorText(error) });
      }
      const text = media?.button ? `${body}\n${media.button.text}：${media.button.url}` : body;
      await deps.gateway.sendOwnerMessage(
        targetId,
        text,
        attachments,
        key ? { idempotencyKey: key } : {},
      );
      return { accepted: true };
    } catch (error) {
      return { accepted: false, error: errorText(error) };
    }
  }

  const submit = (notice: NoticeSubmission): Promise<unknown> =>
    router.submit(notice).catch((error) => {
      log("pet.notice.submit_failed", { kind: notice.kind, error: errorText(error) });
      return undefined;
    });

  const deliveries = createPetDeliveryResolver({
    rules: ruleStore,
    longTasks: deps.longTasks,
    replyRoutes: async (sessionId) =>
      (await deps.sessionRoutes()?.notifyRoutesForSession(sessionId)) ?? [],
    delegatedFromDesktop: () => settings().delegatedFromDesktop,
    log,
  });

  const decisionListeners = new Set<(sessionId: string) => void>();

  const decisions: PetDecisionNoticeHooks = {
    deliveryFor(sessionId, task) {
      return deliveries.planBlocked({
        sessionId,
        ...(task ? { task } : {}),
        // Mimi's own and external Sessions are never watched by rules.
        useRules: isEligibleSession(sessionId),
      }).entries[0];
    },
    isOwnerConversation(origin) {
      try {
        return deps.gateway.isOwnerConversation(origin.channel, origin.target);
      } catch (error) {
        log("pet.notice.owner_lookup_failed", { error: errorText(error) });
        return false;
      }
    },
    onBlocked(listener) {
      decisionListeners.add(listener);
      return () => decisionListeners.delete(listener);
    },
    isAway() {
      try {
        return !presence.isPresent();
      } catch {
        return false;
      }
    },
    ownerChannelIsDirect(channel) {
      try {
        return ownerChannels().some((entry) => entry.id === channel && entry.isDirect);
      } catch {
        return false;
      }
    },
    decisionStatus(sessionId, requestId) {
      return snapshot().pending.find(
        (pending) => pending.agentSessionId === sessionId && pending.requestId === requestId,
      )?.status;
    },
  };

  const watcher = new PetSessionRuleWatcher({
    rules: ruleStore,
    deliveries,
    onNotice: (draft: NoticeDraft) => {
      const { delivery, ...rest } = draft;
      const { attention, channel, target, ruleIds, requiresAway } = delivery;
      // The Session's own reply (or its failure text) in that conversation is
      // the delivery: the router keeps the desktop record and sends no IM.
      const served = delivery.composeBy === "session-reply";
      if (served)
        log("pet.notice.bound_reply_delivered", {
          sessionId: draft.sessionId,
          dedupeKey: draft.dedupeKey,
        });
      void submit({
        ...rest,
        ruleIds,
        ...(requiresAway ? { requiresAway: true } : {}),
        attention,
        channel,
        target,
        ...(served ? { boundReplyDelivered: true } : {}),
      });
    },
    // PetImDecisions owns the prompt (with its reply code); nudge it now.
    onPendingDecision: (sessionId) => {
      for (const listener of decisionListeners) {
        try {
          listener(sessionId);
        } catch (error) {
          log("pet.notice.decision_listener_failed", { sessionId, error: errorText(error) });
        }
      }
    },
    // A cancelled Goal's pauses must never be replayed or digested later.
    onGoalCleared: (sessionId) => router.revokeSessionBlocked(sessionId),
    // Queued user messages (core queue depth). Background work parks the turn
    // with completionKind background_wait, which the watcher already skips.
    isSessionBusy: (sessionId) => {
      const session = workSession(sessionId);
      return !!session && (session.queueDepth > 0 || session.runState === "queued");
    },
    isEligibleSession,
    sessionTitle: (sessionId) => workSession(sessionId)?.title,
    now,
    log,
  });

  function predictedIm(
    channel: NoticeChannel,
    target: NoticeRule["target"],
    channels: readonly ImGatewayOwnerChannel[],
  ): RuleEffect["im"] {
    if (channel === "desktop") return undefined;
    const describe = (id: string): RuleEffect["im"] => {
      const entry = channels.find((candidate) => candidate.id === id);
      return { channel: id, label: entry?.label ?? id, ready: entry?.ready ?? "unknown" };
    };
    // A notice from an IM conversation goes back to that conversation's channel.
    if (target.kind === "route") return describe(target.route.channel);
    if (channel !== "auto") return describe(channel);
    const usable = (id: string | undefined) =>
      id !== undefined &&
      channels.some((entry) => entry.id === id && entry.ready !== "unavailable");
    const last = deps.gateway.lastOwnerInboundChannel();
    if (usable(last)) return describe(last!);
    const first = channels.find((entry) => entry.ready !== "unavailable");
    return first ? describe(first.id) : undefined;
  }

  const upsertRule: HostActionHandler = async (callerSessionId, args) => {
    const upsert = parseNoticeRuleUpsert(args);
    if (!upsert) throw new Error("invalid notice rule request");
    if (upsert.sessionId !== callerSessionId)
      throw new Error("a Session can only set notice rules for itself");
    if (!isEligibleSession(upsert.sessionId)) throw new Error("unknown work Session");
    const channels = ownerChannels();
    if (
      upsert.channel !== "auto" &&
      upsert.channel !== "desktop" &&
      !channels.some((channel) => channel.id === upsert.channel)
    ) {
      const reply: NoticeRuleUpsertReply = {
        ok: true,
        status: "unknown_channel",
        channels: channels
          .slice(0, 32)
          .map(({ id, label, ready }): BoundChannel => ({ id, label, ready })),
      };
      return reply;
    }
    await ruleStore.load();
    const target = await deliveries.ruleTarget(upsert.sessionId);
    const rule = await ruleStore.upsertSessionRule({
      ...upsert,
      target,
      origin: "user",
      armedAt: now(),
    });
    const im = predictedIm(rule.channel, rule.target, channels);
    const quietHours = quietHoursText(settings());
    const when = upsert.scope === "goal" ? "目标完成或卡住时" : "这个会话下一次完成实际工作后";
    const reply: NoticeRuleUpsertReply = {
      ok: true,
      status: "ok",
      effect: {
        ruleId: rule.id,
        // "auto" only uses the IM while the owner is away; never promise it outright.
        fires:
          rule.channel === "auto" && im
            ? `${when}（你在电脑前时发桌面，不在时发${im.label}）`
            : when,
        channel: rule.channel,
        ...(im ? { im } : {}),
        ...(quietHours ? { quietHours } : {}),
      },
    };
    return reply;
  };
  const removeHostAction = deps.bridge.setHostActionHandler(PET_RULE_UPSERT_ACTION, upsertRule);

  const ready: Promise<void> = Promise.all([ruleStore.load(), ledger.load(), receipts.load()])
    .then(() => undefined)
    .catch((error) => log("pet.notice.load_failed", { error: errorText(error) }));
  // In the background: a slow resend (up to the IM timeout) must not hold up
  // startup. The router's own submit / replay / flush wait for it.
  void ready
    .then(() => router.recover())
    .catch((error) => log("pet.notice.recover_failed", { error: errorText(error) }));

  let disposed = false;
  /** Send held notices that are due now (their timer may have slept through it). */
  const flushDueDigest = (): void => {
    if (disposed) return;
    void router
      .flushDigest()
      .catch((error) => log("pet.notice.digest_failed", { error: errorText(error) }));
  };
  deps.powerEvents?.on("resume", flushDueDigest);
  deps.powerEvents?.on("unlock-screen", flushDueDigest);
  const unsubscribeProjection = deps.projection.subscribe((event) => {
    void ready.then(() => (disposed ? undefined : watcher.observeProjection(event)));
    // A decision answered anywhere (or timed out) must never be replayed later.
    const resolved =
      event.kind === "pending-remove"
        ? { sessionId: event.sessionId, requestId: event.requestId }
        : event.kind === "pending-upsert" && event.pending.status !== "pending"
          ? { sessionId: event.pending.agentSessionId, requestId: event.pending.requestId }
          : undefined;
    if (resolved)
      void ready.then(() =>
        disposed ? undefined : router.revokeDecision(resolved.sessionId, resolved.requestId),
      );
  });

  async function spend(rules: readonly NoticeRule[]): Promise<void> {
    for (const rule of rules) {
      if (rule.when.kind !== "session") continue;
      try {
        await ruleStore.update(rule.id, rule.version, { state: "spent" });
      } catch (error) {
        log("pet.notice.rule_update_failed", { ruleId: rule.id, error: errorText(error) });
      }
    }
  }

  async function armDelegationRule(task: PetLongTask): Promise<void> {
    try {
      await ready;
      // A rule the owner set on this Session (even paused) is their choice; never rewrite it.
      const ownerRule = ruleStore
        .list()
        .some(
          (rule) =>
            rule.origin === "user" &&
            rule.when.kind === "session" &&
            rule.when.sessionId === task.sessionId &&
            (rule.state === "active" || rule.state === "paused"),
        );
      if (ownerRule) {
        log("pet.notice.delegation_rule_skipped", { sessionId: task.sessionId, reason: "user" });
        return;
      }
      // The rule is the task's delivery declaration: blocked prompts and the
      // bell follow it, and the closure's own entry merges with it.
      await ruleStore.upsertSessionRule({
        sessionId: task.sessionId,
        createdBy: "delegation",
        events: ["done", "failed", "blocked"],
        scope: task.verificationMode === "goal" ? "goal" : "turn",
        ...deliveries.taskOrigin(task),
        attention: "always",
        origin: "delegation",
        armedAt: now(),
      });
    } catch (error) {
      log("pet.notice.delegation_rule_failed", {
        sessionId: task.sessionId,
        error: errorText(error),
      });
    }
  }

  async function notifyTaskClosed(
    task: PetLongTask,
    closure: PetTaskClosureNotice = {},
  ): Promise<void> {
    if (task.status === "cancelled") {
      // No notice for a cancelled delegation, but its automatic rule must not
      // outlive it and fire on the owner's own later turns in that Session.
      await ready;
      await spend(
        ruleStore.activeForSession(task.sessionId).filter((rule) => rule.origin === "delegation"),
      );
      return;
    }
    if (task.status !== "completed" && task.status !== "failed") return;
    await ready;
    const event = task.status === "completed" ? "done" : "failed";
    const plan = await deliveries.plan({ sessionId: task.sessionId, event, task });
    // A plan for a task opens with its closure entry.
    const delivery = plan.entries[0]!;
    const title =
      textLine(workSession(task.sessionId)?.title, MAX_TITLE) ??
      textLine(task.objective, MAX_TITLE);
    const summary = textLine(task.resultSummary ?? task.summary, MAX_SUMMARY);
    const error = textLine(task.lastError, MAX_ERROR);
    const body = closure.text?.trim();
    const media = parseNoticeMedia(closure.media);
    await submit({
      kind: event === "done" ? "session.done" : "session.failed",
      priority: "P1",
      // Per attempt: a retried attempt that fails again must notify again.
      dedupeKey: `task:${task.id}:${task.attempt}:${task.status}`,
      sessionId: task.sessionId,
      ruleIds: delivery.ruleIds,
      attention: delivery.attention,
      channel: delivery.channel,
      target: delivery.target,
      facts: {
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(error ? { error } : {}),
      },
      ...(body ? { body } : {}),
      // The owner asked for this over IM: their answer is never held back.
      ...(delivery.reply ? { reply: true } : {}),
      ...(media ? { media } : {}),
    });
    // This notice satisfies every Session rule that was waiting for the outcome.
    await spend(plan.rules);
  }

  function inboundReplay(origin: PetInboundOrigin | undefined): PetInboundReplay | undefined {
    if (!origin) return undefined;
    let ids: string[] = [];
    let state: "idle" | "taken" | "started" | "finished" = "idle";
    return {
      async take() {
        if (state !== "idle" || disposed) return [];
        state = "taken";
        // The owner is back: anything the digest was holding for this moment goes now.
        flushDueDigest();
        let replayed: Awaited<ReturnType<PetNoticeRouter["replayPending"]>>;
        try {
          await ready;
          replayed = await router.replayPending(origin.channel, {
            target: origin.target,
            ...(origin.senderId !== undefined ? { senderId: origin.senderId } : {}),
            ...(origin.isDirectMessage !== undefined
              ? { isDirectMessage: origin.isDirectMessage }
              : {}),
          });
        } catch (error) {
          log("pet.notice.replay_failed", { channel: origin.channel, error: errorText(error) });
          return [];
        }
        const kept = replayed.slice(0, PET_PENDING_NOTICES_MAX);
        // More than one turn can carry stays queued for the next message.
        router.releaseReplay(replayed.slice(PET_PENDING_NOTICES_MAX).map((notice) => notice.id));
        ids = kept.map((notice) => notice.id);
        // finish() may have run while the ledger was being read.
        if ((state as string) === "finished") {
          router.releaseReplay(ids);
          return [];
        }
        return kept.map((notice): PetPendingNotice => {
          const title = textLine(notice.title, PET_PENDING_NOTICE_TITLE_MAX);
          return {
            kind: notice.kind.slice(0, 64),
            ...(title ? { title } : {}),
            body: notice.body.slice(0, PET_PENDING_NOTICE_BODY_MAX) || "-",
          };
        });
      },
      started() {
        if (state !== "taken") return;
        state = "started";
        if (ids.length === 0) return;
        void router
          .markReplayed(ids)
          .catch((error) => log("pet.notice.replay_mark_failed", { error: errorText(error) }));
      },
      finish() {
        if (state === "taken") router.releaseReplay(ids);
        if (state !== "started") state = "finished";
      },
    };
  }

  const attention: PetIpcAttention = {
    getSnapshot: () => router.getSnapshot(),
    subscribe: (listener) => router.subscribe(listener),
    setActiveSession: (sessionId) => {
      views.setActive(sessionId, now());
      router.setActiveSession(sessionId);
    },
    markReceipts: (keys, state) => router.markReceipts(keys, state),
  };

  return {
    router,
    ruleStore,
    watcher,
    ledger,
    receipts,
    attention,
    ready,
    observeSessionOutcomes(sessionId, outcomes) {
      if (outcomes.length === 0) return;
      // Chained on one promise, so per-Session order is preserved.
      void ready.then(() => (disposed ? undefined : watcher.observe(sessionId, outcomes)));
    },
    notifyTaskClosed,
    armDelegationRule,
    inboundReplay,
    decisions,
    deliveries,
    flush: async () => {
      await Promise.all([ruleStore.flush(), ledger.flush()]);
    },
    settings,
    settingsView,
    settingsChanged,
    onSettingsChange(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    predictIm: (channel, target) => predictedIm(channel, target, ownerChannels()),
    isEligibleSession,
    dispose() {
      if (disposed) return;
      settingsListeners.clear();
      disposed = true;
      removeHostAction();
      unsubscribeProjection();
      deps.powerEvents?.removeListener("resume", flushDueDigest);
      deps.powerEvents?.removeListener("unlock-screen", flushDueDigest);
      router.dispose();
    },
  };
}
