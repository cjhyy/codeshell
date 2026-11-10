/**
 * The one interpreter of a work Session's stream: what each run did, as
 * `SessionOutcome`s. The long-task coordinator and the notice-rule watcher both
 * consume these and map them to their own state; neither reads done / failed /
 * blocked out of raw events.
 *
 * What each consumer does with an outcome ("running" = raised while the run
 * is still going, "closing" = from `turn_complete`):
 *
 * | outcome                           | long-task coordinator        | notice-rule watcher        |
 * | --------------------------------- | ---------------------------- | -------------------------- |
 * | done (turn), closing              | completed if verified by turn, else interrupted | done, turn-scope rules |
 * | idle, closing                     | same as done (turn)          | done only for carried work |
 * | done (goal), running              | completed                    | done, goal-scope rules     |
 * | failed, running (`error`)         | failed                       | failed, once per turn      |
 * | failed, closing                   | failed                       | failed, once per turn      |
 * | blocked (user), running           | none (checkpoint from event) | blocked                    |
 * | blocked (goal_exhausted), running | FAILED                       | BLOCKED                    |
 * | blocked (user / goal_exhausted), closing | same as done (turn)   | none if `repeat`, else blocked |
 * | blocked (limit), closing          | interrupted                  | blocked unless `repeat`    |
 * | cancelled, running                | verify by turn from now on   | goal rules cancelled       |
 * | done (goal) / cancelled, closing  | interrupted (Goal driving stopped) | none                 |
 * | aborted, closing                  | interrupted                  | none (drops carried work)  |
 * | waiting-worker, closing           | waiting-worker               | none                       |
 *
 * An exhausted Goal is read two ways on purpose, from the one outcome: the
 * task that was driving that Goal has failed and closes, while the owner is
 * told the Session is stuck (it can still be continued by hand).
 */

export type SessionBlockReason = "user" | "limit" | "goal_exhausted";

interface SessionOutcomeBase {
  sessionId: string;
  /** The core run id. Absent when core gave none for this run. */
  runId?: string;
  /** Run identity for dedupe keys: `runId`, else the event time. */
  runKey: string;
  /** When it happened: the event's own timestamp when core stamped one, else now. */
  at: number;
  /**
   * True when this outcome closes the run (it comes from `turn_complete`).
   * False for a signal raised while the run is still going (`goal_progress`,
   * `goal_cleared`, `error`); the run's closing outcome follows.
   */
  final: boolean;
  /**
   * A closing outcome that restates what this run already reported: the Goal
   * pause, completion or clear that a non-final outcome carried. A consumer
   * that acted on the earlier one must not act again.
   */
  repeat?: true;
  /** Outcomes with the same value belong to the same turn of this Session. */
  turn: number;
}

export type SessionOutcome = SessionOutcomeBase &
  (
    | { kind: "done"; scope: "turn" | "goal"; summary?: string; goalId?: string }
    | { kind: "failed"; error: string; budgetExhausted?: true }
    | {
        kind: "blocked";
        reason: SessionBlockReason;
        question?: string;
        /** What is still missing (the Goal judge's gaps), or the run's last text. */
        summary?: string;
        goalId?: string;
        revision?: number;
      }
    /** The owner stopped Goal driving (cleared the Goal, or paused it mid-run). */
    | { kind: "cancelled" }
    | { kind: "aborted" }
    /** The run yielded to background work that will wake the Session. */
    | { kind: "waiting-worker" }
    /** A completed turn that did no work (an acknowledgement). */
    | { kind: "idle"; summary?: string }
  );

export type SessionOutcomeKind = SessionOutcome["kind"];

/** `turn_complete.outcome` as core reports it (see core `TurnOutcome`). */
interface CoreTurnOutcome {
  didWork: boolean;
  blockedOn?: SessionBlockReason;
  goal?: "met" | "cleared" | "paused";
  backgroundPending: boolean;
}

/**
 * Fallback for a core that does not report `turn_complete.outcome` (and for
 * external runtimes): tools that talk to the owner or Mimi. A turn that only
 * used these did no work. Core declares the same set as `bookkeeping` tools.
 */
