import {
  ruleDelivery,
  type DeliveryPlanEntry,
  type DeliveryQuery,
  type PetDeliveryResolver,
} from "./pet-delivery-plan.js";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { NoticeRule, NoticeRuleState, PetRuleStore } from "./pet-rule-store.js";
import type { DesktopPendingDecision, DesktopPetProjectionEvent } from "./pet-state-aggregator.js";
import type { ChangedFiles } from "./pet-notice-action-codes.js";
import type { SessionBlockReason, SessionOutcome } from "./session-outcome.js";

export interface NoticeDraftOption {
  label: string;
  recommended?: boolean;
}

export interface NoticeDraft {
  kind: "session.done" | "session.failed" | "session.blocked";
  priority: "P0" | "P1";
  dedupeKey: string;
  sessionId: string;
  /**
   * Who this draft is for and how it reaches them, from the delivery plan:
   * address, the rules it satisfies, and whether the owner must be away.
   */
  delivery: DeliveryPlanEntry;
  requestId?: string;
  expiresAt?: number;
  facts: {
    title?: string;
    summary?: string;
    error?: string;
    question?: string;
    options?: NoticeDraftOption[];
  };
  /** What a reply code needs about the outcome (pet-notice-action-codes.ts); never shown. */
  context?: {
    /** blocked: why the Session stopped, and the Goal that stopped it. */
    reason?: SessionBlockReason;
    goalId?: string;
    revision?: number;
    /** done: the files the turn changed. */
    changedFiles?: ChangedFiles;
  };
}

export interface PetSessionRuleWatcherOptions {
  /** Rule lifecycle only (spend, cancel); who is told comes from `deliveries`. */
  rules: Pick<PetRuleStore, "activeForSession" | "update">;
  /**
   * Who must be told about an outcome. A run whose plan is reported by the
   * long-task closure is left to it; the watcher reports the rest.
   */
  deliveries: Pick<PetDeliveryResolver, "plan">;
  onNotice: (draft: NoticeDraft) => void;
  /** Queued user messages or running background / sub-agent work. */
  isSessionBusy: (sessionId: string) => boolean;
  /** False for Mimi's own Session, child Sessions and hidden kinds. */
  isEligibleSession: (sessionId: string) => boolean;
  /**
   * A pending decision in a Session a blocked rule watches. The IM decision
   * module owns the prompt (with its reply code), so the watcher never emits a
   * blocked draft for it: one source, no duplicates.
   */
  onPendingDecision: (sessionId: string, pending: DesktopPendingDecision) => void;
  /** The Session's Goal was cleared (after its goal rules were cancelled). */
  onGoalCleared?: (sessionId: string) => Promise<void> | void;
  sessionTitle?: (sessionId: string) => string | undefined;
  /**
   * The Session's active long task. A Goal pause in a task the owner asked
   * for over IM is answered there, like its decision prompts (`reply`).
   */
  activeTask?: (sessionId: string) => PetLongTask | undefined;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const MAX_FACT_LENGTH = 500;

/** What the watcher already told the owner about one turn of a Session. */
interface TurnMarks {
  turn: number;
  /** A done / failed draft already went out (or is parked) for this turn. */
  done: boolean;
  failed: boolean;
  /**
   * Reports raised while the run was going (a Goal met, an `error`) that a
   * bound conversation's reply would serve. Whether the run forwards a reply
   * is only known when it closes, so they are decided then.
   */
  parked: ParkedReport[];
}

type DraftFacts = Omit<NoticeDraft, "sessionId" | "delivery">;

interface ParkedReport {
  event: "done" | "failed";
  query: OutcomeQuery;
  draft: DraftFacts;
  spend: boolean;
}

/** What an outcome asks the delivery plan: which rules it can satisfy, and whose run it is. */
type OutcomeQuery = Pick<
  DeliveryQuery,
  "at" | "scope" | "includeSystem" | "runKey" | "replyForwarded" | "task"
>;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a work Session's outcomes into notice drafts for the owner's notice
 * rules. What happened is decided once, by `SessionOutcomeDeriver`; who must
 * be told is decided once, by the delivery plan (pet-delivery-plan.ts). This
 * class joins the two: when an outcome is reportable, and which rules it spends.
 *
 * How each outcome is reported, next to what the long-task coordinator does
 * with the same outcome, is tabulated in session-outcome.ts.
 *
 * A closing outcome that only restates one raised while the run was going
 * (`repeat`) is never reported twice.
 *
 * A Session rule can only fire on an outcome that happened at/after its
 * `armedAt` (wall clock, so it survives restarts); the acknowledgement turn
 * that armed it is an idle outcome. Dedupe keys are built from the core run
 * id, so they are stable across restarts and unique per run.
 *
 * done / failed spend the matched Session rules; blocked leaves them armed.
 * The all-sessions system rule is never spent. A done / failed run that a
 * long task owns is reported (and its rules spent) by the task's closure: the
 * plan says so, and the watcher then does nothing for it. Outcomes are
 * serialised per Session; drafts are emitted before rules are spent so a
 * store failure can never swallow a notice.
 */
export class PetSessionRuleWatcher {
  private readonly marks = new Map<string, TurnMarks>();
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Sessions whose working turn completed while busy: the completion was
   * deferred, so the follow-up turn inherits the work. Deleted once a done
   * decision is made or the turn is aborted / fails.
   */
  private readonly carriedWork = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: PetSessionRuleWatcherOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Apply the outcomes one stream event produced (see `createSessionOutcomeTap`). */
  observe(sessionId: string, outcomes: readonly SessionOutcome[]): Promise<void> {
    if (outcomes.length === 0) return this.queues.get(sessionId) ?? Promise.resolve();
    return this.enqueue(sessionId, async () => {
      for (const outcome of outcomes) await this.applyOutcome(outcome);
    });
  }

