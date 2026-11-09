import type { PetLongTaskCompletionTarget } from "@cjhyy/code-shell-pet";
import type { NoticeAttention, NoticeChannel } from "@cjhyy/code-shell-pet/protocol";
import { dlog } from "../desktop-logger.js";
import { composeNoticeBody, type NoticeFacts } from "./pet-notice-compose.js";
import { NoticeDigest } from "./pet-notice-digest.js";
import type { NoticeRecord, PetNoticeLedger } from "./pet-notice-ledger.js";
import {
  DEFAULT_MAX_P0_PER_HOUR,
  DEFAULT_MAX_PER_HOUR,
  hostTimezoneOffsetMin,
  route,
  type DedupeLookup,
  type ImReadiness,
  type NoticePriority,
  type RouteDecision,
  type RouteState,
} from "./pet-notice-policy.js";
import type {
  DesktopPendingDecision,
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

function receiptKey(pending: DesktopPendingDecision): string {
  return `local-user\u0000${pending.agentSessionId}\u0000${pending.requestId}\u0000pending`;
}

/** Where an IM notice is addressed: the IM conversation it came from, or the owner. */
export type NoticeTarget =
  | { kind: "route"; route: PetLongTaskCompletionTarget }
  | { kind: "owner" };

/** One notice handed to {@link PetNoticeRouter.submit}. */
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
}

export interface NoticeRouterSettings {
  quietHours: RouteState["quietHours"];
  maxPerHour?: number;
  maxP0PerHour?: number;
  /** A P1 for a Session that got an IM within this window is held for the digest. */
  mergeWindowSec?: number;
}

export type NoticeImSendResult = { accepted: true } | { accepted: false; error: string };

export interface NoticeOutlets {
  desktop(notice: NoticeSubmission, body: string): void;
  im(
    channel: string,
    target: NoticeTarget,
    body: string,
    idempotencyKey: string | undefined,
  ): Promise<NoticeImSendResult>;
}

/** The ledger surface the router uses; {@link PetNoticeLedger} satisfies it. */
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
>;

/** A queued notice handed back for Mimi's next turn on that channel. */
export interface ReplayedNotice {
  id: string;
  kind: string;
  facts: NoticeFacts;
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
  log?: (event: string, data: Record<string, unknown>) => void;
}

const DEFAULT_MERGE_WINDOW_SEC = 600;
const MAX_RULE_IDS = 100;
const NO_KEYS: DedupeLookup = { has: () => false };

interface NoticePlan {
  decision: RouteDecision;
  recordId?: string;
  claim?: { channel: string; key: string };
  /** The decision could not be recorded or claimed; only desktop delivery is safe. */
  ledgerFailed: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The ledger keeps the target beside the facts so restart recovery can resend. */
function unpackFacts(raw: unknown): { facts: NoticeFacts; target: NoticeTarget } {
  if (!isObject(raw)) return { facts: {}, target: { kind: "owner" } };
  const { target, ...facts } = raw;
  const route = isObject(target) && target.kind === "route" ? target.route : undefined;
  return {
    facts: facts as NoticeFacts,
    target:
      isObject(route) && typeof route.channel === "string" && typeof route.target === "string"
        ? { kind: "route", route: route as unknown as PetLongTaskCompletionTarget }
        : { kind: "owner" },
  };
}

/** The IM address for `channel`: the origin route only when it lives on that channel. */
function imTarget(target: NoticeTarget, channel: string): NoticeTarget {
  return target.kind === "route" && target.route.channel === channel ? target : { kind: "owner" };
}

/**
 * A notice from an IM conversation goes back to that conversation's channel
 * or waits for it; it never jumps to a different IM channel.
 */
function pinToRoute(decision: RouteDecision, channel: string): RouteDecision {
  const wantsIm =
    decision.outlet === "im" ||
    decision.outlet === "both" ||
    decision.queued === true ||
    decision.reason === "no-im-available";
  if (!wantsIm || decision.im === channel) return decision;
  return { outlet: "desktop", im: channel, queued: true, reason: "im-unavailable-queued" };
}

function noticeFromRecord(record: NoticeRecord): NoticeSubmission {
  const { facts, target } = unpackFacts(record.facts);
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
  };
}

