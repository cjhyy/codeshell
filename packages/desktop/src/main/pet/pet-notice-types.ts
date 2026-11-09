import type { PetLongTaskCompletionTarget } from "@cjhyy/code-shell-pet";
import type { NoticeAttention, NoticeChannel } from "@cjhyy/code-shell-pet/protocol";
import type { NoticeFacts } from "./pet-notice-compose.js";
import type { NoticeDeliveryStatus, NoticeRecord, PetNoticeLedger } from "./pet-notice-ledger.js";
import {
  DEFAULT_MAX_P0_PER_HOUR,
  DEFAULT_MAX_PER_HOUR,
  type ImReadiness,
  type NoticePriority,
  type RouteDecision,
  type RouteState,
} from "./pet-notice-policy.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
} from "./pet-state-aggregator.js";

export type { NoticeFacts } from "./pet-notice-compose.js";

export interface PetPeek {
  id: string;
  title: string;
  detail: string;
  receiptKeys: string[];
  action:
    | { type: "open_session"; target: PetNavigationRequest }
    | { type: "open_pet_pending"; count: number };
}

export type PetAttentionEvent =
  | { kind: "count"; surfaceablePendingCount: number }
  | { kind: "peek"; peek: PetPeek };

export interface PetAttentionSnapshot {
  surfaceablePendingCount: number;
}

export interface PetAttentionOptions {
  source: {
    getSnapshot(): DesktopPetProjectionSnapshot;
    subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void;
  };
  receipts: { has(key: string): boolean; mark(key: string, state?: string): void };
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  graceMs?: number;
  burstMs?: number;
}

/** Where an IM notice is addressed: the IM conversation it came from, or the owner. */
export type NoticeTarget =
  | { kind: "route"; route: PetLongTaskCompletionTarget }
  | { kind: "owner" };

/** One file a notice carries, as a validated descriptor (the path is read only at send time). */
export interface NoticeMediaAttachment {
  kind: "image" | "file" | "audio" | "video";
  name: string;
  mimeType: string;
  size: number;
  path: string;
}

/** Files and a URL action that travel with a notice's text (e.g. a closure GatewayReply draft). */
export interface NoticeMedia {
  attachments?: NoticeMediaAttachment[];
  button?: { text: string; url: string };
}

export const MAX_NOTICE_ATTACHMENTS = 4;
export const MAX_NOTICE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_KINDS = new Set(["image", "file", "audio", "video"]);

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Bounded media, or undefined when there is nothing valid to carry. */
export function parseNoticeMedia(value: unknown): NoticeMedia | undefined {
  if (!isObject(value)) return undefined;
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .filter(
          (entry): entry is NoticeMediaAttachment =>
            isObject(entry) &&
            ATTACHMENT_KINDS.has(entry.kind as string) &&
            boundedText(entry.name, 255) &&
            boundedText(entry.mimeType, 255) &&
            typeof entry.size === "number" &&
            Number.isSafeInteger(entry.size) &&
            entry.size >= 0 &&
            entry.size <= MAX_NOTICE_ATTACHMENT_BYTES &&
            boundedText(entry.path, 4_096),
        )
        .slice(0, MAX_NOTICE_ATTACHMENTS)
        .map(({ kind, name, mimeType, size, path }) => ({ kind, name, mimeType, size, path }))
    : [];
  const raw = value.button;
  const button =
    isObject(raw) &&
    boundedText(raw.text, 200) &&
    boundedText(raw.url, 2_048) &&
    /^https?:\/\//u.test(raw.url)
      ? { text: raw.text, url: raw.url }
      : undefined;
  if (attachments.length === 0 && !button) return undefined;
  return { ...(attachments.length > 0 ? { attachments } : {}), ...(button ? { button } : {}) };
}

/** One notice handed to `PetNoticeRouter.submit`. */
export interface NoticeSubmission {
  kind: "session.done" | "session.failed" | "session.blocked" | "digest" | (string & {});
  priority: NoticePriority;
  dedupeKey: string;
  sessionId?: string;
  ruleIds: string[];
  /** Only the all-sessions system rule matched: notify only while the owner is away. */
  requiresAway?: boolean;
  requestId?: string;
  expiresAt?: number;
  facts: NoticeFacts;
  attention: NoticeAttention;
  channel: NoticeChannel;
  target: NoticeTarget;
  /** Pre-written text (e.g. Mimi's closure message); otherwise templated from `facts`. */
  body?: string;
  /**
   * The answer to something the owner asked for over IM (an IM-started task's
   * result): never held for quiet hours, the hourly cap or the merge window.
   */
  reply?: boolean;
  /** Files / URL action sent with the text; such a notice is never digested or merged. */
  media?: NoticeMedia;
  /**
   * The Session is bound to an IM conversation that already received this
   * run's reply: the notice never goes to IM (or the digest), only the desktop.
   */
  boundReplyDelivered?: boolean;
}

