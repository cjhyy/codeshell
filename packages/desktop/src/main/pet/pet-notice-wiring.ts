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
  type NoticeAttention,
  type NoticeChannel,
  type NoticeRuleUpsertReply,
  type RuleEffect,
} from "@cjhyy/code-shell-pet/protocol";
import { dlog } from "../desktop-logger.js";
import type { DesktopNotificationInput } from "../desktop-notifier.js";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { OutgoingAttachment } from "@cjhyy/code-shell-chat";
import type {
  ImGatewayOwnerChannel,
  ImGatewayOwnerSendOptions,
  ImGatewayOwnerTarget,
} from "../im-gateway-service.js";
import type { PetPendingNoticeSource } from "./pet-dispatch-service.js";
import type { ImDecisionRuleDelivery } from "./pet-im-decisions.js";
import type { PetIpcAttention } from "./pet-ipc.js";
import { PetNoticeLedger } from "./pet-notice-ledger.js";
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
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

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
  /** IM conversations bound to a Session; resolved lazily (built after this wiring). */
  sessionRoutes: () =>
    | { notifyRoutesForSession(sessionId: string): Promise<ConversationSessionRoute[]> }
    | undefined;
  /**
   * The bound-Session reply still being published for a run, if any; a done
   * notice for that run waits for it (bounded) before deciding on IM.
   */
  boundReplies?: () =>
    | {
        /** Settles when the Session's current run ends (a goal can be met mid-run). */
        runInFlight(sessionId: string): Promise<void> | undefined;
        pendingReply(sessionId: string, runId: string): Promise<void> | undefined;
      }
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
  /** Stores loaded and startup recovery kicked off. */
  ready: Promise<void>;
  /** Feed one top-level Session stream event (from the bridge's outbound tap). */
  observeSessionEvent(sessionId: string, event: unknown): void;
  /** A long task reached a terminal state and was not continued: one notice, then spend rules. */
  notifyTaskClosed(task: PetLongTask, closure?: PetTaskClosureNotice): Promise<void>;
  /** Queued notices for an owner's IM message; undefined without an IM origin. */
  inboundReplay(origin: PetInboundOrigin | undefined): PetInboundReplay | undefined;
  /** Pending decisions: PetImDecisions asks here where a rule-watched decision goes. */
  decisions: PetDecisionNoticeHooks;
  /**
   * A bound Session's turn reply was published to `route`. A done notice for
   * the same run then stays off that conversation (bound-reply-delivered).
   */
  recordBoundReply(
    sessionId: string,
    runId: string,
    route: { channel: string; target: string; senderId?: string },
  ): void;
  /** Waits for pending rule and notice writes (shutdown). */
  flush(): Promise<void>;
  /** The settings this wiring currently routes with. */
  settings(): PetNotificationSettings;
  dispose(): void;
}

