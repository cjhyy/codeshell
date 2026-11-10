import { createHash } from "node:crypto";
import { USER_DECISION_TIMEOUT_MS } from "@cjhyy/code-shell-core/internal";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { NoticeAttention, NoticeChannel } from "@cjhyy/code-shell-pet/protocol";
import type { DeliveryPlanEntry } from "./pet-delivery-plan.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator.js";
import type {
  PetChatControlRequest,
  SessionRouteControlRequest,
} from "../im-gateway-control-server.js";
import {
  canReply,
  choices,
  entrySource,
  expiredNotice,
  questionBody,
  questionNotice,
  shortReplies,
  skippableEnvelope,
  type ExpirySource,
  type PromptMoment,
} from "./pet-im-decision-text.js";
import { KeyedTimers } from "./pet-notice-timers.js";
import { isPromptEnded, type NoticeDecisionPromptPatch } from "./pet-notice-ledger.js";
import type { RouteDecision } from "./pet-notice-policy.js";
import type {
  DecisionPromptRecord,
  NoticeDecisionPrompts,
  NoticeSubmitResult,
  NoticeTarget,
} from "./pet-notice-types.js";

type Decision = { approved: boolean; answer?: string; reason?: string; failure?: "timed_out" };
interface Envelope {
  sessionId: string;
  requestId: string;
  connectionId?: string;
  generation?: number;
  expiresAt?: number;
  request: { toolName: string; description?: string; args: Record<string, unknown> };
}
/** Where one decision's prompt is routed, and so who may answer it. */
export interface ImDecisionDelivery {
  /** Notice rules that asked to hear about this Session blocking. */
  ruleIds: string[];
  attention: NoticeAttention;
  channel: NoticeChannel;
  /** A route is the conversation answers must come from; owner = the owner's direct chats. */
  target: NoticeTarget;
  /** Only the all-sessions system rule matched: prompt only while the owner is away. */
  requiresAway?: boolean;
  /** The owner started this task from that IM conversation: it is answered there. */
  reply: boolean;
}

/**
 * Where a pending decision in a Session is prompted, as the delivery plan
 * resolves it (`PetDeliveryResolver.planBlocked`): the IM conversation that
 * started the Session's active long task, else the Session's active
 * blocked-watching notice rules. Undefined keeps the decision on the desktop.
 */
export type ImDecisionDeliveryResolver = (
  sessionId: string,
  task: PetLongTask | undefined,
) => DeliveryPlanEntry | undefined;

export interface ImDecision {
  code: string;
  createdAt: number;
  expiresAt?: number;
  /** The Session's title, for the notice's facts. */
  title?: string;
  /** The active long task that owns this Session, when there is one. */
  task?: PetLongTask;
  envelope: Envelope;
  delivery: ImDecisionDelivery;
}

/** First-route reasons that mean "kept on the desktop only because the owner was there". */
const ESCALATING_REASONS: ReadonlySet<string> = new Set([
  "present-desktop",
  "requires-away-present",
]);
/** Not worth prompting over IM with less than this left before the deadline. */
const ESCALATION_MIN_LEFT_MS = 60_000;

/**
 * Join only live, user-visible worker requests to where they are answered.
 * Where that is comes from the delivery plan (`deliveryFor`), the same source
 * every other notice about the Session uses; a decision the plan has no entry
 * for stays desktop-only.
 */
