import { createHash } from "node:crypto";
import type { PetLongTaskCompletionTarget } from "@cjhyy/code-shell-pet";
import type { NoticeAttention, NoticeChannel } from "@cjhyy/code-shell-pet/protocol";
import type { NoticeActions, NoticeActionsInput } from "./pet-notice-action-codes.js";
import type { NoticeFacts } from "./pet-notice-compose.js";
import type {
  NoticeDecisionPrompt,
  NoticeDecisionPromptPatch,
  NoticeDeliveryStatus,
  NoticeRecord,
  PetNoticeLedger,
} from "./pet-notice-ledger.js";
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

/**
 * One file a notice carries, as a validated descriptor. Once the router has
 * recorded the notice, `path` points at the notice's own frozen copy (see
 * pet-notice-media.ts) and `sha256` is that copy's digest.
 */
export interface NoticeMediaAttachment {
  kind: "image" | "file" | "audio" | "video";
  name: string;
  mimeType: string;
  size: number;
  path: string;
  sha256?: string;
}

/** Files and a URL action that travel with a notice's text (e.g. a closure GatewayReply draft). */
export interface NoticeMedia {
  attachments?: NoticeMediaAttachment[];
  button?: { text: string; url: string };
}

export const MAX_NOTICE_ATTACHMENTS = 4;
export const MAX_NOTICE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_KINDS = new Set(["image", "file", "audio", "video"]);
const SHA256 = /^[0-9a-f]{64}$/u;

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
            boundedText(entry.path, 4_096) &&
            (entry.sha256 === undefined ||
              (typeof entry.sha256 === "string" && SHA256.test(entry.sha256))),
        )
        .slice(0, MAX_NOTICE_ATTACHMENTS)
        .map(({ kind, name, mimeType, size, path, sha256 }) => ({
          kind,
          name,
          mimeType,
          size,
          path,
          ...(sha256 !== undefined ? { sha256 } : {}),
        }))
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

/** Files a notice carries, copied once per record so every (re)send sends the same bytes. */
export interface NoticeMediaFreezer {
  /**
   * Copy the attachments into the record's own folder and return descriptors
   * that point at the copies. Never throws: when any copy fails the notice
   * goes out text-only (its URL button kept), so a file can never hold it up.
   */
  freeze(recordId: string, media: NoticeMedia): Promise<NoticeMedia | undefined>;
  /** Delete the record's folder (best effort, never throws). */
  release(recordId: string): Promise<void>;
  /** Delete every record folder that `keep` does not claim (best effort). */
  sweep(keep: (recordId: string) => boolean): Promise<void>;
}

/** One notice handed to `PetNoticeRouter.submit`. */
export interface NoticeSubmission {
  kind:
    | "session.done"
    | "session.failed"
    | "session.blocked"
    | "session.report"
    | "followup.due"
    | "digest"
    | (string & {});
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
   * The delivery plan serves this outcome with the Session's own reply in a
   * bound IM conversation (`composeBy: "session-reply"`): the notice never
   * goes to IM (or the digest), only the desktop.
   */
  boundReplyDelivered?: boolean;
  /**
   * The first prompt for a pending decision (needs `sessionId` and
   * `requestId`): its record carries the prompt's lifecycle from now on.
   */
  prompt?: Pick<NoticeDecisionPrompt, "code" | "deadline" | "skippable" | "replies">;
  /**
   * Make the notice an open item (a goal pause, a failure, a result to open):
   * its record carries what it may do, and the IM text ends with a plain line
   * saying what the owner can answer.
   */
  actions?: NoticeActionsInput;
}

/** A notice's open item as its ledger record has it (see `PetNoticeRouter.actionRecord`). */
export interface NoticeActionRecord {
  recordId: string;
  kind: string;
  target: NoticeTarget;
  facts: NoticeFacts;
  actions: NoticeActions;
}

export interface NoticeRouterSettings {
  quietHours: RouteState["quietHours"];
  maxPerHour?: number;
  maxP0PerHour?: number;
  /** A P1 for a Session that got an IM within this window is held for the digest. */
  mergeWindowSec?: number;
}

/** `enqueued`: written to the gateway outbox, whose delivery result settles the record later. */
export type NoticeImSendResult =
  | { accepted: true; enqueued?: true }
  | { accepted: false; error: string };

/** What an IM send carries besides the text; the same record always yields the same payload. */
export interface NoticeImPayload {
  kind: string;
  media?: NoticeMedia;
  /** Send this instead when the owner target on that channel is not a private chat. */
  nonDirectBody?: string;
  /**
   * The gateway outbox delivers (and retries) it no later than this; past it
   * the delivery settles `expired` (a P1/P2 owner notice then goes to the digest).
   */
  expiresAt?: number;
}

/** A gateway outbox delivery's final result, as the outbox reports it. */
export type NoticeOutboxOutcome =
  | "delivered"
  | "failed"
  | "unknown"
  | "expired"
  | "revoked"
  | "unauthorized";

/** Where an outbox delivery stands: under way, settled, or unknown to the outbox. */
export type NoticeOutboxState =
  | "pending"
  /** The outbox has not been read yet (the control server is starting): ask again later. */
  | "not-ready"
  | { outcome: NoticeOutboxOutcome; error?: string };

/** What one submission did: the routing decision and, when IM was tried, the send. */
export interface NoticeSubmitResult {
  decision: RouteDecision;
  /** The IM send of this submission; absent when nothing was sent now. */
  sent?: "accepted" | "failed" | "unknown";
}