  /**
   * The runs of these Sessions (one id, those a predicate selects, or all)
   * will never close:
   * the worker went away, or this process is shutting down. Their parked
   * reports go out now as "no reply forwarded" (templated), the same as when
   * the Session's next turn reports. Serialised behind each Session's queue.
   */
  flush(only?: string | ((sessionId: string) => boolean)): Promise<void> {
    const sessions =
      typeof only === "string"
        ? [only]
        : [...new Set([...this.marks.keys(), ...this.queues.keys()])].filter(
            (id) => only?.(id) ?? true,
          );
    return Promise.all(
      sessions.map((id) =>
        this.enqueue(id, async () => {
          const marks = this.marks.get(id);
          if (!marks) return;
          this.marks.delete(id);
          await this.flushParked(id, marks, false);
        }),
      ),
    ).then(() => undefined);
  }

  /** Some report waits for its run to close, or an outcome is still being applied. */
  hasPending(): boolean {
    return (
      this.queues.size > 0 || [...this.marks.values()].some((marks) => marks.parked.length > 0)
    );
  }

  async observeProjection(event: DesktopPetProjectionEvent): Promise<void> {
    if (event.kind !== "pending-upsert") return;
    const pending = event.pending;
    const at = Number.isFinite(event.observedAt) ? event.observedAt : this.now();
    await this.enqueue(pending.agentSessionId, () => this.applyPending(pending, at));
  }

  private enqueue(sessionId: string, apply: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    // Observation is fire-and-forget from the stream tap: never reject.
    const operation = previous.then(apply).catch((error: unknown) => {
      this.log("pet.notice.observe_failed", { sessionId, error: errorMessage(error) });
    });
    this.queues.set(sessionId, operation);
    return operation.finally(() => {
      if (this.queues.get(sessionId) === operation) this.queues.delete(sessionId);
    });
  }

  private async marksFor(outcome: SessionOutcome): Promise<TurnMarks> {
    let marks = this.marks.get(outcome.sessionId);
    // Caveat: turns are told apart by the deriver's own counter, not by core's
    // run id (a runner may give none), so a parked report of a run that never
    // closed waits for the next outcome of the Session or for flush().
    if (marks?.turn !== outcome.turn) {
      // A turn that never closed (the worker went away) forwarded nothing.
      if (marks) await this.flushParked(outcome.sessionId, marks, false);
      marks = { turn: outcome.turn, done: false, failed: false, parked: [] };
      this.marks.set(outcome.sessionId, marks);
    }
    return marks;
  }

  /** Decide the reports parked for this turn, now that its reply is known. */
  private async flushParked(
    sessionId: string,
    marks: TurnMarks,
    replyForwarded: boolean,
  ): Promise<void> {
    for (const { event, query, draft, spend } of marks.parked.splice(0))
      await this.emit(sessionId, event, { ...query, replyForwarded }, draft, undefined, spend);
  }