export interface NoticeRouterSettings {
  quietHours: RouteState["quietHours"];
  maxPerHour?: number;
  maxP0PerHour?: number;
  /** A P1 for a Session that got an IM within this window is held for the digest. */
  mergeWindowSec?: number;
}

export type NoticeImSendResult = { accepted: true } | { accepted: false; error: string };

/** What an IM send carries besides the text; the same record always yields the same payload. */
export interface NoticeImPayload {
  kind: string;
  media?: NoticeMedia;
  /** Send this instead when the owner target on that channel is not a private chat. */
  nonDirectBody?: string;
}

/** What one submission did: the routing decision and, when IM was tried, the send. */
export interface NoticeSubmitResult {
  decision: RouteDecision;
  /** The IM send of this submission; absent when nothing was sent now. */
  sent?: "accepted" | "failed" | "unknown";
}

/** A dedupe key's earlier record (decision and delivery), e.g. after a restart. */
export interface NoticePriorDecision {
  decision?: RouteDecision;
  status?: NoticeDeliveryStatus;
  /** The IM channel of the latest claim or queue entry. */
  channel?: string;
}

export interface NoticeOutlets {
  desktop(notice: NoticeSubmission, body: string): void;
  /**
   * Route targets get the record's claim key always (the gateway outbox keys
   * its delivery progress by it); owner sends only on idempotent channels.
   */
  im(
    channel: string,
    target: NoticeTarget,
    body: string,
    idempotencyKey: string | undefined,
    payload: NoticeImPayload,
  ): Promise<NoticeImSendResult>;
}

/** The ledger surface the router uses; `PetNoticeLedger` satisfies it. */
export type NoticeLedgerPort = Pick<
  PetNoticeLedger,
  | "load"
  | "record"
  | "claim"
  | "settle"
  | "countsThisHour"
  | "seenDedupeKeys"
  | "queued"
  | "held"
  | "recoverOnStartup"
  | "expireQueued"
  | "get"
  | "byDedupeKey"
>;

/**
 * The IM conversation an inbound owner message arrived on. The caller only
 * replays for the owner's own messages.
 */
export interface NoticeConversation {
  target: string;
  senderId?: string;
  isDirectMessage?: boolean;
}

/** A queued notice handed back for Mimi's next turn: text plus a few capped fields. */
export interface ReplayedNotice {
  id: string;
  kind: string;
  sessionId?: string;
  title?: string;
  body: string;
}

