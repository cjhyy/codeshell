import type { NoticeEvent } from "@cjhyy/code-shell-pet/protocol";
import { topLevelEvent } from "./pet-long-task-coordinator.js";
import type { NoticeRule, NoticeRuleState, PetRuleStore } from "./pet-rule-store.js";
import type { DesktopPendingDecision, DesktopPetProjectionEvent } from "./pet-state-aggregator.js";

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
  /** done: the core run (or fallback key) it closed, to pair it with a bound reply. */
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
  sessionTitle?: (sessionId: string) => string | undefined;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Tools that talk to the owner or Mimi; a turn that only used these did no work. */
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

/** What the watcher knows about the in-flight top-level turn of one Session. */
interface SessionTurnState {
  /** Run identity from `session_started`, for events that do not carry one. */
  runId?: string;
  /** The current turn did real work (a non-notice tool, or a background wake). */
  workInTurn: boolean;
  /** A done / failed draft already went out for the current turn. */
  doneInTurn: boolean;
  failedInTurn: boolean;
  /**
   * The Goal paused this turn (waiting for the user, or exhausted). Core then
   * parks the run with an ordinary `turn_complete(completed)`, which must not
   * read as done.
   */
  blockedInTurn: boolean;
}

function freshTurn(): SessionTurnState {
  return { workInTurn: false, doneInTurn: false, failedInTurn: false, blockedInTurn: false };
}

