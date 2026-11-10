import type { NoticeEvent } from "@cjhyy/code-shell-pet/protocol";
import type { NoticeRule, NoticeRuleState, PetRuleStore } from "./pet-rule-store.js";
import type { DesktopPendingDecision, DesktopPetProjectionEvent } from "./pet-state-aggregator.js";
import type { SessionOutcome } from "./session-outcome.js";

export interface NoticeDraftOption {
  label: string;
  recommended?: boolean;
}

export interface NoticeDraft {
  kind: "session.done" | "session.failed" | "session.blocked";
  priority: "P0" | "P1";
  dedupeKey: string;
  sessionId: string;
  ruleIds: string[];
  /** True when only the all-sessions system rule matched. */
  requiresAway?: boolean;
  /**
   * done / failed: the core run it closed, to pair it with that run's bound
   * reply. Absent when core gave no run id: such a notice is never suppressed.
   */
  runId?: string;
  requestId?: string;
  expiresAt?: number;
  facts: {
    title?: string;
    summary?: string;
    error?: string;
    question?: string;
    options?: NoticeDraftOption[];
  };
}

export interface PetSessionRuleWatcherOptions {
  rules: Pick<PetRuleStore, "activeForSession" | "update">;
  onNotice: (draft: NoticeDraft) => void;
  /**
   * A long task owns this run's done / failed (its closure notifies). `runKey`
   * is the core run id (or the watcher's fallback key when core gave none).
   */
  hasActiveLongTask: (sessionId: string, runKey: string) => boolean;
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
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const MAX_FACT_LENGTH = 500;

/** What the watcher already told the owner about one turn of a Session. */
interface TurnMarks {
  turn: number;
  /** A done / failed draft already went out for this turn. */
  done: boolean;
  failed: boolean;
}

type Matcher = (when: Extract<NoticeRule["when"], { kind: "session" }>) => boolean;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

/** `runId` for a done / failed draft: only a real core run id pairs with a bound reply. */
function runField(outcome: SessionOutcome): Pick<NoticeDraft, "runId"> {
  return outcome.runId !== undefined ? { runId: outcome.runId } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a work Session's outcomes into notice drafts for the owner's notice
 * rules. What happened is decided once, by `SessionOutcomeDeriver`; this class
 * decides who asked to be told.
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
 * The all-sessions system rule is never spent. Outcomes are serialised per
 * Session; drafts are emitted before rules are spent so a store failure can
 * never swallow a notice.
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

  private marksFor(outcome: SessionOutcome): TurnMarks {
    let marks = this.marks.get(outcome.sessionId);
    if (marks?.turn !== outcome.turn) {
      marks = { turn: outcome.turn, done: false, failed: false };
      this.marks.set(outcome.sessionId, marks);
    }
    return marks;
  }

  private async applyOutcome(outcome: SessionOutcome): Promise<void> {
    const { sessionId } = outcome;
    const marks = this.marksFor(outcome);
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
      }
    } finally {
      // The turn is over; nothing about it is needed for the next one.
      if (outcome.final) this.marks.delete(sessionId);
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
    // Long-task closure owns done/failed and spends these rules when it notifies.
    if (this.options.hasActiveLongTask(sessionId, outcome.runKey)) return;
    await this.emit(
      sessionId,
      "done",
      (when) => when.scope === "turn" && when.armedAt <= outcome.at,
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${sessionId}:turn:${outcome.runKey}`,
        ...runField(outcome),
        facts: outcome.summary ? { summary: outcome.summary } : {},
      },
      { spend: true, includeSystem: !marks.done },
    );
  }

  private async emitGoalDone(
    outcome: Extract<SessionOutcome, { kind: "done" }>,
    marks: TurnMarks,
  ): Promise<void> {
    const { sessionId } = outcome;
    // Long-task closure owns done/failed and spends these rules when it notifies.
    if (this.options.hasActiveLongTask(sessionId, outcome.runKey)) return;
    const emitted = await this.emit(
      sessionId,
      "done",
      // A replayed goal_progress from before a rule was armed must not fire it.
      (when) => when.scope === "goal" && when.armedAt <= outcome.at,
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${sessionId}:goal:${outcome.goalId ?? outcome.runKey}`,
        ...runField(outcome),
        facts: {},
      },
      { spend: true },
    );
    // The closing outcome of this run must not tell the system rule twice.
    if (emitted) marks.done = true;
  }

  private async emitBlocked(outcome: Extract<SessionOutcome, { kind: "blocked" }>): Promise<void> {
    const { sessionId, question, summary } = outcome;
    await this.emit(sessionId, "blocked", (when) => when.armedAt <= outcome.at, {
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: `${sessionId}:goal-pause:${outcome.goalId ?? "-"}:${outcome.revision ?? "-"}:${outcome.runKey}`,
      facts: { ...(question ? { question } : {}), ...(summary ? { summary } : {}) },
    });
  }

  private async emitFailed(
    outcome: Extract<SessionOutcome, { kind: "failed" }>,
    marks: TurnMarks,
  ): Promise<void> {
    const { sessionId } = outcome;
    // An `error` event is usually followed by a failing turn_complete; one notice per turn.
    if (marks.failed) return;
    // Long-task closure owns done/failed and spends these rules when it notifies.
    if (this.options.hasActiveLongTask(sessionId, outcome.runKey)) return;
    const emitted = await this.emit(
      sessionId,
      "failed",
      (when) => when.armedAt <= outcome.at,
      {
        kind: "session.failed",
        priority: "P1",
        dedupeKey: `${sessionId}:failed:${outcome.runKey}`,
        ...runField(outcome),
        facts: { error: boundedText(outcome.error, MAX_FACT_LENGTH) ?? "Work session failed" },
      },
      { spend: true },
    );
    if (emitted) marks.failed = true;
  }

  private async applyPending(pending: DesktopPendingDecision, at: number): Promise<void> {
    if (pending.status !== "pending") return;
    const sessionId = pending.agentSessionId;
    const armed: Matcher = (when) => when.armedAt <= at;
    // The IM decision module owns pending decisions; it is only nudged when a
    // rule asked to be told about this Session blocking.
    if (this.match(sessionId, "blocked", armed).length === 0) return;
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

  /** Eligible active rules for this Session that watch `event` and pass `matches`. */
  private match(sessionId: string, event: NoticeEvent, matches: Matcher): NoticeRule[] {
    if (!this.options.isEligibleSession(sessionId)) return [];
    return this.options.rules
      .activeForSession(sessionId)
      .filter(
        (rule) =>
          rule.when.events.includes(event) &&
          (rule.when.kind === "all-sessions" || matches(rule.when)),
      );
  }

  /** Emit one draft for every matched rule; returns whether a draft went out. */
  private async emit(
    sessionId: string,
    event: NoticeEvent,
    matches: Matcher,
    draft: Omit<NoticeDraft, "sessionId" | "ruleIds" | "requiresAway">,
    options: { spend?: boolean; includeSystem?: boolean } = {},
  ): Promise<boolean> {
    const matched = this.match(sessionId, event, matches).filter(
      (rule) => options.includeSystem !== false || rule.when.kind === "session",
    );
    if (matched.length === 0) return false;
    const sessionRules = matched.filter((rule) => rule.when.kind === "session");
    const title = boundedText(this.options.sessionTitle?.(sessionId), MAX_FACT_LENGTH);
    const notice: NoticeDraft = {
      ...draft,
      sessionId,
      ruleIds: matched.map((rule) => rule.id),
      ...(sessionRules.length === 0 ? { requiresAway: true } : {}),
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
    if (options.spend) await this.setState(sessionId, sessionRules, "spent");
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