const NON_WORK_TOOLS: ReadonlySet<string> = new Set([
  "NotifyMe",
  "ReportToMimi",
  "AskUserQuestion",
  "AskUserQuestionAsync",
  "RequestMimiDelivery",
  // Loading a deferred tool schema (e.g. to reach NotifyMe) is not work either.
  "ToolSearch",
]);
/** Undelivered host-queued user messages tracked per Session (bounds a stuck counter). */
const MAX_QUEUED_USER_MESSAGES = 64;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_FACT_LENGTH = 500;

/** What the deriver knows about the in-flight top-level turn of one Session. */
interface TurnState {
  turn: number;
  /** Run identity from `session_started`, for events that do not carry one. */
  runId?: string;
  /** Fallback only: a non-notice tool ran, or the run is a background wake. */
  work: boolean;
  /**
   * The Goal paused this turn (waiting for the user, or exhausted). Core then
   * parks the run with an ordinary `turn_complete(completed)`, which must not
   * read as done.
   */
  blocked?: Exclude<SessionBlockReason, "limit">;
  /** The Goal was met or cleared this turn. */
  goal?: { state: "met" | "cleared"; goalId?: string };
}

/** A Session stream event from the top-level agent (child-agent events carry `agentId`). */
export function topLevelEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  return typeof event.type === "string" && event.agentId === undefined ? event : null;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function coreOutcome(value: unknown): CoreTurnOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const outcome = value as Record<string, unknown>;
  if (typeof outcome.didWork !== "boolean" || typeof outcome.backgroundPending !== "boolean")
    return undefined;
  const { blockedOn, goal } = outcome;
  return {
    didWork: outcome.didWork,
    backgroundPending: outcome.backgroundPending,
    ...(blockedOn === "user" || blockedOn === "limit" || blockedOn === "goal_exhausted"
      ? { blockedOn }
      : {}),
    ...(goal === "met" || goal === "cleared" || goal === "paused" ? { goal } : {}),
  };
}

/**
 * Turns one Session's top-level stream events into outcomes, deterministically,
 * so the model never has to remember that it was asked to report back.
 *
 * Per event:
 * - `goal_progress(met)` → done (goal); a Goal waiting for the user or
 *   exhausted → blocked; `goal_cleared` → cancelled; `error` → failed. These
 *   are raised while the run is still going (`final: false`).
 * - `turn_complete` → exactly one closing outcome (`final: true`): aborted,
 *   failed, waiting-worker (`background_wait`), blocked (`limit_stop`, or the
 *   Goal pause restated), done (goal) / cancelled (`goal_control_stop`), and
 *   otherwise done (turn) when the run did work or idle when it did not.
 *
 * When core reports `turn_complete.outcome`, it decides whether the run did
 * work, whether the Goal blocked it, and whether background work is pending.
 * Without it (an older core, an external runtime) the same facts are inferred
 * from the stream: a tool outside `NON_WORK_TOOLS` or a background wake is
 * work, and a Goal pause seen earlier in the turn blocks its completion.
 */
export class SessionOutcomeDeriver {
  private readonly turns = new Map<string, TurnState>();
  /**
   * Fallback only. Host-queued user messages (SendMessageToSession) whose run
   * has not started. Such a run has no client message id, exactly like a
   * background wake; core marks which is which on `session_started.trigger`,
   * and without that marker only the `session_user_message` that precedes it
   * tells them apart.
   */
  private readonly queuedUserMessages = new Map<string, number>();
  private turnSequence = 0;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The outcomes one stream event produces: none for most, one otherwise. */
  derive(sessionId: string, value: unknown): SessionOutcome[] {
    const event = topLevelEvent(value);
    if (!event) return [];
    switch (event.type) {
      case "session_user_message":
        // SendMessageToSession announces its run this way before enqueueing it
        // without a client message id (core server.ts).
        if (event.clientMessageId === undefined) {
          const queued = this.queuedUserMessages.get(sessionId) ?? 0;
          this.queuedUserMessages.set(sessionId, Math.min(queued + 1, MAX_QUEUED_USER_MESSAGES));
        }
        return [];
      case "session_started": {
        const state = this.freshTurn();
        const runId = nonEmptyString(event.runId);
        if (runId) state.runId = runId;
        // A background completion wakes the Session with a synthetic run
        // (core background-result-wakeup). That turn exists to act on
        // finished work, so it counts as work.
        if (this.isBackgroundWake(sessionId, event)) state.work = true;
        this.turns.set(sessionId, state);
        return [];
      }
      case "tool_use_start": {
        const toolCall = event.toolCall as { toolName?: unknown } | undefined;
        const name = typeof toolCall?.toolName === "string" ? toolCall.toolName : undefined;
        if (!name || !NON_WORK_TOOLS.has(name)) this.turn(sessionId).work = true;
        return [];
      }
      case "goal_progress":
        return this.goalProgress(sessionId, this.turn(sessionId), event);
      case "goal_cleared": {
        const state = this.turn(sessionId);
        state.goal = { state: "cleared" };
        return [{ ...this.base(sessionId, state, event, "timestamp", false), kind: "cancelled" }];
      }
      case "error":
        return [
          {
            ...this.base(sessionId, this.turn(sessionId), event, "timestamp", false),
            kind: "failed",
            error: typeof event.error === "string" ? event.error : "Work session failed",
          },
        ];
      case "turn_complete":
        try {
          return [this.turnComplete(sessionId, this.turn(sessionId), event)];
        } finally {
          // The turn is over; nothing about it is needed for the next one.
          this.turns.delete(sessionId);
        }
      default:
        return [];
    }
  }