  private async applyOutcome(outcome: SessionOutcome): Promise<void> {
    const { sessionId } = outcome;
    const marks = await this.marksFor(outcome);
    try {
      switch (outcome.kind) {
        case "failed":
          if (outcome.final) this.carriedWork.delete(sessionId);
          await this.emitFailed(outcome, marks);
          return;
        case "aborted":
          this.carriedWork.delete(sessionId);
          return;
        case "cancelled":
          // The closing outcome of a goal_control_stop run restates the clear.
          if (outcome.final) return;
          await this.cancelGoalRules(sessionId);
          await this.options.onGoalCleared?.(sessionId);
          return;
        case "blocked":
          if (outcome.final && outcome.repeat) return;
          await this.emitBlocked(outcome);
          return;
        case "done":
          if (outcome.scope === "turn") await this.emitTurnDone(outcome, marks);
          // goal_progress(met) reports the Goal; its closing outcome restates it.
          else if (!outcome.final) await this.emitGoalDone(outcome, marks);
          return;
        case "idle":
          // The "OK, will do" turn that armed a rule did no work and must not fire it.
          // Work deferred from a turn that completed while busy still counts.
          if (this.carriedWork.has(sessionId)) await this.emitTurnDone(outcome, marks);
          return;
        case "waiting-worker":
          // The run yields to a later background wake, which reports.
          return;
        case "unrecognized":
          // A completion kind from a newer core: nothing is known about the run.
          return;
      }
    } finally {
      if (outcome.final) {
        await this.flushParked(sessionId, marks, outcome.reply === true);
        // The turn is over; nothing about it is needed for the next one.
        this.marks.delete(sessionId);
      }
    }
  }

  private async emitTurnDone(
    outcome: Extract<SessionOutcome, { kind: "done" | "idle" }>,
    marks: TurnMarks,
  ): Promise<void> {
    const { sessionId } = outcome;
    if (this.options.isSessionBusy(sessionId)) {
      // More work is queued; the follow-up turn reports it, even with no tools.
      this.carriedWork.add(sessionId);
      return;
    }
    this.carriedWork.delete(sessionId);
    await this.emit(
      sessionId,
      "done",
      {
        scope: "turn",
        at: outcome.at,
        runKey: outcome.runKey,
        // A Goal met earlier in this turn already told the system rule.
        includeSystem: !marks.done,
        replyForwarded: outcome.reply,
      },
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${sessionId}:turn:${outcome.runKey}`,
        facts: outcome.summary ? { summary: outcome.summary } : {},
        ...(outcome.kind === "done" && outcome.changedFiles
          ? { context: { changedFiles: outcome.changedFiles } }
          : {}),
      },
    );
  }

  private async emitGoalDone(
    outcome: Extract<SessionOutcome, { kind: "done" }>,
    marks: TurnMarks,
  ): Promise<void> {
    const { sessionId } = outcome;
    const emitted = await this.emit(
      sessionId,
      "done",
      // A replayed goal_progress from before a rule was armed must not fire it.
      {
        scope: "goal",
        at: outcome.at,
        runKey: outcome.runKey,
        ...(outcome.inRun ? {} : { replyForwarded: false }),
      },
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${sessionId}:goal:${outcome.goalId ?? outcome.runKey}`,
        facts: {},
        ...(outcome.changedFiles ? { context: { changedFiles: outcome.changedFiles } } : {}),
      },
      // Only a run that is open can still forward a reply when it closes.
      outcome.inRun ? marks : undefined,
    );
    // The closing outcome of this run must not tell the system rule twice.
    if (emitted) marks.done = true;
  }