export interface PetDecisionNoticeHooks {
  /** The Session's active rules that watch blocked, merged (the Session is blocked now). */
  rulesFor(sessionId: string): ImDecisionRuleDelivery | undefined;
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

/**
 * How long a done notice waits for the same run to end and its bound reply
 * to be published (a goal is met before its run's turn_complete).
 */
const BOUND_REPLY_WAIT_MS = 10_000;
const MAX_BOUND_REPLY_SESSIONS = 500;

const ATTENTION_RANK: Readonly<Record<NoticeAttention, number>> = {
  always: 3,
  important: 2,
  digest: 1,
  muted: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** `settings.pet.notifications` with every field bounded; anything malformed falls back. */
export function parsePetNotificationSettings(userSettings: unknown): PetNotificationSettings {
  const pet = isRecord(userSettings) ? userSettings.pet : undefined;
  const raw = isRecord(pet) && isRecord(pet.notifications) ? pet.notifications : {};
  let quietHours: PetNotificationSettings["quietHours"] = { ...DEFAULT_QUIET_HOURS };
  if (raw.quietHours === null) quietHours = null;
  else if (
    isRecord(raw.quietHours) &&
    typeof raw.quietHours.start === "string" &&
    typeof raw.quietHours.end === "string" &&
    HH_MM.test(raw.quietHours.start) &&
    HH_MM.test(raw.quietHours.end)
  )
    quietHours = { start: raw.quietHours.start, end: raw.quietHours.end };
  return {
    quietHours,
    maxPerHour: boundedInt(raw.maxPerHour, 0, 100, DEFAULT_MAX_PER_HOUR),
    maxP0PerHour: boundedInt(raw.maxP0PerHour, 0, 100, DEFAULT_MAX_P0_PER_HOUR),
    mergeWindowSec: boundedInt(raw.mergeWindowSec, 0, 24 * 60 * 60, DEFAULT_MERGE_WINDOW_SEC),
    presenceIdleSec: boundedInt(raw.presenceIdleSec, 10, 24 * 60 * 60, DEFAULT_PRESENCE_IDLE_SEC),
    delegatedFromDesktop: raw.delegatedFromDesktop === "desktop" ? "desktop" : "auto",
  };
}

function quietHoursText(settings: PetNotificationSettings): string | undefined {
  const window = settings.quietHours;
  if (!window || window.start === window.end) return undefined;
  return `${window.start}–${window.end} 只推需要你决定的事`;
}

/** The attributes a notice takes from the rules it matched. */
export function mergeRuleAttributes(rules: readonly NoticeRule[]): {
  attention: NoticeAttention;
  channel: NoticeChannel;
  target: NoticeTarget;
} {
  let attention: NoticeAttention | undefined;
  for (const rule of rules) {
    if (attention === undefined || ATTENTION_RANK[rule.attention] > ATTENTION_RANK[attention])
      attention = rule.attention;
  }
  // A named IM is the most specific ask, then auto, then desktop only.
  const named = rules.find((rule) => rule.channel !== "auto" && rule.channel !== "desktop");
  const channel = named
    ? named.channel
    : rules.some((rule) => rule.channel === "auto")
      ? "auto"
      : rules.length > 0
        ? "desktop"
        : "auto";
  const routed = rules.find((rule) => rule.target.kind === "route");
  const target: NoticeTarget =
    routed?.target.kind === "route"
      ? { kind: "route", route: routed.target.route }
      : { kind: "owner" };
  return { attention: attention ?? "always", channel, target };
}

function routeTarget(route: ConversationSessionRoute): NoticeRule["target"] {
  return {
    kind: "route",
    route: {
      kind: "im-gateway",
      channel: route.channel,
      target: route.target,
      senderId: route.senderId,
      // Binding is refused outside private chats (bind validator). Rules saved
      // before this flag keep isDirectMessage false: on load a binding-derived
      // route cannot be told apart from an IM task's group route (both carry a
      // sender and false), so they are not upgraded; their decision prompts stay
      // generic until NotifyMe re-arms the rule.
      isDirectMessage: true,
    },
  };
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

  const snapshot = (): DesktopPetProjectionSnapshot => deps.projection.getSnapshot();
  const workSession = (sessionId: string) =>
    snapshot().sessions.find(
      (session) => session.agentSessionId === sessionId && !session.external,
    );
  // The projection only lists top-level work Sessions (no Mimi, child or hidden kinds).
  const isEligibleSession = (sessionId: string): boolean =>
    deps.isMimiSession?.(sessionId) !== true && workSession(sessionId) !== undefined;

  const imChannels = (): Record<string, ImReadiness> => {
    const result: Record<string, ImReadiness> = {};
    for (const channel of deps.gateway.ownerChannels()) result[channel.id] = channel.ready;
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
          ...(media?.attachments ? { attachments: media.attachments } : {}),
          target: { channel: target.route.channel, target: target.route.target },
        });
        return { accepted: true };
      }
      const targetId = deps.gateway.ownerChannels().find((entry) => entry.id === channel)?.targetId;
      if (!targetId) return { accepted: false, error: "no-owner-target" };
      const ownerTarget = deps.gateway
        .listOwnerMessageTargets()
        .find((entry) => entry.id === targetId);
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

  // A long task owns its Session while active, and owns the run it closed.
  const hasActiveLongTask = (sessionId: string, run: string): boolean =>
    deps.longTasks.activeForSession(sessionId) !== undefined ||
    deps.longTasks
      .getSnapshot()
      .tasks.some((task) => task.sessionId === sessionId && task.runId === run);

  const submit = (notice: NoticeSubmission): Promise<unknown> =>
    router.submit(notice).catch((error) => {
      log("pet.notice.submit_failed", { kind: notice.kind, error: errorText(error) });
      return undefined;
    });