  private freshTurn(): TurnState {
    this.turnSequence += 1;
    return { turn: this.turnSequence, work: false };
  }

  private turn(sessionId: string): TurnState {
    let state = this.turns.get(sessionId);
    if (!state) {
      state = this.freshTurn();
      this.turns.set(sessionId, state);
    }
    return state;
  }

  /**
   * Fallback only. Whether a run is core's background wake. Core marks it on
   * `session_started.trigger`; an older core does not, and then a run without
   * a client message id is either a host-queued user message or a wake, told
   * apart only by a preceding `session_user_message` (`previousRunId` cannot:
   * every resumed run has one).
   */
  private isBackgroundWake(sessionId: string, event: Record<string, unknown>): boolean {
    const trigger = event.trigger;
    if (trigger === "background_wake") return true;
    if (event.clientMessageId !== undefined) return false;
    // This run was the announced one (or, unmarked, is assumed to be).
    const queued = this.queuedUserMessages.get(sessionId) ?? 0;
    if (queued > 1) this.queuedUserMessages.set(sessionId, queued - 1);
    else this.queuedUserMessages.delete(sessionId);
    return typeof trigger === "string" ? false : queued === 0;
  }

  private base(
    sessionId: string,
    state: TurnState,
    event: Record<string, unknown>,
    timeField: "timestamp" | "completedAt",
    final: boolean,
  ): SessionOutcomeBase {
    const stamped = event[timeField];
    const at = typeof stamped === "number" && Number.isFinite(stamped) ? stamped : this.now();
    const runId = nonEmptyString(event.runId) ?? state.runId;
    return {
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
      runKey: runId ?? String(at),
      at,
      final,
      turn: state.turn,
    };
  }

  private goalProgress(
    sessionId: string,
    state: TurnState,
    event: Record<string, unknown>,
  ): SessionOutcome[] {
    const base = this.base(sessionId, state, event, "timestamp", false);
    const goalId = nonEmptyString(event.goalId);
    if (event.status === "met") {
      state.goal = { state: "met", ...(goalId ? { goalId } : {}) };
      return [{ ...base, kind: "done", scope: "goal", ...(goalId ? { goalId } : {}) }];
    }
    // Core carries the question itself in `waitingForUser`; accept a bare flag too.
    const question = boundedText(event.waitingForUser, MAX_FACT_LENGTH);
    const waiting = question !== undefined || event.waitingForUser === true;
    const exhausted = event.status === "exhausted";
    if (!waiting && !exhausted) return [];
    const reason = exhausted ? "goal_exhausted" : "user";
    // Exhaustion closes the Goal; a pause earlier in the same turn does not outrank it.
    if (exhausted || state.blocked === undefined) state.blocked = reason;
    const gaps = boundedText(event.gaps, MAX_SUMMARY_LENGTH);
    return [
      {
        ...base,
        kind: "blocked",
        reason,
        ...(question ? { question } : {}),
        ...(gaps ? { summary: gaps } : {}),
        ...(goalId ? { goalId } : {}),
        ...(typeof event.revision === "number" ? { revision: event.revision } : {}),
      },
    ];
  }