export interface PetNoticeRouterOptions extends PetAttentionOptions {
  /** Without a ledger the router cannot dedupe, cap or claim, so it never sends IM. */
  ledger?: NoticeLedgerPort;
  /** Defaults to "present" (desktop) when absent. */
  presence?: { isPresent(): boolean };
  settings?: () => NoticeRouterSettings;
  /** Bound IM channels in display order. */
  imChannels?: () => Readonly<Record<string, ImReadiness>>;
  lastInboundChannel?: () => string | undefined;
  outlets?: NoticeOutlets;
  /** The channel's gateway collapses resends that carry the same idempotency key. */
  supportsIdempotentSend?: (channel: string) => boolean;
  isDecisionStillPending?: (sessionId: string, requestId: string) => boolean;
  wasSessionViewedSince?: (sessionId: string, ms: number) => boolean;
  /** Owner's offset east of UTC at an instant; defaults to the host's (DST-aware). */
  timezoneOffsetMin?: (ms: number) => number;
  /** An IM send that has not answered by then counts as failed (default 30 s). */
  imTimeoutMs?: number;
  /** How long replayed notices stay withheld without markReplayed/releaseReplay (default 10 min). */
  replayHoldMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The ledger keeps the target, a channel other than "auto" (and any media)
 * beside the facts so recovery, digest and replay can use them.
 */
export function unpackFacts(raw: unknown): {
  facts: NoticeFacts;
  target: NoticeTarget;
  /** The channel the notice asked for; absent means "auto". */
  channel?: NoticeChannel;
  media?: NoticeMedia;
} {
  if (!isObject(raw)) return { facts: {}, target: { kind: "owner" } };
  const { target, media: rawMedia, channel, ...facts } = raw;
  const route = isObject(target) && target.kind === "route" ? target.route : undefined;
  const media = parseNoticeMedia(rawMedia);
  return {
    facts: facts as NoticeFacts,
    target:
      isObject(route) && typeof route.channel === "string" && typeof route.target === "string"
        ? { kind: "route", route: route as unknown as PetLongTaskCompletionTarget }
        : { kind: "owner" },
    ...(typeof channel === "string" && channel && channel !== "auto" ? { channel } : {}),
    ...(media ? { media } : {}),
  };
}

/** The IM address for `channel`: the origin route only when it lives on that channel. */
export function imTarget(target: NoticeTarget, channel: string): NoticeTarget {
  return target.kind === "route" && target.route.channel === channel ? target : { kind: "owner" };
}

/** Groups notices that go to the same place: the owner, or one IM conversation. */
export function targetKey(target: NoticeTarget): string {
  if (target.kind === "owner") return "owner";
  const { channel, target: address, senderId } = target.route;
  return JSON.stringify([channel, address, senderId ?? ""]);
}

/**
 * A queued notice belongs to an inbound conversation when it came from that
 * same conversation (and sender, when the route names one), or when it is
 * addressed to the owner and the owner wrote in a direct message.
 */
export function matchesConversation(
  target: NoticeTarget,
  channel: string,
  conversation: NoticeConversation,
): boolean {
  if (target.kind === "owner") return conversation.isDirectMessage === true;
  const route = target.route;
  if (route.channel !== channel || route.target !== conversation.target) return false;
  return route.senderId === undefined || route.senderId === conversation.senderId;
}

/**
 * A notice from an IM conversation goes back to that conversation's channel
 * or waits for it; it never jumps to a different IM channel.
 */
export function pinToRoute(decision: RouteDecision, channel: string): RouteDecision {
  const wantsIm =
    decision.outlet === "im" ||
    decision.outlet === "both" ||
    decision.queued === true ||
    decision.reason === "no-im-available";
  if (!wantsIm || decision.im === channel) return decision;
  return { outlet: "desktop", im: channel, queued: true, reason: "im-unavailable-queued" };
}

export function noticeFromRecord(record: NoticeRecord): NoticeSubmission {
  const { facts, target, media } = unpackFacts(record.facts);
  return {
    kind: record.kind,
    priority: record.priority,
    dedupeKey: record.dedupeKey,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
    ruleIds: record.ruleIds,
    facts,
    attention: "always",
    channel: "desktop",
    target,
    ...(media ? { media } : {}),
  };
}

const DEFAULT_MERGE_WINDOW_SEC = 600;

export function normalizeSettings(
  value: NoticeRouterSettings | undefined,
): Required<NoticeRouterSettings> {
  return {
    quietHours: value?.quietHours ?? null,
    maxPerHour: value?.maxPerHour ?? DEFAULT_MAX_PER_HOUR,
    maxP0PerHour: value?.maxP0PerHour ?? DEFAULT_MAX_P0_PER_HOUR,
    mergeWindowSec: value?.mergeWindowSec ?? DEFAULT_MERGE_WINDOW_SEC,
  };
}

/**
 * Why a queued notice should no longer be replayed: expired, its decision
 * was resolved elsewhere, or (done / failed) the owner already looked at the
 * Session on the desktop.
 */
export function staleReason(
  record: NoticeRecord,
  now: number,
  probes: Pick<PetNoticeRouterOptions, "isDecisionStillPending" | "wasSessionViewedSince">,
): string | undefined {
  if (record.expiresAt !== undefined && record.expiresAt <= now) return "expired";
  const { sessionId, requestId } = record;
  const pending = probes.isDecisionStillPending;
  if (sessionId && requestId && pending && !pending(sessionId, requestId)) return "resolved";
  if (
    sessionId &&
    (record.kind === "session.done" || record.kind === "session.failed") &&
    probes.wasSessionViewedSince?.(sessionId, record.createdAt) === true
  )
    return "viewed";
  return undefined;
}

/** The error of a send that did not answer in time (it may still have been delivered). */
export const IM_SEND_TIMEOUT = "timeout";

/** One IM send raced against a timeout; a throw, a missing outlet or the timeout is a failure. */
export function sendWithTimeout(
  send: () => Promise<NoticeImSendResult> | undefined,
  timeoutMs: number,
  schedule: (callback: () => void, delay: number) => unknown,
  cancel: (timer: unknown) => void,
): Promise<NoticeImSendResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: NoticeImSendResult) => {
      if (done) return;
      done = true;
      cancel(timer);
      resolve(result);
    };
    const timer = schedule(() => finish({ accepted: false, error: IM_SEND_TIMEOUT }), timeoutMs);
    // A pending send must never keep the process alive.
    (timer as { unref?: () => void } | undefined)?.unref?.();
    Promise.resolve()
      .then(send)
      .then(
        (result) => finish(result ?? { accepted: false, error: "no-im-outlet" }),
        (error) => finish({ accepted: false, error: errorText(error) }),
      );
  });
}
