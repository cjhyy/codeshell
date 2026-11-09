import { dlog } from "../desktop-logger.js";
import { composeNoticeBody, MAX_NOTICE_BODY, noticeLine } from "./pet-notice-compose.js";
import { NoticeDigest } from "./pet-notice-digest.js";
import type { NoticeRecord, NoticeSettleStatus } from "./pet-notice-ledger.js";
import {
  hostTimezoneOffsetMin,
  route,
  type DedupeLookup,
  type ImReadiness,
  type RouteDecision,
} from "./pet-notice-policy.js";
import {
  errorText,
  imTarget,
  matchesConversation,
  noticeFromRecord,
  normalizeSettings,
  pinToRoute,
  IM_SEND_TIMEOUT,
  sendWithTimeout,
  staleReason,
  unpackFacts,
  type NoticeConversation,
  type NoticeImPayload,
  type NoticeRouterSettings,
  type NoticeSubmission,
  type NoticeTarget,
  type PetAttentionEvent,
  type PetAttentionSnapshot,
  type PetNoticeRouterOptions,
  type PetPeek,
  type ReplayedNotice,
} from "./pet-notice-types.js";
import type {
  DesktopPendingDecision,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator.js";

export type * from "./pet-notice-types.js";

const DEFAULT_IM_TIMEOUT_MS = 30_000;
const DEFAULT_REPLAY_HOLD_MS = 10 * 60_000;
const MAX_RULE_IDS = 100;
const NO_KEYS: DedupeLookup = { has: () => false };
const DISPOSED: RouteDecision = { outlet: "drop", reason: "disposed" };

function payloadOf(notice: NoticeSubmission): NoticeImPayload {
  return { kind: notice.kind, ...(notice.media ? { media: notice.media } : {}) };
}

interface NoticePlan {
  decision: RouteDecision;
  /** Show on the desktop even though the decision is not desktop/both (P0 held, merged `both`). */
  alsoDesktop: boolean;
  recordId?: string;
  claim?: { channel: string; key: string };
  /** The decision could not be recorded or claimed; only desktop delivery is safe. */
  ledgerFailed: boolean;
}

function receiptKey(pending: DesktopPendingDecision): string {
  return `local-user\u0000${pending.agentSessionId}\u0000${pending.requestId}\u0000pending`;
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
  /** Records this process is sending right now; startup recovery must not resend them. */
  private readonly sending = new Set<string>();
  /** Records handed to a turn by replayPending (→ when), not yet marked or released. */
  private readonly replaying = new Map<string, number>();
  private decisionQueue: Promise<unknown> = Promise.resolve();
  private recovered?: Promise<void>;
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
        unpack: (record) => unpackFacts(record.facts),
        submit: (digest) =>
          this.submit({
            kind: "digest",
            priority: "P2",
            dedupeKey: digest.dedupeKey,
            ruleIds: digest.ruleIds,
            facts: { title: "你不在时", summary: `${digest.count} 条` },
            attention: "always",
            channel: "auto",
            target: digest.target,
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
    if (this.disposed) return DISPOSED;
    if (this.recovered) await this.recovered;
    if (this.disposed) return DISPOSED;
    const body = composeNoticeBody(notice.kind, notice.facts, notice.body);
    const plan = await this.serially(() => this.plan(notice, body));
    await this.deliver(notice, body, plan);
    return plan.decision;
  }

  /**
   * After a restart, once (later calls share the first run): resend young
   * claims on channels that collapse duplicates (same key, same body), mark
   * the rest `unknown` with a desktop note, expire stale queued notices, and
   * re-arm the digest. Never passes `manualRetry`; skips claims this process
   * is sending itself.
   */
  recover(): Promise<void> {
    this.recovered ??= this.runRecover();
    return this.recovered;
  }

  /**
   * Queued notices for the owner's next inbound message on `channel` in
   * `conversation`. Stale ones (decision resolved, expired, already seen on
   * the desktop) are revoked. The rest stay queued and are withheld from
   * other calls for `replayHoldMs` (default 10 min).
   *
   * Contract: once the notices are in Mimi's turn the caller calls
   * {@link markReplayed} with their ids (they are revoked for good); if the
   * turn did not take them it calls {@link releaseReplay} so the next inbound
   * message gets them. A caller that does neither (it crashed, the turn was
   * lost) has its hold expire, so a notice is never stuck behind it.
   */
  async replayPending(
    channel: string,
    conversation: NoticeConversation,
  ): Promise<ReplayedNotice[]> {
    const ledger = this.options.ledger;
    if (!ledger || this.disposed) return [];
    if (this.recovered) await this.recovered;
    const now = this.now();
    try {
      await ledger.expireQueued(now);
    } catch (error) {
      this.log("pet.notice.expire_failed", { error: errorText(error) });
    }
    const holdMs = this.options.replayHoldMs ?? DEFAULT_REPLAY_HOLD_MS;
    for (const [id, at] of this.replaying) if (now - at >= holdMs) this.replaying.delete(id);
    const replay: ReplayedNotice[] = [];
    const resend: NoticeRecord[] = [];
    for (const record of ledger.queued()) {
      if (record.delivery?.channel !== channel || this.replaying.has(record.id)) continue;
      const { facts, target, media } = unpackFacts(record.facts);
      // Route notices live in the gateway outbox, never in this queue's replay.
      if (target.kind === "route") continue;
      if (!matchesConversation(target, channel, conversation)) continue;
      const stale = staleReason(record, now, this.options);
      if (stale) {
        await this.settleQuietly(record.id, "revoked", stale);
        continue;
      }
      if (media) {
        // Files cannot ride a turn's text context: the owner is back on this
        // channel, so send the notice itself.
        this.replaying.set(record.id, now);
        resend.push(record);
        continue;
      }
      this.replaying.set(record.id, now);
      const title = noticeLine(facts.title);
      replay.push({
        id: record.id,
        kind: record.kind,
        ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
        ...(title !== undefined ? { title } : {}),
        body: (record.body ?? composeNoticeBody(record.kind, facts)).slice(0, MAX_NOTICE_BODY),
      });
    }
    for (const record of resend) {
      await this.resendQueued(record, channel);
      this.replaying.delete(record.id);
    }
    return replay;
  }

  /** Send one queued notice now (same record, so the same key and payload). */
  private async resendQueued(record: NoticeRecord, channel: string): Promise<void> {
    const ledger = this.options.ledger!;
    const notice = noticeFromRecord(record);
    const body = record.body ?? composeNoticeBody(notice.kind, notice.facts);
    this.sending.add(record.id);
    try {
      const { key } = await ledger.claim(record.id, channel, body);
      const outcome = await this.sendIm(
        record.id,
        channel,
        key,
        imTarget(notice.target, channel),
        body,
        payloadOf(notice),
      );
      if (outcome !== "accepted") this.log("pet.notice.resend_failed", { kind: record.kind });
    } catch (error) {
      this.sending.delete(record.id);
      this.log("pet.notice.resend_failed", { kind: record.kind, error: errorText(error) });
    }
  }

  /** The replayed notices reached Mimi's turn; settle them for good. */
  async markReplayed(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.settleQuietly(id, "revoked", "replayed-in-turn");
      this.replaying.delete(id);
    }
  }

  /**
   * A pending decision was resolved (or timed out): revoke its notices that
   * still wait for a channel or the digest, so they are never replayed later.
   */
  async revokeDecision(sessionId: string, requestId: string, reason = "resolved"): Promise<void> {
    const ledger = this.options.ledger;
    if (!ledger || this.disposed) return;
    try {
      await ledger.load();
    } catch (error) {
      this.log("pet.notice.ledger_read_failed", { error: errorText(error) });
      return;
    }
    for (const record of [...ledger.queued(), ...ledger.held()]) {
      if (record.sessionId !== sessionId || record.requestId !== requestId) continue;
      if (this.sending.has(record.id)) continue;
      await this.settleQuietly(record.id, "revoked", reason);
    }
  }

  /** The turn did not take them after all; let the next inbound message replay them. */
  releaseReplay(ids: readonly string[]): void {
    for (const id of ids) this.replaying.delete(id);
  }

  /** Send the held notices as digests if sending is allowed now; otherwise re-arm. */
  async flushDigest(): Promise<void> {
    if (this.recovered) await this.recovered;
    await this.digest?.flush();
  }

  /** New submissions are dropped; in-flight sends still settle but show nothing. */
  dispose(): void {
    this.disposed = true;
    this.digest?.dispose();
    this.stop();
  }

  private async runRecover(): Promise<void> {
    const ledger = this.options.ledger;
    if (!ledger || this.disposed) return;
    const now = this.now();
    let resend: NoticeRecord[];
    try {
      resend = await ledger.recoverOnStartup(now);
    } catch (error) {
      this.log("pet.notice.recover_failed", { error: errorText(error) });
      return;
    }
    for (const record of resend) {
      await this.recoverClaim(record);
    }
    try {
      await ledger.expireQueued(now);
    } catch (error) {
      this.log("pet.notice.expire_failed", { error: errorText(error) });
    }
    if (!this.disposed) this.digest?.schedule();
  }

  private serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.decisionQueue.then(task);
    this.decisionQueue = run.catch(() => undefined);
    return run;
  }

  private settings(): Required<NoticeRouterSettings> {
    try {
      return normalizeSettings(this.options.settings?.());
    } catch (error) {
      this.log("pet.notice.settings_failed", { error: errorText(error) });
      return normalizeSettings(undefined);
    }
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
    const { decision, alsoDesktop } = this.decide(notice, counts, seen, now);
    const plan: NoticePlan = { decision, alsoDesktop, ledgerFailed: true };
    if (!ledger || !ledgerReady) return plan;

    try {
      const record = await ledger.record({
        kind: notice.kind,
        priority: notice.priority,
        dedupeKey: notice.dedupeKey,
        ...(notice.sessionId !== undefined ? { sessionId: notice.sessionId } : {}),
        ...(notice.requestId !== undefined ? { requestId: notice.requestId } : {}),
        ...(notice.expiresAt !== undefined ? { expiresAt: notice.expiresAt } : {}),
        ruleIds: notice.ruleIds.slice(0, MAX_RULE_IDS),
        facts: {
          ...notice.facts,
          target: notice.target,
          ...(notice.media ? { media: notice.media } : {}),
        },
        body,
        decision,
      });
      plan.recordId = record.id;
    } catch (error) {
      this.log("pet.notice.record_failed", { kind: notice.kind, error: errorText(error) });
      return plan;
    }
    if ((decision.outlet !== "im" && decision.outlet !== "both") || !decision.im)
      return { ...plan, ledgerFailed: false };
    // Registered before the claim lands, so a concurrent recovery never sees it as orphaned.
    this.sending.add(plan.recordId);
    try {
      const { key } = await ledger.claim(plan.recordId, decision.im, body);
      if (notice.sessionId) this.lastImSendAt.set(notice.sessionId, now);
      return { ...plan, claim: { channel: decision.im, key }, ledgerFailed: false };
    } catch (error) {
      this.sending.delete(plan.recordId);
      this.log("pet.notice.claim_failed", { kind: notice.kind, error: errorText(error) });
      return plan;
    }
  }

  private decide(
    notice: NoticeSubmission,
    counts: { sent: number; p0Sent: number },
    seen: DedupeLookup,
    now: number,
  ): { decision: RouteDecision; alsoDesktop: boolean } {
    const settings = this.settings();
    const imReady: Record<string, ImReadiness> = { ...(this.options.imChannels?.() ?? {}) };
    const routeChannel = notice.target.kind === "route" ? notice.target.route.channel : undefined;
    const pinned = routeChannel !== undefined && notice.channel !== "desktop";
    let channel = notice.channel;
    let lastInbound = this.options.lastInboundChannel?.();
    if (pinned) {
      // The conversation the owner used is the channel. Its gateway outbox is
      // durable and delivers once the channel is back, so it is always usable.
      imReady[routeChannel] = "ready";
      if (channel === "auto") lastInbound = routeChannel;
      else channel = routeChannel;
    }
    const immediate = notice.reply === true || notice.media !== undefined;
    let decision = route(
      {
        priority: notice.priority,
        dedupeKey: notice.dedupeKey,
        attention: notice.attention,
        channel,
        ...(notice.requiresAway ? { requiresAway: true } : {}),
        ...(immediate ? { immediate: true } : {}),
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
      notice.boundReplyDelivered === true &&
      (decision.outlet === "im" ||
        decision.outlet === "both" ||
        decision.outlet === "digest" ||
        decision.queued === true)
    )
      decision = { outlet: "desktop", reason: "bound-reply-delivered" };
    // Files are never folded into a one-line digest entry.
    if (notice.media && decision.outlet === "digest")
      decision = { outlet: "desktop", reason: "media-not-digested" };
    // A decision request held by the P0 cap still has to be in front of the owner.
    let alsoDesktop = notice.priority === "P0" && decision.outlet === "digest";
    if (
      notice.priority === "P1" &&
      !immediate &&
      notice.sessionId &&
      (decision.outlet === "im" || decision.outlet === "both")
    ) {
      const last = this.lastImSendAt.get(notice.sessionId);
      if (last !== undefined && now - last < settings.mergeWindowSec * 1_000) {
        // Merging only spares the IM; a named-channel notice still shows on the desktop.
        alsoDesktop = decision.outlet === "both";
        decision = { outlet: "digest", reason: "merge-window" };
      }
    }
    return { decision, alsoDesktop };
  }

  private async deliver(notice: NoticeSubmission, body: string, plan: NoticePlan): Promise<void> {
    const { decision } = plan;
    const desktopNow =
      decision.outlet === "desktop" || decision.outlet === "both" || plan.alsoDesktop;
    if (!plan.claim || plan.ledgerFailed) {
      // Never lose a decision request (or a notice meant for the owner now) to the ledger.
      const handled = decision.outlet === "drop" || decision.outlet === "record";
      const fallback =
        plan.ledgerFailed && !handled && (notice.priority === "P0" || decision.outlet === "im");
      if (desktopNow || fallback) this.showDesktop(notice, body);
      else if (plan.ledgerFailed && !handled)
        this.log("pet.notice.lost", { kind: notice.kind, priority: notice.priority });
      if (decision.outlet === "digest" && !plan.ledgerFailed && !this.disposed)
        this.digest?.schedule();
      return;
    }
    if (desktopNow) this.showDesktop(notice, body);
    const { channel, key } = plan.claim;
    const target = imTarget(notice.target, channel);
    const outcome = await this.sendIm(
      plan.recordId!,
      channel,
      key,
      target,
      body,
      payloadOf(notice),
    );
    if (outcome !== "accepted" && !desktopNow) this.showOutcome(notice, body, outcome);
  }

  /** A failed send shows the notice; a send that may have gone out says so. */
  private showOutcome(notice: NoticeSubmission, body: string, outcome: "failed" | "unknown"): void {
    this.showDesktop(notice, outcome === "unknown" ? `可能已发送：${body}` : body);
  }

  /**
   * One IM attempt on a claimed record. A failure leaves an owner notice
   * queued for the channel; a route notice (whose durable queue is the
   * gateway outbox itself) just fails, and the caller shows it on the desktop.
   * A timeout on a channel without idempotent sends may already have reached
   * the owner, so it becomes `unknown` and is never resent automatically; with
   * idempotent sends (and every route publish, keyed by the claim key) the
   * same key makes a resend safe.
   */
  private async sendIm(
    id: string,
    channel: string,
    key: string,
    target: NoticeTarget,
    body: string,
    payload: NoticeImPayload,
  ): Promise<"accepted" | "failed" | "unknown"> {
    this.sending.add(id);
    try {
      const idempotent = this.isIdempotent(channel, target);
      const result = await sendWithTimeout(
        () =>
          this.options.outlets?.im(channel, target, body, idempotent ? key : undefined, payload),
        this.options.imTimeoutMs ?? DEFAULT_IM_TIMEOUT_MS,
        this.schedule,
        this.cancel,
      );
      if (result.accepted) {
        await this.settleQuietly(id, "accepted");
        return "accepted";
      }
      this.log("pet.notice.im_failed", { channel, error: result.error });
      if (result.error === IM_SEND_TIMEOUT && !idempotent) {
        await this.settleQuietly(id, "unknown", result.error);
        return "unknown";
      }
      await this.settleQuietly(id, "failed", result.error);
      if (target.kind !== "route") await this.settleQuietly(id, "queued", result.error);
      return "failed";
    } finally {
      this.sending.delete(id);
    }
  }

  private isIdempotent(channel: string, target: NoticeTarget): boolean {
    return target.kind === "route" || this.options.supportsIdempotentSend?.(channel) === true;
  }

  private async recoverClaim(record: NoticeRecord): Promise<void> {
    const ledger = this.options.ledger!;
    // The snapshot may be stale: a send of this process may have started or
    // settled it while earlier records were being recovered.
    const current = ledger.get(record.id)?.delivery;
    if (
      this.sending.has(record.id) ||
      current?.status !== "claimed" ||
      current.claimedAt !== record.delivery?.claimedAt
    )
      return;
    const channel = record.delivery?.channel;
    const body = record.body ?? "";
    const notice = noticeFromRecord(record);
    if (channel && body && this.isIdempotent(channel, imTarget(notice.target, channel))) {
      try {
        const { key } = await ledger.claim(record.id, channel, body);
        const target = imTarget(notice.target, channel);
        const outcome = await this.sendIm(record.id, channel, key, target, body, payloadOf(notice));
        if (outcome !== "accepted") this.showOutcome(notice, body, outcome);
      } catch (error) {
        this.log("pet.notice.resend_failed", { error: errorText(error) });
        this.showDesktop(notice, body);
      }
      return;
    }
    await this.settleQuietly(record.id, "unknown");
    this.showDesktop(notice, `可能已发送：${body || composeNoticeBody(notice.kind, notice.facts)}`);
  }

  private async settleQuietly(
    id: string,
    status: NoticeSettleStatus,
    error?: string,
  ): Promise<void> {
    try {
      await this.options.ledger?.settle(id, status, error);
    } catch (failure) {
      this.log("pet.notice.settle_failed", { status, error: errorText(failure) });
    }
  }

  private showDesktop(notice: NoticeSubmission, body: string): void {
    if (this.disposed) return;
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