  private async emitBlocked(outcome: Extract<SessionOutcome, { kind: "blocked" }>): Promise<void> {
    const { sessionId, question, summary } = outcome;
    // Blocked leaves the rules armed, and is the rules' to report even while a
    // long task owns the run (no `runKey`: the closure only reports done / failed).
    // The active task, like a decision prompt's: an IM-started task's pause goes
    // back to its conversation as a reply.
    const task = this.options.activeTask?.(sessionId);
    await this.emit(
      sessionId,
      "blocked",
      { at: outcome.at, ...(task ? { task } : {}) },
      {
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: `${sessionId}:goal-pause:${outcome.goalId ?? "-"}:${outcome.revision ?? "-"}:${outcome.runKey}`,
        facts: { ...(question ? { question } : {}), ...(summary ? { summary } : {}) },
        context: {
          reason: outcome.reason,
          ...(outcome.goalId ? { goalId: outcome.goalId } : {}),
          ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}),
        },
      },
    );
  }

  private async emitFailed(
    outcome: Extract<SessionOutcome, { kind: "failed" }>,
    marks: TurnMarks,
  ): Promise<void> {
    const { sessionId } = outcome;
    // An `error` event is usually followed by a failing turn_complete; one notice per turn.
    if (marks.failed) return;
    const emitted = await this.emit(
      sessionId,
      "failed",
      {
        at: outcome.at,
        runKey: outcome.runKey,
        // Outside a run (core reported the failure after the run boundary) no
        // reply will be forwarded for it: report it now, templated.
        ...(outcome.final
          ? { replyForwarded: outcome.reply }
          : outcome.inRun
            ? {}
            : { replyForwarded: false }),
      },
      {
        kind: "session.failed",
        priority: "P1",
        dedupeKey: `${sessionId}:failed:${outcome.runKey}`,
        facts: { error: boundedText(outcome.error, MAX_FACT_LENGTH) ?? "Work session failed" },
      },
      // An `error` inside a run is raised before the run closes; one outside
      // a run has no closing outcome to wait for.
      outcome.final || !outcome.inRun ? undefined : marks,
      // A failure outside any run is not the run the rules wait for: the owner
      // hears about it, and the rules stay armed for the next real result.
      outcome.final || outcome.inRun,
    );
    if (emitted) marks.failed = true;
  }

  private async applyPending(pending: DesktopPendingDecision, at: number): Promise<void> {
    if (pending.status !== "pending") return;
    const sessionId = pending.agentSessionId;
    // The IM decision module owns pending decisions; it is only nudged when a
    // rule asked to be told about this Session blocking.
    if (!this.options.isEligibleSession(sessionId)) return;
    const plan = await this.options.deliveries.plan({ sessionId, event: "blocked", at });
    if (!ruleDelivery(plan)) return;
    try {
      this.options.onPendingDecision(sessionId, pending);
    } catch (error) {
      this.log("pet.notice.pending_handoff_failed", {
        sessionId,
        requestId: pending.requestId,
        error: errorMessage(error),
      });
    }
  }

  private async cancelGoalRules(sessionId: string): Promise<void> {
    if (!this.options.isEligibleSession(sessionId)) return;
    const goalRules = this.options.rules
      .activeForSession(sessionId)
      .filter((rule) => rule.when.kind === "session" && rule.when.scope === "goal");
    await this.setState(sessionId, goalRules, "cancelled");
  }

  /**
   * Report one outcome to whoever its delivery plan names; returns whether a
   * draft went out (or was parked). A run the long-task closure reports is
   * left alone: the closure notifies and spends these rules. done / failed
   * spend the Session rules they satisfied; blocked leaves them armed.
   *
   * `park`: the run has not closed yet. A report its bound conversation's
   * reply would serve waits there for the closing outcome, which knows
   * whether a reply is forwarded at all.
   *
   * `spend`: done / failed spend the rules they satisfied, unless false.
   */
  private async emit(
    sessionId: string,
    event: "done" | "failed" | "blocked",
    query: OutcomeQuery,
    draft: DraftFacts,
    park?: TurnMarks,
    spend = event !== "blocked",
  ): Promise<boolean> {
    if (!this.options.isEligibleSession(sessionId)) return false;
    const plan = await this.options.deliveries.plan({ sessionId, event, ...query });
    const delivery = ruleDelivery(plan);
    if (!delivery) return false;
    if (park && event !== "blocked" && delivery.composeBy === "session-reply") {
      park.parked.push({ event, query, draft, spend });
      return true;
    }
    const title = boundedText(this.options.sessionTitle?.(sessionId), MAX_FACT_LENGTH);
    const notice: NoticeDraft = {
      ...draft,
      sessionId,
      delivery,
      facts: { ...(title ? { title } : {}), ...draft.facts },
    };
    try {
      this.options.onNotice(notice);
    } catch (error) {
      // Keep the rules armed: the notice never left this process.
      this.log("pet.notice.emit_failed", {
        sessionId,
        dedupeKey: notice.dedupeKey,
        error: errorMessage(error),
      });
      return false;
    }
    if (spend && event !== "blocked") await this.setState(sessionId, plan.rules, "spent");
    return true;
  }

  private async setState(
    sessionId: string,
    rules: NoticeRule[],
    state: Extract<NoticeRuleState, "spent" | "cancelled">,
  ): Promise<void> {
    for (const rule of rules) {
      if (rule.when.kind !== "session") continue;
      try {
        await this.options.rules.update(rule.id, rule.version, { state });
      } catch (error) {
        this.log("pet.notice.rule_update_failed", {
          sessionId,
          ruleId: rule.id,
          state,
          error: errorMessage(error),
        });
      }
    }
  }

  private log(event: string, data: Record<string, unknown>): void {
    try {
      this.options.log?.(event, data);
    } catch {
      /* logging must never break notice delivery */
    }
  }
}