  /** sessionId → the latest run whose bound reply was published, and where to. */
  const boundReplies = new Map<
    string,
    { runId: string; routes: { channel: string; target: string; senderId?: string }[] }
  >();

  function recordBoundReply(
    sessionId: string,
    runId: string,
    route: { channel: string; target: string; senderId?: string },
  ): void {
    const previous = boundReplies.get(sessionId);
    const routes = previous?.runId === runId ? previous.routes : [];
    routes.push({ channel: route.channel, target: route.target, senderId: route.senderId });
    boundReplies.delete(sessionId);
    boundReplies.set(sessionId, { runId, routes });
    while (boundReplies.size > MAX_BOUND_REPLY_SESSIONS) {
      const oldest = boundReplies.keys().next().value;
      if (oldest === undefined) break;
      boundReplies.delete(oldest);
    }
  }

  /**
   * Whether this run's reply already reached the notice's IM destination: the
   * same conversation, or — for an owner-addressed notice — any bound
   * conversation, since binding only happens in the owner's private chats.
   */
  function boundReplyCovers(sessionId: string, runId: string, notice: NoticeSubmission): boolean {
    const delivered = boundReplies.get(sessionId);
    if (delivered?.runId !== runId || delivered.routes.length === 0) return false;
    const target = notice.target;
    if (target.kind === "owner")
      // Only when the owner notice would land on the bound chat's channel.
      return (
        notice.channel === "auto" ||
        delivered.routes.some((route) => route.channel === notice.channel)
      );
    return delivered.routes.some(
      (route) => route.channel === target.route.channel && route.target === target.route.target,
    );
  }