type Matcher = (when: Extract<NoticeRule["when"], { kind: "session" }>) => boolean;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** When a stream event happened: its own timestamp when core stamped one, else now. */
function eventTime(event: Record<string, unknown>, field: string, now: () => number): number {
  const value = event[field];
  return typeof value === "number" && Number.isFinite(value) ? value : now();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns work-Session stream events into notice drafts for the owner's notice
 * rules, deterministically from the event stream so the model never has to
 * remember that it was asked to report back.
 *
 * Detection, per top-level event:
 * - done: `turn_complete(completed)` without a completionKind, after a turn
 *   that did real work, on an idle Session (turn-scope rules); or
 *   `goal_progress(met)` (goal-scope rules).
 * - failed: `turn_complete` that is neither completed nor a user abort, or `error`.
 * - blocked: `limit_stop`, a Goal waiting for the user, or an exhausted Goal.
 *   A pending decision from the projection is handed to `onPendingDecision`
 *   (the IM decision module) instead, when a blocked rule watches it.
 *
 * A Session rule can only fire on an event that happened at/after its
 * `armedAt` (wall clock, so it survives restarts); the acknowledgement turn
 * that armed it is filtered by the work gate instead. Dedupe keys are built
 * from the core run id, so they are stable across restarts and unique per run.
 *
 * done / failed spend the matched Session rules; blocked leaves them armed.
 * The all-sessions system rule is never spent. Events are serialised per
 * Session; drafts are emitted before rules are spent so a store failure can
 * never swallow a notice.
 */
export class PetSessionRuleWatcher {
  private readonly turns = new Map<string, SessionTurnState>();
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Host-queued user messages (SendMessageToSession) whose run has not started.
   * Such a run has no client message id, exactly like a background wake, and
   * is told apart only by the `session_user_message` that precedes it.
   */
  private readonly queuedUserMessages = new Map<string, number>();
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

  observe(sessionId: string, event: unknown): Promise<void> {
    return this.enqueue(sessionId, () => this.applySessionEvent(sessionId, event));
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

  private turn(sessionId: string): SessionTurnState {
    let state = this.turns.get(sessionId);
    if (!state) {
      state = freshTurn();
      this.turns.set(sessionId, state);
    }
    return state;
  }

  /**
   * A run without a client message id is either a host-queued user message or
   * a background wake. `previousRunId` cannot tell them apart (every resumed
   * run has one); a preceding `session_user_message` can.
   */
  private isBackgroundWake(sessionId: string): boolean {
    const queued = this.queuedUserMessages.get(sessionId) ?? 0;
    if (queued === 0) return true;
    if (queued === 1) this.queuedUserMessages.delete(sessionId);
    else this.queuedUserMessages.set(sessionId, queued - 1);
    return false;
  }

  /** The run this event belongs to; a timestamp only when core gave no run id. */
  private runKey(event: Record<string, unknown>, state: SessionTurnState, at: number): string {
    return nonEmptyString(event.runId) ?? state.runId ?? String(at);
  }

  private async applySessionEvent(sessionId: string, value: unknown): Promise<void> {
    const event = topLevelEvent(value);
    if (!event) return;
    switch (event.type) {
      case "session_user_message":
        // SendMessageToSession announces its run this way before enqueueing it
        // without a client message id (core server.ts).
        if (event.clientMessageId === undefined) {
          const queued = this.queuedUserMessages.get(sessionId) ?? 0;
          this.queuedUserMessages.set(sessionId, Math.min(queued + 1, MAX_QUEUED_USER_MESSAGES));
        }
        return;
      case "session_started": {
        const state = freshTurn();
        const runId = nonEmptyString(event.runId);
        if (runId) state.runId = runId;
        if (event.clientMessageId === undefined && this.isBackgroundWake(sessionId))
          // A background completion wakes the Session with a synthetic run
          // (core background-result-wakeup). That turn exists to act on
          // finished work, so it counts as work.
          state.workInTurn = true;
        this.turns.set(sessionId, state);
        return;
      }
      case "tool_use_start": {
        const toolCall = event.toolCall as { toolName?: unknown } | undefined;
        const name = typeof toolCall?.toolName === "string" ? toolCall.toolName : undefined;
        if (!name || !NON_WORK_TOOLS.has(name)) this.turn(sessionId).workInTurn = true;
        return;
      }
      case "goal_progress":
        await this.applyGoalProgress(sessionId, this.turn(sessionId), event);
        return;
      case "goal_cleared":
        await this.cancelGoalRules(sessionId);
        return;
      case "error": {
        const state = this.turn(sessionId);
        const at = eventTime(event, "timestamp", this.now);
        await this.emitFailed(
          sessionId,
          state,
          at,
          this.runKey(event, state, at),
          boundedText(event.error, MAX_FACT_LENGTH) ?? "Work session failed",
        );
        return;
      }
      case "turn_complete":
        try {
          await this.applyTurnComplete(sessionId, this.turn(sessionId), event);
        } finally {
          // The turn is over; nothing about it is needed for the next one.
          this.turns.delete(sessionId);
        }
    }
  }

  private async applyTurnComplete(
    sessionId: string,
    state: SessionTurnState,
    event: Record<string, unknown>,
  ): Promise<void> {
    const at = eventTime(event, "completedAt", this.now);
    const run = this.runKey(event, state, at);
    const armed: Matcher = (when) => when.armedAt <= at;
    const reason = event.reason;
    if (reason !== "completed") this.carriedWork.delete(sessionId);
    if (reason === "aborted_streaming" || reason === "aborted_tools") return;
    if (reason !== "completed") {
      await this.emitFailed(
        sessionId,
        state,
        at,
        run,
        `Work session ended: ${String(reason ?? "unknown")}`,
      );
      return;
    }
    const summary = boundedText(event.text, MAX_SUMMARY_LENGTH);
    // A Goal that paused this run (waiting for the user / stop-block cap) is
    // parked by core with turn_complete(completed) and no completionKind. The
    // goal_progress event already raised blocked; this is not done.
    if (state.blockedInTurn) return;
    if (event.completionKind === "limit_stop") {
      await this.emit(sessionId, "blocked", armed, {
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: `${sessionId}:goal-pause:-:-:${run}`,
        facts: summary ? { summary } : {},
      });
      return;
    }
    // background_wait yields to a later wake; goal_control_stop follows
    // goal_cleared / goal_progress(met), which already handled the outcome.
    if (event.completionKind !== undefined) return;
    // The "OK, will do" turn that armed a rule did no work and must not fire it.
    // Work deferred from a turn that completed while busy still counts.
    if (!state.workInTurn && !this.carriedWork.has(sessionId)) return;
    if (this.options.isSessionBusy(sessionId)) {
      // More work is queued; the follow-up turn reports it, even with no tools.
      this.carriedWork.add(sessionId);
      return;
    }
    this.carriedWork.delete(sessionId);
    // Long-task closure owns done/failed and spends these rules when it notifies.
    if (this.options.hasActiveLongTask(sessionId, run)) return;
    await this.emit(
      sessionId,
      "done",
      (when) => when.scope === "turn" && armed(when),
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${sessionId}:turn:${run}`,
        runId: run,
        facts: summary ? { summary } : {},
      },
      { spend: true, includeSystem: !state.doneInTurn },
    );
  }

  private async applyGoalProgress(
    sessionId: string,
    state: SessionTurnState,
    event: Record<string, unknown>,
  ): Promise<void> {
    // A replayed goal_progress from before a rule was armed must not fire it.
    const at = eventTime(event, "timestamp", this.now);
    const run = this.runKey(event, state, at);
    const armed: Matcher = (when) => when.armedAt <= at;
    const question = boundedText(event.waitingForUser, MAX_FACT_LENGTH);
    if (event.status === "met") {
      // Long-task closure owns done/failed and spends these rules when it notifies.
      if (this.options.hasActiveLongTask(sessionId, run)) return;
      const goalId = nonEmptyString(event.goalId) ?? run;
      const emitted = await this.emit(
        sessionId,
        "done",
        (when) => when.scope === "goal" && armed(when),
        {
          kind: "session.done",
          priority: "P1",
          dedupeKey: `${sessionId}:goal:${goalId}`,
          runId: run,
          facts: {},
        },
        { spend: true },
      );
      // The closing turn_complete of this run must not tell the system rule twice.
      if (emitted) state.doneInTurn = true;
      return;
    }
    // Core carries the question itself in `waitingForUser`; accept a bare flag too.
    const waiting = question !== undefined || event.waitingForUser === true;
    if (!waiting && event.status !== "exhausted") return;
    state.blockedInTurn = true;
    const goalId = nonEmptyString(event.goalId) ?? "-";
    const revision = typeof event.revision === "number" ? event.revision : "-";
    const gaps = boundedText(event.gaps, MAX_SUMMARY_LENGTH);
    await this.emit(sessionId, "blocked", armed, {
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: `${sessionId}:goal-pause:${goalId}:${revision}:${run}`,
      facts: { ...(question ? { question } : {}), ...(gaps ? { summary: gaps } : {}) },
    });
  }

  private async emitFailed(
    sessionId: string,
    state: SessionTurnState,
    at: number,
    run: string,
    error: string,
  ): Promise<void> {
    // An `error` event is usually followed by a failing turn_complete; one notice per turn.
    if (state.failedInTurn) return;
    // Long-task closure owns done/failed and spends these rules when it notifies.
    if (this.options.hasActiveLongTask(sessionId, run)) return;
    const emitted = await this.emit(
      sessionId,
      "failed",
      (when) => when.armedAt <= at,
      {
        kind: "session.failed",
        priority: "P1",
        dedupeKey: `${sessionId}:failed:${run}`,
        facts: { error },
      },
      { spend: true },
    );
    if (emitted) state.failedInTurn = true;
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