/** One decision prompt as its ledger record has it. */
export interface DecisionPromptRecord {
  code: string;
  sessionId: string;
  requestId: string;
  target: NoticeTarget;
  ruleIds: string[];
  title?: string;
  prompt: NoticeDecisionPrompt;
  /** The router's decision on the first prompt. */
  decision?: RouteDecision;
  /**
   * The delivery of each copy of the prompt, oldest first: the first prompt,
   * then its "owner left" escalation. `channel` is the claim's or queue's.
   * Read lazily from the ledger.
   */
  readonly copies: Array<{ status?: NoticeDeliveryStatus; channel?: string }>;
}

/** The decision-prompt surface of the router (`PetNoticeRouter` implements it). */
export interface NoticeDecisionPrompts {
  submitWithOutcome(notice: NoticeSubmission): Promise<NoticeSubmitResult>;
  /** Resolves once the records are readable (the ledger loaded, or failed to). */
  decisionsLoaded(): Promise<void>;
  decisionRecord(code: string): DecisionPromptRecord | undefined;
  /** Prompt records, oldest first; `only` picks them before any view is built. */
  decisionRecords(only?: (prompt: NoticeDecisionPrompt) => boolean): DecisionPromptRecord[];
  /**
   * A request prompted by an older build has its first record (`dedupeKey`)
   * but no lifecycle: give it one instead of prompting again.
   */
  adoptDecision(
    sessionId: string,
    requestId: string,
    dedupeKey: string,
    prompt: NonNullable<NoticeSubmission["prompt"]>,
  ): Promise<DecisionPromptRecord | undefined>;
  /** Persist a lifecycle step; undefined when there is no such record or it could not be written. */
  updateDecision(
    code: string,
    patch: NoticeDecisionPromptPatch,
  ): Promise<DecisionPromptRecord | undefined>;
}

export interface NoticeOutlets {
  desktop(notice: NoticeSubmission, body: string): void;
  /**
   * Write one send to the gateway outbox, keyed by the record's claim key
   * (see {@link noticeDeliveryKey}). Accepted = enqueued; the outbox reports
   * the delivery's result later (`PetNoticeRouter.applyOutboxResult`).
   */
  im(
    channel: string,
    target: NoticeTarget,
    body: string,
    idempotencyKey: string | undefined,
    payload: NoticeImPayload,
  ): Promise<NoticeImSendResult>;
  /** Withdraw an enqueued delivery; it is never sent after this resolves. Throws when it could not be. */
  revoke?(deliveryKey: string): Promise<void>;
  /** Where an enqueued delivery stands in the outbox (startup recovery). */
  outboxState?(deliveryKey: string): NoticeOutboxState | undefined;
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
  | "enqueued"
  | "recoverOnStartup"
  | "expireQueued"
  | "get"
  | "byDedupeKey"
  | "byPromptCode"
  | "prompts"
  | "forRequest"
  | "updatePrompt"
  | "adoptPrompt"
  | "byActionCode"
  | "actionRecords"
  | "updateActions"
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
  /** The rule is a goal-scope Session rule that was cancelled (its Goal was cleared). */
  isGoalRuleCancelled?: (ruleId: string) => boolean;
  /** Owner's offset east of UTC at an instant; defaults to the host's (DST-aware). */
  timezoneOffsetMin?: (ms: number) => number;
  /** An IM send that has not answered by then counts as failed (default 30 s). */
  imTimeoutMs?: number;
  /** How long replayed notices stay withheld without markReplayed/releaseReplay (default 10 min). */
  replayHoldMs?: number;
  /** Copies a notice's files per record; without it attachments are read from their paths. */
  media?: NoticeMediaFreezer;
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

/**
 * The gateway outbox's delivery key for one notice record's send: derived
 * from the record's claim key, so every resend of the record is the same
 * delivery (the outbox dedupes it, the relay resumes it, and the platform
 * client id derived from it lets a channel drop a duplicate).
 */
export function noticeDeliveryKey(claimKey: string, target: NoticeTarget): string {
  return createHash("sha256")
    .update(target.kind === "route" ? "pet-notice-route\0" : "pet-notice-owner\0")
    .update(claimKey)
    .digest("hex");
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
 * Why a queued or held notice should no longer be replayed or digested:
 * expired, its decision was resolved elsewhere, its Goal was cleared (a goal
 * pause whose goal rule is cancelled), or (done / failed / report) the owner already
 * looked at the Session on the desktop.
 */
export function staleReason(
  record: NoticeRecord,
  now: number,
  probes: Pick<
    PetNoticeRouterOptions,
    "isDecisionStillPending" | "wasSessionViewedSince" | "isGoalRuleCancelled"
  >,
): string | undefined {
  if (record.expiresAt !== undefined && record.expiresAt <= now) return "expired";
  const { sessionId, requestId } = record;
  const pending = probes.isDecisionStillPending;
  if (sessionId && requestId && pending && !pending(sessionId, requestId)) return "resolved";
  const goalCancelled = probes.isGoalRuleCancelled;
  if (
    record.kind === "session.blocked" &&
    requestId === undefined &&
    goalCancelled &&
    record.ruleIds.some((id) => goalCancelled(id))
  )
    return "goal-cleared";
  if (
    sessionId &&
    (record.kind === "session.done" ||
      record.kind === "session.failed" ||
      record.kind === "session.report") &&
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