  function submitDone(notice: NoticeSubmission, runId: string): void {
    const sessionId = notice.sessionId!;
    const decide = (): Promise<unknown> => {
      if (!boundReplyCovers(sessionId, runId, notice)) return submit(notice);
      log("pet.notice.bound_reply_delivered", { sessionId, dedupeKey: notice.dedupeKey });
      return submit({ ...notice, boundReplyDelivered: true });
    };
    const bridge = (() => {
      try {
        return deps.boundReplies?.();
      } catch (error) {
        log("pet.notice.bound_reply_lookup_failed", { sessionId, error: errorText(error) });
        return undefined;
      }
    })();
    const lookup = (get: () => Promise<void> | undefined): Promise<void> | undefined => {
      try {
        return get();
      } catch (error) {
        log("pet.notice.bound_reply_lookup_failed", { sessionId, error: errorText(error) });
        return undefined;
      }
    };
    // Nothing in flight (the usual turn-scope case): decide now, in order.
    const running = bridge && lookup(() => bridge.runInFlight(sessionId));
    const publishing = bridge && lookup(() => bridge.pendingReply(sessionId, runId));
    if (!running && !publishing) {
      void decide();
      return;
    }
    // Wait (bounded) for the run to end, then for its reply to reach the outbox.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BOUND_REPLY_WAIT_MS);
      timer.unref?.();
    });
    const settled = async (): Promise<void> => {
      if (running) await running.catch(() => undefined);
      const reply = bridge && lookup(() => bridge.pendingReply(sessionId, runId));
      if (reply) await reply.catch(() => undefined);
    };
    void Promise.race([settled(), deadline]).then(() => {
      clearTimeout(timer);
      return disposed ? undefined : decide();
    });
  }

  const decisionListeners = new Set<(sessionId: string) => void>();

  const decisions: PetDecisionNoticeHooks = {
    rulesFor(sessionId) {
      if (!isEligibleSession(sessionId)) return undefined;
      const rules = ruleStore
        .activeForSession(sessionId)
        .filter((rule) => rule.when.events.includes("blocked"));
      if (rules.length === 0) return undefined;
      const onlySystem = rules.every((rule) => rule.when.kind === "all-sessions");
      return {
        ruleIds: rules.map((rule) => rule.id),
        ...mergeRuleAttributes(rules),
        ...(onlySystem ? { requiresAway: true } : {}),
      };
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
        return deps.gateway.ownerChannels().some((entry) => entry.id === channel && entry.isDirect);
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
    onNotice: (draft: NoticeDraft) => {
      const rules = draft.ruleIds
        .map((id) => ruleStore.get(id))
        .filter((rule): rule is NoticeRule => rule !== undefined);
      const { runId, ...rest } = draft;
      const notice: NoticeSubmission = { ...rest, ...mergeRuleAttributes(rules) };
      if (draft.kind === "session.done" && runId !== undefined) submitDone(notice, runId);
      else void submit(notice);
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
    hasActiveLongTask,
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

  async function resolveRuleTarget(sessionId: string): Promise<NoticeRule["target"]> {
    try {
      const routes = (await deps.sessionRoutes()?.notifyRoutesForSession(sessionId)) ?? [];
      const bound = routes.find((route) => route.mode === "bound" && route.status === "active");
      if (bound) return routeTarget(bound);
    } catch (error) {
      log("pet.notice.route_lookup_failed", { sessionId, error: errorText(error) });
    }
    const completionTarget = deps.longTasks.activeForSession(sessionId)?.completionTarget;
    if (completionTarget?.kind === "im-gateway") return { kind: "route", route: completionTarget };
    return { kind: "owner" };
  }

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
    const channels = deps.gateway.ownerChannels();
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
    const target = await resolveRuleTarget(upsert.sessionId);
    const rule = await ruleStore.upsertSessionRule({
      ...upsert,
      target,
      origin: "user",
      armedAt: now(),
    });
    const im = predictedIm(rule.channel, rule.target, channels);
    const quietHours = quietHoursText(settings());
    const reply: NoticeRuleUpsertReply = {
      ok: true,
      status: "ok",
      effect: {
        ruleId: rule.id,
        fires: upsert.scope === "goal" ? "目标完成或卡住时" : "这个会话下一次完成实际工作后",
        channel: rule.channel,
        ...(im ? { im } : {}),
        ...(quietHours ? { quietHours } : {}),
      },
    };
    return reply;
  };
  const removeHostAction = deps.bridge.setHostActionHandler(PET_RULE_UPSERT_ACTION, upsertRule);

  const ready: Promise<void> = Promise.all([ruleStore.load(), ledger.load(), receipts.load()])
    .then(() => router.recover())
    .catch((error) => log("pet.notice.load_failed", { error: errorText(error) }));

  let disposed = false;
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

  async function notifyTaskClosed(
    task: PetLongTask,
    closure: PetTaskClosureNotice = {},
  ): Promise<void> {
    if (task.status !== "completed" && task.status !== "failed") return;
    await ready;
    const event = task.status === "completed" ? "done" : "failed";
    const rules = ruleStore
      .activeForSession(task.sessionId)
      .filter((rule) => rule.when.events.includes(event));
    const ruleChannel = rules.length > 0 ? mergeRuleAttributes(rules).channel : undefined;
    const completionTarget = task.completionTarget;
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
      ruleIds: rules.map((rule) => rule.id),
      attention: "always",
      channel: completionTarget
        ? completionTarget.channel
        : (ruleChannel ?? settings().delegatedFromDesktop),
      target: completionTarget ? { kind: "route", route: completionTarget } : { kind: "owner" },
      facts: {
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(error ? { error } : {}),
      },
      ...(body ? { body } : {}),
      // The owner asked for this over IM: their answer is never held back.
      ...(completionTarget ? { reply: true } : {}),
      ...(media ? { media } : {}),
    });
    // This notice satisfies every Session rule that was waiting for the outcome.
    await spend(rules);
  }

  function inboundReplay(origin: PetInboundOrigin | undefined): PetInboundReplay | undefined {
    if (!origin) return undefined;
    let ids: string[] = [];
    let state: "idle" | "taken" | "started" | "finished" = "idle";
    return {
      async take() {
        if (state !== "idle" || disposed) return [];
        state = "taken";
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
    observeSessionEvent(sessionId, event) {
      // Chained on one promise, so per-Session order is preserved.
      void ready.then(() => (disposed ? undefined : watcher.observe(sessionId, event)));
    },
    notifyTaskClosed,
    inboundReplay,
    decisions,
    recordBoundReply,
    flush: async () => {
      await Promise.all([ruleStore.flush(), ledger.flush()]);
    },
    settings,
    dispose() {
      if (disposed) return;
      disposed = true;
      removeHostAction();
      unsubscribeProjection();
      router.dispose();
    },
  };
}
