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
  hasActiveLongTask: (sessionId: string) => boolean;
  /** Queued user messages or running background / sub-agent work. */
  isSessionBusy: (sessionId: string) => boolean;
  /** False for Mimi's own Session, child Sessions and hidden kinds. */
  isEligibleSession: (sessionId: string) => boolean;
  /** When set, a pending decision is handed here instead of emitting a blocked draft. */
  onPendingDecision?: (sessionId: string, pending: DesktopPendingDecision) => void;
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
]);
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_FACT_LENGTH = 500;
const MAX_OPTIONS = 10;

interface SessionTurnState {
  /** Top-level turn completions observed in this process. */
  turnSeq: number;
  /** The current turn did real work (a non-notice tool, or a background wake). */
  workInTurn: boolean;
  /** A done / failed draft already went out for the current turn. */
  doneInTurn: boolean;
  failedInTurn: boolean;
}

type Matcher = (when: Extract<NoticeRule["when"], { kind: "session" }>) => boolean;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function pendingOptions(pending: DesktopPendingDecision): NoticeDraftOption[] | undefined {
  // Not part of the projection today; read defensively so a richer projection
  // (ask_user choices) flows through without a type change here.
  const raw = (pending as { options?: unknown }).options;
  if (!Array.isArray(raw)) return undefined;
  const options = raw.flatMap((option): NoticeDraftOption[] => {
    if (!option || typeof option !== "object") return [];
    const record = option as Record<string, unknown>;
    const label = boundedText(record.label, MAX_FACT_LENGTH);
    if (!label) return [];
    return [{ label, ...(record.recommended === true ? { recommended: true } : {}) }];
  });
  return options.length > 0 ? options.slice(0, MAX_OPTIONS) : undefined;
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
 * - blocked: `limit_stop`, a Goal waiting for the user, an exhausted Goal, or
 *   a pending decision from the projection.
 *
 * done / failed spend the matched Session rules; blocked leaves them armed.
 * The all-sessions system rule is never spent. Events are serialised per
 * Session; drafts are emitted before rules are spent so a store failure can
 * never swallow a notice.
 */
export class PetSessionRuleWatcher {
  private readonly sessions = new Map<string, SessionTurnState>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: PetSessionRuleWatcherOptions) {}

  /** Turn completions seen for this Session; the `armedAtSeq` for a rule created now. */
  currentSeq(sessionId: string): number {
    return this.sessions.get(sessionId)?.turnSeq ?? 0;
  }

  observe(sessionId: string, event: unknown): Promise<void> {
    return this.enqueue(sessionId, () => this.applySessionEvent(sessionId, event));
  }

  async observeProjection(event: DesktopPetProjectionEvent): Promise<void> {
    if (event.kind !== "pending-upsert") return;
    const pending = event.pending;
    await this.enqueue(pending.agentSessionId, () => this.applyPending(pending));
  }

  private enqueue(sessionId: string, apply: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(apply);
    this.queues.set(sessionId, operation);
    return operation.finally(() => {
      if (this.queues.get(sessionId) === operation) this.queues.delete(sessionId);
    });
  }

  private state(sessionId: string): SessionTurnState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { turnSeq: 0, workInTurn: false, doneInTurn: false, failedInTurn: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private async applySessionEvent(sessionId: string, value: unknown): Promise<void> {
    const event = topLevelEvent(value);
    if (!event) return;
    const state = this.state(sessionId);
    switch (event.type) {
      case "session_started":
        this.resetTurn(state);
        // A background completion wakes the Session with a synthetic run that
        // has no client message id (core background-result-wakeup). That turn
        // exists to act on finished work, so it counts as work.
        if (event.clientMessageId === undefined && typeof event.previousRunId === "string")
          state.workInTurn = true;
        return;
      case "tool_use_start": {
        const toolCall = event.toolCall as { toolName?: unknown } | undefined;
        const name = typeof toolCall?.toolName === "string" ? toolCall.toolName : undefined;
        if (!name || !NON_WORK_TOOLS.has(name)) state.workInTurn = true;
        return;
      }
      case "goal_progress":
        await this.applyGoalProgress(sessionId, state, event);
        return;
      case "goal_cleared":
        await this.cancelGoalRules(sessionId);
        return;
      case "error":
        await this.emitFailed(
          sessionId,
          state,
          boundedText(event.error, MAX_FACT_LENGTH) ?? "Work session failed",
        );
        return;
      case "turn_complete": {
        const seq = state.turnSeq;
        try {
          await this.applyTurnComplete(sessionId, state, event, seq);
        } finally {
          state.turnSeq = seq + 1;
          this.resetTurn(state);
        }
      }
    }
  }

  private resetTurn(state: SessionTurnState): void {
    state.workInTurn = false;
    state.doneInTurn = false;
    state.failedInTurn = false;
  }

  private async applyTurnComplete(
    sessionId: string,
    state: SessionTurnState,
    event: Record<string, unknown>,
    seq: number,
  ): Promise<void> {
    const reason = event.reason;
    if (reason === "aborted_streaming" || reason === "aborted_tools") return;
    if (reason !== "completed") {
      await this.emitFailed(sessionId, state, `Work session ended: ${String(reason ?? "unknown")}`);
      return;
    }
    const summary = boundedText(event.text, MAX_SUMMARY_LENGTH);
    if (event.completionKind === "limit_stop") {
      await this.emit(sessionId, "blocked", (when) => when.armedAtSeq <= seq, {
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: `${sessionId}:goal-pause:${seq}`,
        facts: summary ? { summary } : {},
      });
      return;
    }
    // background_wait yields to a later wake; goal_control_stop follows
    // goal_cleared / goal_progress(met), which already handled the outcome.
    if (event.completionKind !== undefined) return;
    if (!state.workInTurn || this.options.hasActiveLongTask(sessionId)) return;
    if (this.options.isSessionBusy(sessionId)) return;
    await this.emit(
      sessionId,
      "done",
      (when) => when.scope === "turn" && when.armedAtSeq <= seq,
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${sessionId}:turn:${seq}`,
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
    const seq = state.turnSeq;
    const question = boundedText(event.waitingForUser, MAX_FACT_LENGTH);
    if (event.status === "met") {
      if (this.options.hasActiveLongTask(sessionId)) return;
      const goalId = typeof event.goalId === "string" && event.goalId ? event.goalId : seq;
      const emitted = await this.emit(
        sessionId,
        "done",
        (when) => when.scope === "goal" && when.armedAtSeq <= seq,
        {
          kind: "session.done",
          priority: "P1",
          dedupeKey: `${sessionId}:goal:${goalId}`,
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
    const revision = typeof event.revision === "number" ? event.revision : seq;
    const gaps = boundedText(event.gaps, MAX_SUMMARY_LENGTH);
    await this.emit(sessionId, "blocked", (when) => when.armedAtSeq <= seq, {
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: `${sessionId}:goal-pause:${revision}`,
      facts: { ...(question ? { question } : {}), ...(gaps ? { summary: gaps } : {}) },
    });
  }

  private async emitFailed(
    sessionId: string,
    state: SessionTurnState,
    error: string,
  ): Promise<void> {
    // An `error` event is usually followed by a failing turn_complete; one notice per turn.
    if (state.failedInTurn || this.options.hasActiveLongTask(sessionId)) return;
    const seq = state.turnSeq;
    const emitted = await this.emit(
      sessionId,
      "failed",
      (when) => when.armedAtSeq <= seq,
      {
        kind: "session.failed",
        priority: "P1",
        dedupeKey: `${sessionId}:failed:${seq}`,
        facts: { error },
      },
      { spend: true },
    );
    if (emitted) state.failedInTurn = true;
  }

  private async applyPending(pending: DesktopPendingDecision): Promise<void> {
    if (pending.status !== "pending") return;
    const sessionId = pending.agentSessionId;
    const seq = this.currentSeq(sessionId);
    if (this.options.onPendingDecision) {
      // The IM decision module owns pending decisions when wired; it is only
      // consulted when a rule asked to be told about this Session blocking.
      if (this.match(sessionId, "blocked", (when) => when.armedAtSeq <= seq).length === 0) return;
      try {
        this.options.onPendingDecision(sessionId, pending);
      } catch (error) {
        this.log("pet.notice.pending_handoff_failed", {
          sessionId,
          requestId: pending.requestId,
          error: errorMessage(error),
        });
      }
      return;
    }
    const options = pendingOptions(pending);
    const question = boundedText(pending.title, MAX_FACT_LENGTH);
    await this.emit(sessionId, "blocked", (when) => when.armedAtSeq <= seq, {
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: `${sessionId}:${pending.requestId}`,
      requestId: pending.requestId,
      ...(pending.expiresAt !== undefined ? { expiresAt: pending.expiresAt } : {}),
      facts: { ...(question ? { question } : {}), ...(options ? { options } : {}) },
    });
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