/**
 * The single place Mimi decides whether, where and how to tell the owner
 * something. Two paths share it:
 *
 * - attention: pending decisions from the projection surface on the desktop
 *   pet after a grace period (count / peek events, unchanged);
 * - notices: {@link submit} routes a notice through the pure policy, records
 *   the decision in the ledger, then delivers to the desktop and/or IM, holds
 *   it for the digest, or queues it for when the IM channel is back.
 */
export class PetNoticeRouter {
  private readonly listeners = new Set<(event: PetAttentionEvent) => void>();
  private readonly timers = new Map<string, unknown>();
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly graceMs: number;
  private readonly burstMs: number;
  private activeSessionId: string | null = null;
  private count = 0;
  private unsubscribe?: () => void;
  private burstTimer: unknown;
  private burst: DesktopPendingDecision[] = [];
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly digest?: NoticeDigest;
  /** Latest IM claim per Session, for the P1 merge window (in memory only). */
  private readonly lastImSendAt = new Map<string, number>();
  private decisionQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: PetNoticeRouterOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel =
      options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.graceMs = options.graceMs ?? 15_000;
    this.burstMs = options.burstMs ?? 2_000;
    this.log = options.log ?? ((event, data) => dlog("main", event, data));
    if (options.ledger) {
      this.digest = new NoticeDigest({
        ledger: options.ledger,
        now: this.now,
        setTimeout: this.schedule,
        clearTimeout: this.cancel,
        window: (now) => {
          const settings = this.settings();
          return {
            quietHours: settings.quietHours,
            maxPerHour: settings.maxPerHour,
            mergeWindowMs: settings.mergeWindowSec * 1_000,
            timezoneOffsetMin: this.offset(now),
          };
        },
        factsOf: (record) => unpackFacts(record.facts).facts,
        submit: (digest) =>
          this.submit({
            kind: "digest",
            priority: "P2",
            dedupeKey: digest.dedupeKey,
            ruleIds: digest.ruleIds,
            facts: { title: "你不在时", summary: `${digest.count} 条` },
            attention: "always",
            channel: "auto",
            target: { kind: "owner" },
            body: digest.body,
          }),
        settle: (id, status, error) => this.settleQuietly(id, status, error),
        log: this.log,
      });
    }
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.source.subscribe(() => this.reconcile());
    this.reconcile();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    if (this.burstTimer !== undefined) this.cancel(this.burstTimer);
    this.burstTimer = undefined;
    this.burst = [];
  }

  subscribe(listener: (event: PetAttentionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PetAttentionSnapshot {
    return { surfaceablePendingCount: this.count };
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  markReceipts(keys: readonly string[], state: "seen" | "dismissed"): void {
    for (const key of keys) this.options.receipts.mark(key, state);
  }

  reconcile(): void {
    const snapshot = this.options.source.getSnapshot();
    const pending = snapshot.pending.filter((entry) => entry.status === "pending");
    const liveKeys = new Set(pending.map(receiptKey));
    for (const [key, timer] of this.timers) {
      if (liveKeys.has(key)) continue;
      this.cancel(timer);
      this.timers.delete(key);
    }

    const now = this.now();
    for (const decision of pending) {
      const key = receiptKey(decision);
      const remaining = decision.createdAt + this.graceMs - now;
      if (remaining <= 0) {
        const timer = this.timers.get(key);
        if (timer !== undefined) this.cancel(timer);
        this.timers.delete(key);
        this.surface(snapshot, decision, key);
      } else if (!this.timers.has(key)) {
        this.timers.set(
          key,
          this.schedule(() => {
            this.timers.delete(key);
            this.reconcile();
          }, remaining),
        );
      }
    }

    const nextCount = pending.filter((decision) => decision.createdAt + this.graceMs <= now).length;
    if (nextCount !== this.count) {
      this.count = nextCount;
      this.emit({ kind: "count", surfaceablePendingCount: nextCount });
    }
  }

  private surface(
    _snapshot: DesktopPetProjectionSnapshot,
    decision: DesktopPendingDecision,
    key: string,
  ): void {
    if (this.options.receipts.has(key)) return;
    if (this.activeSessionId === decision.agentSessionId) {
      this.options.receipts.mark(key, "suppressed-active");
      return;
    }
    this.options.receipts.mark(key, "surfaced");
    this.burst.push(decision);
    if (this.burstTimer !== undefined) return;
    this.burstTimer = this.schedule(() => this.flushBurst(), this.burstMs);
  }

  private flushBurst(): void {
    this.burstTimer = undefined;
    const decisions = this.burst.splice(0);
    if (decisions.length === 0) return;
    const snapshot = this.options.source.getSnapshot();
    const receiptKeys = decisions.map(receiptKey);
    const peek: PetPeek =
      decisions.length === 1
        ? {
            id: `pet-peek-${decisions[0]!.agentSessionId}-${decisions[0]!.requestId}`,
            title: decisions[0]!.title,
            detail: decisions[0]!.kind === "ask_user" ? "需要回答" : "等待工具审批",
            receiptKeys,
            action: {
              type: "open_session",
              target: {
                agentSessionId: decisions[0]!.agentSessionId,
                snapshotVersion: snapshot.version,
                generation: snapshot.generation,
                requestId: decisions[0]!.requestId,
                routeGeneration: decisions[0]!.routeGeneration,
              },
            },
          }
        : {
            id: `pet-peek-burst-${this.now()}`,
            title: `${decisions.length} 个 session 等你决定`,
            detail: "打开 Mimi 查看全部待决策",
            receiptKeys,
            action: { type: "open_pet_pending", count: decisions.length },
          };
    this.emit({ kind: "peek", peek });
  }

  /** Route one notice, record the decision, and act on it. */
  async submit(notice: NoticeSubmission): Promise<RouteDecision> {
    const body = composeNoticeBody(notice.kind, notice.facts, notice.body);
    const plan = await this.serially(() => this.plan(notice, body));
    await this.deliver(notice, body, plan);
    return plan.decision;
  }

  /**
   * After a restart: resend young claims once on channels that collapse
   * duplicates (same key, same body), mark the rest `unknown` with a desktop
   * note, expire stale queued notices, and re-arm the digest. Never passes
   * `manualRetry`.
   */
  async recover(): Promise<void> {
    const ledger = this.options.ledger;
    if (!ledger) return;
    const now = this.now();
    let resend: NoticeRecord[];
    try {
      resend = await ledger.recoverOnStartup(now);
    } catch (error) {
      this.log("pet.notice.recover_failed", { error: errorText(error) });
      return;
    }
    for (const record of resend) await this.recoverClaim(record);
    try {
      await ledger.expireQueued(now);
    } catch (error) {
      this.log("pet.notice.expire_failed", { error: errorText(error) });
    }
    this.scheduleDigest();
  }

  /**
   * Queued notices for `channel`, for the owner's next inbound message there.
   * Stale ones (decision resolved, expired, or already seen on the desktop)
   * are revoked; the rest stay queued until {@link markReplayed}.
   */
  async replayPending(channel: string): Promise<ReplayedNotice[]> {
    const ledger = this.options.ledger;
    if (!ledger) return [];
    const now = this.now();
    try {
      await ledger.expireQueued(now);
    } catch (error) {
      this.log("pet.notice.expire_failed", { error: errorText(error) });
    }
    const replay: ReplayedNotice[] = [];
    for (const record of ledger.queued()) {
      if (record.delivery?.channel !== channel) continue;
      const stale = this.staleReason(record, now);
      const { facts } = unpackFacts(record.facts);
      if (stale) {
        await this.settleQuietly(record.id, "revoked", stale);
        continue;
      }
      replay.push({
        id: record.id,
        kind: record.kind,
        facts,
        body: record.body ?? composeNoticeBody(record.kind, facts),
      });
    }
    return replay;
  }

  /** The replayed notices reached Mimi's turn; settle them for good. */
  async markReplayed(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.settleQuietly(id, "revoked", "replayed-in-turn");
  }

  /** Send the held notices as one digest if sending is allowed now; otherwise re-arm. */
  flushDigest(): Promise<void> {
    return this.digest?.flush() ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.digest?.dispose();
    this.stop();
  }

  private serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.decisionQueue.then(task);
    this.decisionQueue = run.catch(() => undefined);
    return run;
  }

  private settings(): Required<NoticeRouterSettings> {
    let value: NoticeRouterSettings | undefined;
    try {
      value = this.options.settings?.();
    } catch (error) {
      this.log("pet.notice.settings_failed", { error: errorText(error) });
    }
    return {
      quietHours: value?.quietHours ?? null,
      maxPerHour: value?.maxPerHour ?? DEFAULT_MAX_PER_HOUR,
      maxP0PerHour: value?.maxP0PerHour ?? DEFAULT_MAX_P0_PER_HOUR,
      mergeWindowSec: value?.mergeWindowSec ?? DEFAULT_MERGE_WINDOW_SEC,
    };
  }

  private offset(ms: number): number {
    return (this.options.timezoneOffsetMin ?? hostTimezoneOffsetMin)(ms);
  }

  private async plan(notice: NoticeSubmission, body: string): Promise<NoticePlan> {
    const now = this.now();
    const ledger = this.options.ledger;
    let counts = { sent: 0, p0Sent: 0 };
    let seen = NO_KEYS;
    let ledgerReady = ledger !== undefined;
    if (ledger) {
      try {
        await ledger.load();
        counts = ledger.countsThisHour(now);
        seen = ledger.seenDedupeKeys();
      } catch (error) {
        ledgerReady = false;
        this.log("pet.notice.ledger_read_failed", { error: errorText(error) });
      }
    }
    const decision = this.decide(notice, counts, seen, now);
    if (!ledger || !ledgerReady) return { decision, ledgerFailed: true };

    let recordId: string;
    try {
      const record = await ledger.record({
        kind: notice.kind,
        priority: notice.priority,
        dedupeKey: notice.dedupeKey,
        ...(notice.sessionId !== undefined ? { sessionId: notice.sessionId } : {}),
        ...(notice.requestId !== undefined ? { requestId: notice.requestId } : {}),
        ...(notice.expiresAt !== undefined ? { expiresAt: notice.expiresAt } : {}),
        ruleIds: notice.ruleIds.slice(0, MAX_RULE_IDS),
        facts: { ...notice.facts, target: notice.target },
        body,
        decision,
      });
      recordId = record.id;
    } catch (error) {
      this.log("pet.notice.record_failed", { kind: notice.kind, error: errorText(error) });
      return { decision, ledgerFailed: true };
    }
    if ((decision.outlet !== "im" && decision.outlet !== "both") || !decision.im)
      return { decision, recordId, ledgerFailed: false };
    try {
      const { key } = await ledger.claim(recordId, decision.im, body);
      if (notice.sessionId) this.lastImSendAt.set(notice.sessionId, now);
      return { decision, recordId, claim: { channel: decision.im, key }, ledgerFailed: false };
    } catch (error) {
      this.log("pet.notice.claim_failed", { kind: notice.kind, error: errorText(error) });
      return { decision, recordId, ledgerFailed: true };
    }
  }

  private decide(
    notice: NoticeSubmission,
    counts: { sent: number; p0Sent: number },
    seen: DedupeLookup,
    now: number,
  ): RouteDecision {
    const settings = this.settings();
    const imReady: Record<string, ImReadiness> = { ...(this.options.imChannels?.() ?? {}) };
    const routeChannel = notice.target.kind === "route" ? notice.target.route.channel : undefined;
    const pinned = routeChannel !== undefined && notice.channel !== "desktop";
    let channel = notice.channel;
    let lastInbound = this.options.lastInboundChannel?.();
    if (pinned) {
      // The conversation the owner used is the channel; it exists even if unlisted.
      if (!Object.hasOwn(imReady, routeChannel)) imReady[routeChannel] = "unknown";
      if (channel === "auto") lastInbound = routeChannel;
      else channel = routeChannel;
    }
    let decision = route(
      {
        priority: notice.priority,
        dedupeKey: notice.dedupeKey,
        attention: notice.attention,
        channel,
        ...(notice.requiresAway ? { requiresAway: true } : {}),
      },
      {
        now,
        present: this.options.presence?.isPresent() ?? true,
        quietHours: settings.quietHours,
        timezoneOffsetMin: this.offset(now),
        sentThisHour: counts.sent,
        p0SentThisHour: counts.p0Sent,
        maxPerHour: settings.maxPerHour,
        maxP0PerHour: settings.maxP0PerHour,
        seenDedupeKeys: seen,
        imReady,
        ...(lastInbound !== undefined ? { lastInboundChannel: lastInbound } : {}),
      },
    );
    if (pinned) decision = pinToRoute(decision, routeChannel);
    if (
      notice.priority === "P1" &&
      notice.sessionId &&
      (decision.outlet === "im" || decision.outlet === "both")
    ) {
      const last = this.lastImSendAt.get(notice.sessionId);
      if (last !== undefined && now - last < settings.mergeWindowSec * 1_000)
        decision = { outlet: "digest", reason: "merge-window" };
    }
    return decision;
  }

  private async deliver(notice: NoticeSubmission, body: string, plan: NoticePlan): Promise<void> {
    const { decision } = plan;
    const desktopNow = decision.outlet === "desktop" || decision.outlet === "both";
    if (!plan.claim || plan.ledgerFailed) {
      // Never lose a decision request (or a notice meant for the owner now) to the ledger.
      const handled = decision.outlet === "drop" || decision.outlet === "record";
      const fallback =
        plan.ledgerFailed && !handled && (notice.priority === "P0" || decision.outlet === "im");
      if (desktopNow || fallback) this.showDesktop(notice, body);
      if (decision.outlet === "digest" && !plan.ledgerFailed) this.scheduleDigest();
      return;
    }
    if (desktopNow) this.showDesktop(notice, body);
    const { channel, key } = plan.claim;
    const sent = await this.sendIm(
      plan.recordId!,
      channel,
      key,
      imTarget(notice.target, channel),
      body,
    );
    if (!sent && !desktopNow) this.showDesktop(notice, body);
  }

  /** One IM attempt on a claimed record; a failure leaves it queued for the channel. */
  private async sendIm(
    id: string,
    channel: string,
    key: string,
    target: NoticeTarget,
    body: string,
  ): Promise<boolean> {
    const idempotent = this.options.supportsIdempotentSend?.(channel) === true;
    let result: NoticeImSendResult;
    try {
      result = this.options.outlets
        ? await this.options.outlets.im(channel, target, body, idempotent ? key : undefined)
        : { accepted: false, error: "no-im-outlet" };
    } catch (error) {
      result = { accepted: false, error: errorText(error) };
    }
    if (result.accepted) {
      await this.settleQuietly(id, "accepted");
      return true;
    }
    this.log("pet.notice.im_failed", { channel, error: result.error });
    await this.settleQuietly(id, "failed", result.error);
    await this.settleQuietly(id, "queued", result.error);
    return false;
  }

  private async recoverClaim(record: NoticeRecord): Promise<void> {
    const ledger = this.options.ledger!;
    const channel = record.delivery?.channel;
    const body = record.body ?? "";
    const notice = noticeFromRecord(record);
    if (channel && body && this.options.supportsIdempotentSend?.(channel) === true) {
      try {
        const { key } = await ledger.claim(record.id, channel, body);
        const sent = await this.sendIm(
          record.id,
          channel,
          key,
          imTarget(notice.target, channel),
          body,
        );
        if (!sent) this.showDesktop(notice, body);
      } catch (error) {
        this.log("pet.notice.resend_failed", { error: errorText(error) });
        this.showDesktop(notice, body);
      }
      return;
    }
    await this.settleQuietly(record.id, "unknown");
    this.showDesktop(notice, `可能已发送：${body || composeNoticeBody(notice.kind, notice.facts)}`);
  }

  private staleReason(record: NoticeRecord, now: number): string | undefined {
    if (record.expiresAt !== undefined && record.expiresAt <= now) return "expired";
    const { sessionId, requestId } = record;
    if (
      sessionId &&
      requestId &&
      this.options.isDecisionStillPending &&
      !this.options.isDecisionStillPending(sessionId, requestId)
    )
      return "resolved";
    if (
      sessionId &&
      (record.kind === "session.done" || record.kind === "session.failed") &&
      this.options.wasSessionViewedSince?.(sessionId, record.createdAt) === true
    )
      return "viewed";
    return undefined;
  }

  private scheduleDigest(): void {
    if (!this.disposed) this.digest?.schedule();
  }

  private async settleQuietly(
    id: string,
    status: Parameters<NoticeLedgerPort["settle"]>[1],
    error?: string,
  ): Promise<void> {
    try {
      await this.options.ledger?.settle(id, status, error);
    } catch (failure) {
      this.log("pet.notice.settle_failed", { status, error: errorText(failure) });
    }
  }

  private showDesktop(notice: NoticeSubmission, body: string): void {
    try {
      this.options.outlets?.desktop(notice, body);
    } catch (error) {
      this.log("pet.notice.desktop_failed", { kind: notice.kind, error: errorText(error) });
    }
  }

  private emit(event: PetAttentionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Compatibility name for the attention-only API; new code uses {@link PetNoticeRouter}. */
export { PetNoticeRouter as PetAttentionPolicy };