export function collectImDecisions(
  snapshot: DesktopPetProjectionSnapshot,
  tasks: readonly PetLongTask[],
  lines: readonly string[],
  deliveryFor: ImDecisionDeliveryResolver,
): ImDecision[] {
  const envelopes = new Map<string, Envelope>();
  for (const line of lines) {
    try {
      const frame = JSON.parse(line);
      const env = frame.params as Envelope;
      if (frame.method === "agent/approvalRequest" && env?.request?.args && env.requestId) {
        envelopes.set(`${env.sessionId}\0${env.requestId}`, env);
      }
    } catch {
      /* Ignore unrelated/malformed transport frames. */
    }
  }
  const result: ImDecision[] = [];
  for (const pending of snapshot.pending) {
    if (pending.status !== "pending") continue;
    const task = tasks.find(
      (entry) =>
        entry.sessionId === pending.agentSessionId &&
        !["completed", "failed", "cancelled"].includes(entry.status),
    );
    const entry = deliveryFor(pending.agentSessionId, task);
    if (!entry) continue;
    const delivery: ImDecisionDelivery = {
      ruleIds: entry.ruleIds,
      attention: entry.attention,
      channel: entry.channel,
      target: entry.target,
      ...(entry.requiresAway ? { requiresAway: true } : {}),
      reply: entry.reply,
    };
    const envelope = envelopes.get(`${pending.agentSessionId}\0${pending.requestId}`);
    if (!envelope || envelope.generation !== pending.routeGeneration) continue;
    // Bind the code to this worker and request, never a mutable "current task".
    const code = createHash("sha256")
      .update(
        JSON.stringify([
          pending.workerGeneration,
          envelope.connectionId,
          envelope.generation,
          envelope.sessionId,
          envelope.requestId,
        ]),
      )
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();
    const title = snapshot.sessions.find(
      (session) => session.agentSessionId === pending.agentSessionId,
    )?.title;
    result.push({
      code,
      createdAt: pending.createdAt,
      ...(title ? { title } : {}),
      delivery,
      ...(task ? { task } : {}),
      // A model question's live envelope owns its deadline: keeping it open
      // republishes the request without one, while observer metadata lags.
      expiresAt: skippableEnvelope(envelope)
        ? envelope.expiresAt
        : (envelope.expiresAt ?? pending.expiresAt),
      task,
      envelope,
    });
  }
  return result;
}

/** The channel a submitted notice went out on over IM, if it did. */
function imChannel(decision: RouteDecision | undefined): string | undefined {
  return decision && (decision.outlet === "im" || decision.outlet === "both")
    ? decision.im
    : undefined;
}

function decisionKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`;
}

/**
 * A look over every decision even without an event, for events that were
 * missed (an envelope that arrived after its grace timer, a long task that
 * changed where a prompt goes). Everything time-critical has its own trigger.
 */
const SAFETY_SWEEP_MS = 60_000;
/**
 * A decision past its grace whose first prompt has no record yet (the ledger
 * write failed) is tried again this soon, doubling per failed try up to the cap.
 */
const UNRECORDED_RETRY_MS = 3_000;
const UNRECORDED_RETRY_MAX_MS = 60_000;

export interface PetImDecisionsOptions {
  read: () => ImDecision[];
  approve: (entry: ImDecision, decision: Decision) => Promise<void>;
  /** Drop a model question's auto-resolve deadline (回答 码 等待). */
  keepWaiting?: (entry: ImDecision) => Promise<void>;
  /**
   * The notice router: it decides whether a prompt goes to IM at all
   * (presence, the all-sessions rule's "only while away", P0 caps) and where,
   * and its ledger record of the first prompt holds the prompt's lifecycle.
   */
  router: NoticeDecisionPrompts;
  /** A direct chat that belongs to the owner, for owner-targeted prompts. */
  isOwnerConversation?: (origin: { channel: string; target: string; senderId?: string }) => boolean;
  /** The owner target on this channel is a confirmed private chat. */
  ownerChannelIsDirect?: (channel: string) => boolean;
  /** The owner left the computer: a prompt kept on the desktop may now go to IM. */
  isAway?: () => boolean;
  /** The projection's status of a decision ("expired" = Core's deadline fired). */
  decisionStatus?: (sessionId: string, requestId: string) => string | undefined;
  /**
   * The projection reflects a live worker now. A failed snapshot reads as
   * "disconnected" and empties the pending list while the worker may well be
   * alive, so a decision missing from such a snapshot has not ended.
   */
  projectionLive?: () => boolean;
  /** The worker is really gone (reclaimed, or no live worker): its requests are cancelled. */
  workerGone?: () => boolean;
  /** Pending-decision projection events: a decision appeared or ended, the worker reset. */
  projection?: { subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void };
  /** Other moments worth a look now (a rule started watching a blocked Session). */
  nudges?: ReadonlyArray<(listener: () => void) => () => void>;
  /** Presence flips; subscribed only while a prompt waits for the owner to leave. */
  onAwayChange?: (listener: () => void) => () => void;
  onError: (error: unknown) => void;
  now?: () => number;
  graceMs?: number;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  /** The safety sweep's period (default 60 s); 0 turns it off. */
  sweepMs?: number;
}

/**
 * Deterministic IM reply handling; no model may infer or manufacture consent.
 *
 * This is the only source of IM prompts for pending decisions: after a grace
 * period each prompt (with its reply code) is submitted to the notice router,
 * which decides whether it goes to IM at all and where. A prompt the router
 * kept on the desktop is never sent; its code is never shown, so it cannot be
 * answered from IM.
 *
 * Where a prompt stands lives on its ledger record (`NoticeDecisionPrompt`),
 * so a restart picks up from there. This class only turns pending decisions
 * into submissions, parses IM replies into decisions, and applies answers.
 * It looks again when something can change the answer: a pending-decision
 * projection event, a nudge (a rule now watches the Session), the owner
 * leaving, or a prompt's own timer (its grace end, then its deadline).
 */
export class PetImDecisions {
  private started = false;
  private running?: Promise<void>;
  private rescan = false;
  /** Codes being answered or auto-denied right now (one submission each). */
  private readonly answering = new Set<string>();
  /** Failed first-prompt tries per code while its record could not be written. */
  private readonly unrecordedTries = new Map<string, number>();
  /** One timer per decision: its grace end, then its deadline. */
  private readonly wakes: KeyedTimers;
  private readonly unsubscribe: Array<() => void> = [];
  private unsubscribeAway?: () => void;
  private sweep?: ReturnType<typeof setInterval>;

  constructor(private readonly options: PetImDecisionsOptions) {
    this.wakes = new KeyedTimers(
      () => void this.scan(),
      () => this.now(),
      options,
    );
  }

  private get router(): NoticeDecisionPrompts {
    return this.options.router;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const projection = this.options.projection;
    if (projection) this.unsubscribe.push(projection.subscribe((event) => this.observe(event)));
    for (const nudge of this.options.nudges ?? [])
      this.unsubscribe.push(nudge(() => this.scanNow()));
    const sweepMs = this.options.sweepMs ?? SAFETY_SWEEP_MS;
    if (sweepMs > 0) {
      this.sweep = setInterval(() => void this.scan(), sweepMs);
      this.sweep.unref?.();
    }
    void this.scan();
  }

  stop(): void {
    this.started = false;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.unsubscribeAway?.();
    this.unsubscribeAway = undefined;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    this.wakes.clearAll();
  }

  /** Something may have changed: look now instead of at the next timer. */
  scanNow(): void {
    if (!this.started) return;
    void this.scan();
  }

  private observe(event: DesktopPetProjectionEvent): void {
    switch (event.kind) {
      case "pending-upsert":
        // Its grace end, even if its envelope (and so its prompt) is not readable yet.
        if (event.pending.status === "pending" && this.started)
          this.wakes.set(
            decisionKey(event.pending.agentSessionId, event.pending.requestId),
            event.pending.createdAt + this.graceMs(),
          );
        else this.wakes.clear(decisionKey(event.pending.agentSessionId, event.pending.requestId));
        break;
      case "pending-remove":
        this.wakes.clear(decisionKey(event.sessionId, event.requestId));
        break;
      case "reset":
      case "worker-state":
        break;
      default:
        return;
    }
    this.scanNow();
  }

  private moment(entry: ImDecision): PromptMoment {
    return {
      end: this.expiresAt(entry),
      now: this.now(),
      answerable: this.canReply(entry.delivery.target),
    };
  }
  private canReply(target: NoticeTarget): boolean {
    return canReply(target, this.options.isOwnerConversation !== undefined);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private graceMs(): number {
    return this.options.graceMs ?? 15_000;
  }
  private expired(entry: ImDecision): boolean {
    return this.now() >= this.expiresAt(entry);
  }
  private expiresAt(entry: ImDecision): number {
    if (Number.isFinite(entry.expiresAt)) return entry.expiresAt!;
    // A model question without a deadline waits until it is answered.
    if (skippableEnvelope(entry.envelope)) return Number.POSITIVE_INFINITY;
    return entry.createdAt + (this.options.timeoutMs ?? USER_DECISION_TIMEOUT_MS);
  }
  private sameOrigin(
    target: NoticeTarget,
    origin: Parameters<PetImDecisions["reply"]>[0]["origin"],
  ): boolean {
    if (!origin || origin.isDirectMessage !== true || !this.canReply(target)) return false;
    if (target.kind === "owner") {
      return (
        this.options.isOwnerConversation?.({
          channel: origin.channel,
          target: origin.target,
          ...(origin.senderId !== undefined ? { senderId: origin.senderId } : {}),
        }) === true
      );
    }
    return (
      origin.channel === target.route.channel &&
      origin.target === target.route.target &&
      origin.senderId === target.route.senderId
    );
  }
  /**
   * A copy accepted on this channel reached a conversation that may answer.
   * An owner target that is not a confirmed private chat got the generic
   * text: nothing there is answerable.
   */
  private answerableOn(target: NoticeTarget, channel: string): boolean {
    return target.kind !== "owner" || this.options.ownerChannelIsDirect?.(channel) === true;
  }

  /** Look over every decision; a call during a look runs one more afterwards. */
  scan(): Promise<void> {
    if (this.running) {
      this.rescan = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rescan = false;
          await this.scanOnce();
        } while (this.rescan);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async scanOnce(): Promise<void> {
    try {
      await this.router.decisionsLoaded();
      const entries = this.options.read();
      const live = new Set(entries.map((entry) => entry.code));
      // Ended prompts matter only while their expiry notice is still owed.
      const open = (prompt: DecisionPromptRecord["prompt"]) =>
        !isPromptEnded(prompt.phase) || prompt.expiryNotice?.sent === false;
      for (const record of this.router.decisionRecords(open)) {
        if (this.answering.has(record.code)) continue;
        try {
          const owed = record.prompt.expiryNotice;
          if (isPromptEnded(record.prompt.phase)) {
            // An expiry notice the router did not take yet (a failure, a restart).
            if (owed && !owed.sent) await this.sendExpiryNotice(record, owed.channel, true);
          } else if (!live.has(record.code)) await this.endVanished(record);
        } catch (error) {
          this.options.onError(error);
        }
      }
      let awaitingAway = false;
      for (const entry of entries) {
        if (this.answering.has(entry.code)) continue;
        try {
          if (this.expired(entry)) {
            await this.expire(entry);
            continue;
          }
          let record = this.router.decisionRecord(entry.code);
          if (record) record = await this.catchUp(entry, record);
          else {
            if (this.now() - entry.createdAt < this.graceMs()) continue;
            await this.promptFirst(entry);
            record = this.router.decisionRecord(entry.code);
            if (!record) continue;
          }
          if (!this.escalates(entry, record)) continue;
          if (this.options.isAway?.() === true) await this.escalate(entry);
          else awaitingAway = true;
        } catch (error) {
          this.options.onError(error);
        }
      }
      this.reschedule(entries);
      this.watchAway(awaitingAway);
    } catch (error) {
      this.options.onError(error);
    }
  }

  private keys(entry: ImDecision): { first: string; away: string } {
    const { sessionId, requestId } = entry.envelope;
    return { first: `${sessionId}:${requestId}`, away: `${sessionId}:${requestId}:away` };
  }

  /** The first prompt: its record starts the lifecycle. */
  private async promptFirst(entry: ImDecision): Promise<void> {
    const end = this.expiresAt(entry);
    const prompt = {
      code: entry.code,
      ...(Number.isFinite(end) ? { deadline: end } : {}),
      ...(skippableEnvelope(entry.envelope) ? { skippable: true as const } : {}),
      replies: shortReplies(entry),
    };
    const { first } = this.keys(entry);
    // Prompted by a build that kept the lifecycle in memory: continue from its record.
    const adopted = await this.router.adoptDecision(
      entry.envelope.sessionId,
      entry.envelope.requestId,
      first,
      prompt,
    );
    if (adopted) {
      await this.catchUp(entry, adopted);
      return;
    }
    const result = await this.router.submitWithOutcome({
      ...questionNotice(entry, first, this.moment(entry)),
      prompt,
    });
    if (!result) return;
    await this.noteSent(entry, result, {});
  }

  /** The one "owner left" re-submission of a prompt that was kept on the desktop. */
  private async escalate(entry: ImDecision): Promise<void> {
    const result = await this.router.submitWithOutcome(
      questionNotice(entry, this.keys(entry).away, this.moment(entry)),
    );
    if (!result) return;
    await this.noteSent(entry, result, { phase: "escalated", escalatedAt: this.now() });
  }

  /** Persist what a submission did: answerable over IM now, or just `patch`. */
  private async noteSent(
    entry: ImDecision,
    result: NoticeSubmitResult,
    patch: NoticeDecisionPromptPatch,
  ): Promise<void> {
    const channel = imChannel(result.decision);
    if (
      channel !== undefined &&
      result.sent === "accepted" &&
      this.answerableOn(entry.delivery.target, channel)
    ) {
      await this.router.updateDecision(entry.code, {
        ...patch,
        phase: "im",
        channel,
        imAt: this.now(),
      });
    } else if (patch.phase !== undefined) await this.router.updateDecision(entry.code, patch);
  }

  /**
   * A copy the router queued (IM was down) or that was sent around a restart
   * may have reached the conversation since: the record catches up.
   */
  private async catchUp(
    entry: ImDecision,
    record: DecisionPromptRecord,
  ): Promise<DecisionPromptRecord> {
    if (record.prompt.phase !== "desktop" && record.prompt.phase !== "escalated") return record;
    for (const copy of record.copies) {
      // Enqueued: the gateway outbox has it and delivers it, like an accepted send.
      if ((copy.status !== "accepted" && copy.status !== "enqueued") || copy.channel === undefined)
        continue;
      if (!this.answerableOn(entry.delivery.target, copy.channel)) continue;
      const patch = { phase: "im" as const, channel: copy.channel, imAt: this.now() };
      return (
        (await this.router.updateDecision(entry.code, patch)) ?? {
          ...record,
          prompt: { ...record.prompt, ...patch },
        }
      );
    }
    return record;
  }

  /**
   * Only a prompt held back because the owner was at the computer escalates;
   * a desktop-only rule, a mute, an unbound channel or the P0 cap never does,
   * and neither does a decision with under a minute left.
   */
  private escalates(entry: ImDecision, record: DecisionPromptRecord): boolean {
    return (
      record.prompt.phase === "desktop" &&
      ESCALATING_REASONS.has(record.decision?.reason ?? "") &&
      this.expiresAt(entry) - this.now() >= ESCALATION_MIN_LEFT_MS
    );
  }

  /** This module's deadline backstop for a decision put to an IM conversation. */
  private async expire(entry: ImDecision): Promise<void> {
    // Core applies a model question's timeout (recommended option or skip).
    if (skippableEnvelope(entry.envelope)) return;
    const found = this.router.decisionRecord(entry.code);
    const record = found ? await this.catchUp(entry, found) : undefined;
    // Answered here already; the projection has not caught up yet.
    if (record && isPromptEnded(record.prompt.phase)) return;
    // Core enforces the same deadline itself; this backstop (and its notice)
    // is only for decisions that were put to an IM conversation.
    const channel =
      (record?.prompt.phase === "im" ? record.prompt.channel : undefined) ??
      (entry.delivery.reply && entry.delivery.target.kind === "route"
        ? entry.delivery.target.route.channel
        : undefined);
    if (channel === undefined) return;
    this.answering.add(entry.code);
    try {
      // Re-read immediately before submitting; cancellation/restart wins.
      if (!this.options.read().some((item) => item.code === entry.code)) return;
      await this.options.approve(entry, {
        approved: false,
        failure: "timed_out",
        reason:
          "IM confirmation timed out without an answer. No permission was granted. Skip the blocked operation and report the limitation; do not retry it or assume consent.",
      });
      if (!record) {
        // No record to owe the notice on (the prompt was never recorded): one attempt.
        await this.sendExpiryNotice(entrySource(entry), channel, false);
        return;
      }
      await this.router.updateDecision(entry.code, {
        phase: "expired",
        endedAt: this.now(),
        expiryNotice: { channel, sent: false },
      });
      await this.sendExpiryNotice(entrySource(entry), channel, true);
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.answering.delete(entry.code);
    }
  }

  /**
   * The decision is no longer pending: it was answered elsewhere, cancelled,
   * or Core's own deadline fired before this module's did. A prompt that
   * reached IM and timed out still tells its conversation.
   */
  private async endVanished(record: DecisionPromptRecord): Promise<void> {
    if (this.options.projectionLive?.() === false) {
      // A worker that missed one heartbeat: nothing is known to have ended.
      if (this.options.workerGone?.() !== true) return;
      // The worker is gone, and its requests with it: no answer, no timeout.
      await this.router.updateDecision(record.code, { phase: "revoked", endedAt: this.now() });
      return;
    }
    const status = this.options.decisionStatus?.(record.sessionId, record.requestId);
    // Still open, just not prompted from here right now.
    if (status === "pending") return;
    const deadline = record.prompt.deadline ?? Number.POSITIVE_INFINITY;
    const timedOut = status === "expired" || (status === undefined && this.now() >= deadline);
    const channel = record.prompt.phase === "im" ? record.prompt.channel : undefined;
    const notify = timedOut && channel !== undefined && record.prompt.skippable !== true;
    await this.router.updateDecision(record.code, {
      phase: timedOut ? "expired" : status === "resolved" ? "answered" : "revoked",
      endedAt: this.now(),
      ...(notify ? { expiryNotice: { channel, sent: false } } : {}),
    });
    if (notify) await this.sendExpiryNotice(record, channel, true);
  }

  private async sendExpiryNotice(
    source: ExpirySource,
    channel: string,
    recorded: boolean,
  ): Promise<void> {
    await this.router.submitWithOutcome(expiredNotice(source, channel));
    if (recorded)
      await this.router.updateDecision(source.code, { expiryNotice: { channel, sent: true } });
  }

  /** Each decision's next moment: the end of its grace, then its deadline. */
  private reschedule(entries: readonly ImDecision[]): void {
    const now = this.now();
    const codes = new Set(entries.map((entry) => entry.code));
    for (const code of this.unrecordedTries.keys())
      if (!codes.has(code)) this.unrecordedTries.delete(code);
    for (const entry of entries) {
      const record = this.router.decisionRecord(entry.code);
      if (record) this.unrecordedTries.delete(entry.code);
      const end = this.expiresAt(entry);
      const graceEnd = entry.createdAt + this.graceMs();
      const due = !record
        ? // Past its grace with no record: the submission failed; try again, backing off.
          graceEnd > now
          ? graceEnd
          : now + this.unrecordedRetryDelay(entry.code)
        : !isPromptEnded(record.prompt.phase) && Number.isFinite(end)
          ? end
          : undefined;
      const key = decisionKey(entry.envelope.sessionId, entry.envelope.requestId);
      if (this.started && due !== undefined && due > now) this.wakes.set(key, due);
    }
  }

  /** 3 s, 6 s, 12 s, … up to 60 s for one code whose record keeps failing. */
  private unrecordedRetryDelay(code: string): number {
    const tries = this.unrecordedTries.get(code) ?? 0;
    this.unrecordedTries.set(code, tries + 1);
    return Math.min(UNRECORDED_RETRY_MS * 2 ** Math.min(tries, 10), UNRECORDED_RETRY_MAX_MS);
  }

  /** Listen for the owner leaving only while some prompt waits for that. */
  private watchAway(wanted: boolean): void {
    if (wanted && !this.unsubscribeAway && this.started && this.options.onAwayChange) {
      this.unsubscribeAway = this.options.onAwayChange(() => this.scanNow());
      // The owner may have left between this look and the subscription.
      if (this.options.isAway?.() === true) this.scanNow();
    } else if (!wanted && this.unsubscribeAway) {
      this.unsubscribeAway();
      this.unsubscribeAway = undefined;
    }
  }

  /** The gateway probes bound Sessions before it reaches the Pet chat endpoint. */
  async replyToSession(
    request: SessionRouteControlRequest,
  ): Promise<{ kind: "status"; text: string } | undefined> {
    const text = await this.reply({ message: request.text, origin: request });
    return text === undefined ? undefined : { kind: "status", text };
  }

  /**
   * Prompts that reached an IM conversation (and so may still get a late bare
   * reply there) stay addressable for 10 minutes past their deadline.
   */
  private recentlyPrompted(): DecisionPromptRecord[] {
    const now = this.now();
    return this.router.decisionRecords((prompt) => {
      if (prompt.channel === undefined || prompt.imAt === undefined) return false;
      return now <= Math.max(prompt.deadline ?? 0, prompt.imAt) + USER_DECISION_TIMEOUT_MS;
    });
  }

  async reply(request: {
    message: string;
    origin?: Pick<
      NonNullable<PetChatControlRequest["origin"]>,
      "channel" | "target" | "senderId" | "isDirectMessage"
    >;
  }): Promise<string | undefined> {
    const message = request.message.trim();
    const match = /^(?:回答|\/decision)\s+([a-f0-9]{12})\s+([\s\S]+)$/iu.exec(message);
    await this.router.decisionsLoaded();
    const entries = this.options.read();
    const origin = request.origin;
    let code: string;
    let answer: string;
    if (match) {
      code = match[1]!.toUpperCase();
      answer = match[2]!.trim();
    } else {
      // Owner prompts reach whichever owner chat the router picked, so a bare
      // reply only counts on the channel the prompt actually went to.
      const delivered = this.recentlyPrompted().filter(
        (record) =>
          this.sameOrigin(record.target, origin) &&
          (record.target.kind === "route" || record.prompt.channel === origin?.channel),
      );
      const matching: ImDecision[] = [];
      for (const item of entries) {
        if (!this.sameOrigin(item.delivery.target, origin)) continue;
        if (item.delivery.target.kind === "route") {
          matching.push(item);
          continue;
        }
        const record = this.router.decisionRecord(item.code);
        const current = record ? await this.catchUp(item, record) : undefined;
        if (current?.prompt.channel !== undefined && current.prompt.channel === origin?.channel)
          matching.push(item);
      }
      const shortReply =
        /^\d+(?:\s*[,，]\s*\d+)*$/u.test(message) ||
        [
          ...matching.flatMap(shortReplies),
          ...delivered.flatMap((record) => record.prompt.replies ?? []),
        ].includes(message);
      if (!shortReply) return undefined;
      const candidates = matching.filter((item) => !this.expired(item));
      if (candidates.length === 0) {
        if (delivered.length === 0 && matching.length === 0) return undefined;
        await this.scan();
        return "这条确认已结束或超时，未采用这条回答。无需进入 Session；如仍需该操作，请重新发起。";
      }
      if (candidates.length > 1) {
        return [
          "当前无法唯一匹配已送达的待确认，请带确认码回答，避免选错任务：",
          ...candidates.map((item) => `回答 ${item.code} <选项编号>`),
        ].join("\n");
      }
      const candidate = candidates[0]!;
      return [
        "单独的编号或选项还没有提交确认。当前待确认内容：",
        questionBody(candidate) ?? "请在电脑查看完整内容。",
        `核对后请回复「回答 ${candidate.code} ${message}」。无需进入 Session。`,
      ].join("\n");
    }
    const entry = entries.find((item) => item.code === code);
    if (!entry || !this.sameOrigin(entry.delivery.target, origin)) {
      return "该确认已结束，或不属于当前私聊。未执行任何操作。";
    }
    if (this.expired(entry)) {
      await this.scan();
      return "该确认已超时，未采用这条回答。";
    }
    if (this.answering.has(code)) return "该确认正在处理，请勿重复提交。";
    if (answer.length > 12_000) return "回答过长，请缩短后重试。";
    const question = skippableEnvelope(entry.envelope);
    // An option literally named 等待/跳过 is an answer, not a command.
    const option = question && choices(entry).includes(answer);
    if (question && !option && ["等待", "一直等"].includes(answer)) {
      if (!Number.isFinite(this.expiresAt(entry))) return `确认 ${code} 已经在一直等待你的回答。`;
      if (!this.options.keepWaiting) return "当前无法改为一直等待，请在电脑上处理。";
      try {
        await this.options.keepWaiting(entry);
        return `确认 ${code} 已改为一直等待，想好后再回复「回答 ${code} 1」等即可。`;
      } catch (error) {
        this.options.onError(error);
        return "没能改为一直等待，可能已在其他端处理。请查看任务状态。";
      }
    }
    const skip = !option && (answer === "拒绝" || (question && answer === "跳过"));
    if (!skip && !questionBody(entry))
      return "请在桌面 Session 查看完整确认内容后处理；也可以回复拒绝。";
    let decision: Decision;
    if (skip)
      // No reason on a model question: Core reports a skip and the model continues.
      decision = question
        ? { approved: false }
        : { approved: false, reason: "User declined via the originating IM conversation" };
    else if (entry.envelope.request.toolName !== "__ask_user__") {
      if (!["1", "2", "允许本次"].includes(answer)) return "请回复选项 1（允许本次）或 2（拒绝）。";
      decision = {
        approved: answer !== "2",
        ...(answer === "2" ? { reason: "User declined via IM" } : {}),
      };
    } else {
      const labels = choices(entry);
      const args = entry.envelope.request.args;
      const indexes = /^\d+(?:\s*[,，]\s*\d+)*$/u.test(answer)
        ? answer.split(/\s*[,，]\s*/u).map(Number)
        : [];
      const valid =
        indexes.length > 0 &&
        indexes.every((index) => index >= 1 && index <= labels.length) &&
        (args.multiSelect === true || indexes.length === 1);
      const mapped = valid ? indexes.map((index) => labels[index - 1]!).join(", ") : answer;
      if (
        labels.length > 0 &&
        ((indexes.length > 0 && !valid) ||
          (args.optionsOnly === true && !valid && !labels.includes(answer)))
      ) {
        return "选项无效，请按确认消息中的编号回答。";
      }
      decision = { approved: true, answer: mapped };
    }
    this.answering.add(code);
    try {
      await this.options.approve(entry, decision);
      const record = this.router.decisionRecord(code);
      if (record && !isPromptEnded(record.prompt.phase))
        await this.router.updateDecision(code, { phase: "answered", endedAt: this.now() });
      return `确认 ${code} 已处理${decision.approved ? "，回答已交给原任务" : question ? "，已跳过这个问题" : "，本次操作未授权"}。`;
    } catch (error) {
      this.options.onError(error);
      return "确认未提交成功，可能已在其他端处理。请查看任务状态后重试。";
    } finally {
      this.answering.delete(code);
    }
  }
}

type WorkerRequest = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  options: { meta: { origin: "host"; producer: string } },
) => Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;

/** Worker-side effects of an IM decision, kept out of the composition root. */
export function imDecisionWorkerActions(
  requestWorker: WorkerRequest,
  broadcastResolved: (params: {
    sessionId: string;
    requestId: string;
    connectionId?: string;
    generation?: number;
    approved: boolean;
    answer?: string;
  }) => void,
): Pick<PetImDecisionsOptions, "approve" | "keepWaiting"> {
  const send = async (method: string, params: Record<string, unknown>, producer: string) => {
    const outcome = await requestWorker(method, params, 15_000, {
      meta: { origin: "host", producer },
    });
    if (!outcome.ok) throw new Error(outcome.message);
  };
  return {
    approve: async (entry, decision) => {
      const { request: _request, expiresAt: _expiresAt, ...route } = entry.envelope;
      await send("agent/approve", { ...route, decision }, "pet-im-decision");
      broadcastResolved({ ...route, approved: decision.approved, answer: decision.answer });
    },
    keepWaiting: async (entry) => {
      const { request: _request, expiresAt: _expiresAt, ...route } = entry.envelope;
      await send("agent/approvalKeepWaiting", route, "pet-im-keep-waiting");
    },
  };
}