  private turnComplete(
    sessionId: string,
    state: TurnState,
    event: Record<string, unknown>,
  ): SessionOutcome {
    const base = this.base(sessionId, state, event, "completedAt", true);
    const reason = event.reason;
    if (reason === "aborted_streaming" || reason === "aborted_tools")
      return { ...base, kind: "aborted" };
    if (reason !== "completed") {
      return {
        ...base,
        kind: "failed",
        error: `Work session ended: ${String(reason ?? "unknown")}`,
        ...(reason === "max_turns" ? { budgetExhausted: true as const } : {}),
      };
    }
    const reported = coreOutcome(event.outcome);
    const summary = boundedText(event.text, MAX_SUMMARY_LENGTH);
    const withSummary = summary ? { summary } : {};
    // The Goal pause was already raised by its goal_progress event.
    const restated = state.blocked !== undefined ? { repeat: true as const } : {};
    const completionKind = event.completionKind;
    if (completionKind === "limit_stop" || reported?.blockedOn === "limit")
      return { ...base, ...restated, kind: "blocked", reason: "limit", ...withSummary };
    if (completionKind === "goal_control_stop") {
      // Follows goal_progress(met) (complete_goal) or goal_cleared (cancel_goal,
      // or the owner clearing / pausing the Goal while it ran).
      const goal = reported?.goal ?? state.goal?.state;
      const seen = state.goal !== undefined ? { repeat: true as const } : {};
      if (goal !== "met") return { ...base, ...seen, kind: "cancelled" };
      const goalId = state.goal?.goalId;
      return { ...base, ...seen, kind: "done", scope: "goal", ...(goalId ? { goalId } : {}) };
    }
    if (reported ? reported.backgroundPending : completionKind === "background_wait")
      return { ...base, kind: "waiting-worker" };
    // A completion kind this host does not know: the run ended, nothing to report.
    if (completionKind !== undefined) return { ...base, kind: "idle", ...withSummary };
    // A Goal that paused this run (waiting for the user / exhausted) is parked
    // by core with turn_complete(completed) and no completionKind: not done.
    const goalBlock = reported
      ? reported.blockedOn === "user" || reported.blockedOn === "goal_exhausted"
        ? reported.blockedOn
        : undefined
      : state.blocked;
    if (goalBlock) return { ...base, ...restated, kind: "blocked", reason: goalBlock };
    // The "OK, will do" turn that armed a rule did no work and must not read as done.
    return (reported ? reported.didWork : state.work)
      ? { ...base, kind: "done", scope: "turn", ...withSummary }
      : { ...base, kind: "idle", ...withSummary };
  }
}

/** The closing outcome among one event's outcomes, if it closed a run. */
export function closingOutcome(outcomes: readonly SessionOutcome[]): SessionOutcome | undefined {
  return outcomes.find((outcome) => outcome.final);
}

/** The outcome an event raised while its run is still going, if any. */
export function runningOutcome(outcomes: readonly SessionOutcome[]): SessionOutcome | undefined {
  return outcomes.find((outcome) => !outcome.final);
}

export interface SessionOutcomeConsumers {
  /** First: the long task records the outcome before the watcher asks who owns the run. */
  coordinator: (sessionId: string, event: unknown, outcomes: readonly SessionOutcome[]) => void;
  /** Second: the notice-rule watcher. */
  watcher: (sessionId: string, outcomes: readonly SessionOutcome[]) => void;
}

/**
 * The single tap on the worker's Session stream: each event is interpreted
 * once and the same outcomes are handed to both consumers, coordinator first.
 * The order is fixed here instead of depending on listener registration.
 */
export function createSessionOutcomeTap(
  consumers: SessionOutcomeConsumers,
  deriver: SessionOutcomeDeriver = new SessionOutcomeDeriver(),
): (sessionId: string, event: unknown) => void {
  return (sessionId, event) => {
    const outcomes: readonly SessionOutcome[] = deriver.derive(sessionId, event);
    try {
      consumers.coordinator(sessionId, event, outcomes);
    } finally {
      consumers.watcher(sessionId, outcomes);
    }
  };
}
