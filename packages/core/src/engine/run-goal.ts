/**
 * Run goal — persistent-goal resolution (explicit > stored > config default),
 * arming the GoalStopHook for the run, and the terminal-outcome applier.
 * Engine keeps ownership of its active-goal slots via GoalRunSlots.
 */
import { randomUUID } from "node:crypto";
import type { StreamCallback, TokenUsage } from "../types.js";
import {
  normalizeGoal,
  resolveGoalSetAt,
  goalConfigFromLifecycle,
  isGoalLifecycleCurrent,
  isSameGoalVersion,
  type GoalConfig,
  type GoalTerminationReason,
  type PersistedGoalTerminationReason,
} from "../goal/lifecycle.js";
import { createGoalStopHook, type GoalJudgeRuntimeContext } from "../hooks/goal-stop-hook.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { LLMClientBase } from "../llm/client-base.js";
import { logger } from "../logging/logger.js";
import type {
  GoalTerminalSaveOutcome,
  SessionBundle,
  SessionManager,
} from "../session/session-manager.js";
import type { TurnLoop } from "./turn-loop.js";
import type { EngineConfig } from "./types.js";
import type { EngineRunOptions } from "./run-types.js";

export type GoalStopHookHandler = ReturnType<typeof createGoalStopHook>;

export interface GoalRunSlots {
  getActiveRuntimeGoal(): GoalConfig | null;
  setActiveRuntimeGoal(goal: GoalConfig | null): void;
  getActivePersistedRunGoal(): GoalConfig | null;
  setActivePersistedRunGoal(goal: GoalConfig | null): void;
  getActiveGoalHook(): GoalStopHookHandler | null;
  setActiveGoalHook(hook: GoalStopHookHandler | null): void;
  setActiveGoalHookAttached(attached: boolean): void;
}

/** engine.ts:explicit/stored/fallback 归一化 + 持久化 + goal_set 事件。 */
export function resolveRunGoal(args: {
  options: EngineRunOptions | undefined;
  session: SessionBundle;
  sessionManager: Pick<SessionManager, "saveActiveGoal">;
  configGoal: EngineConfig["goal"];
  isSubAgent: boolean;
  sid: string;
  onStream: StreamCallback | undefined;
}): { normalizedGoal: GoalConfig | undefined; persistedRunGoal: GoalConfig | undefined } {
  const { options, session, sessionManager, configGoal, isSubAgent, sid, onStream } = args;
  const explicitGoal = normalizeGoal(options?.goal);
  const storedLifecycle = session.state.goalLifecycle;
  const storedGoal =
    isSubAgent !== true && storedLifecycle && isGoalLifecycleCurrent(storedLifecycle)
      ? goalConfigFromLifecycle(storedLifecycle)
      : undefined;
  if (
    storedGoal &&
    !explicitGoal &&
    session.state.goalLifecycle?.phase === "waiting" &&
    !sessionManager.saveActiveGoal(session.state, storedGoal)
  ) {
    throw new Error(`Failed to arm waiting goal for session ${sid}`);
  }
  if (explicitGoal && isSubAgent !== true) {
    // Supplying a goal on a run is an explicit arm/resume operation.
    delete explicitGoal.paused;
    const replaced = !!storedGoal && storedGoal.objective !== explicitGoal.objective;
    // Stamp WHEN this goal was set so the judge can anchor relative deadlines
    // ("做到3点") to the set time, not "now" — else once the clock passes the
    // deadline the judge could read "3点" as tomorrow's and never stop. A new
    // or changed objective gets a fresh stamp; re-sending the SAME objective
    // keeps the original anchor (the goal continues, the user didn't restate a
    // new deadline). User input never carries setAtMs, so we set it here.
    const resolvedSetAt = resolveGoalSetAt(explicitGoal.objective, storedGoal, Date.now());
    explicitGoal.setAtMs = resolvedSetAt;
    explicitGoal.goalId = randomUUID();
    explicitGoal.revision = 1;
    if (
      !sessionManager.saveActiveGoal(session.state, explicitGoal, {
        replaceCurrent: storedGoal !== undefined,
      })
    ) {
      throw new Error(`Failed to persist active goal for session ${sid}`);
    }
    onStream?.({
      type: "goal_set",
      goalId: explicitGoal.goalId,
      revision: explicitGoal.revision,
      objective: explicitGoal.objective,
      replaced,
    });
  }
  const fallbackGoal = normalizeGoal(configGoal);
  if (fallbackGoal && !fallbackGoal.goalId) fallbackGoal.goalId = randomUUID();
  if (fallbackGoal && !fallbackGoal.revision) fallbackGoal.revision = 1;
  const normalizedGoal =
    explicitGoal ??
    (storedGoal?.paused === true ? undefined : storedGoal) ??
    (fallbackGoal?.paused === true ? undefined : fallbackGoal);
  // Snapshot the persisted goal identity owned by THIS run. Terminal
  // cleanup compares against this immutable copy so an old run cannot
  // delete a replacement goal installed while it was finishing.
  const persistedRunGoal =
    normalizedGoal &&
    session.state.goalLifecycle &&
    isGoalLifecycleCurrent(session.state.goalLifecycle) &&
    isSameGoalVersion(goalConfigFromLifecycle(session.state.goalLifecycle), normalizedGoal)
      ? { ...normalizedGoal }
      : undefined;
  return { normalizedGoal, persistedRunGoal };
}

/** engine.ts:GoalStopHook 创建 + 注册 + 槽位登记。 */
export function armRunGoalHook(args: {
  slots: GoalRunSlots;
  hooks: HookRegistry;
  llmClient: LLMClientBase;
  isSubAgent: boolean;
  normalizedGoal: GoalConfig | undefined;
  persistedRunGoal: GoalConfig | undefined;
  session: SessionBundle;
  sessionManager: Pick<SessionManager, "markGoalWaiting" | "readActiveGoal">;
  persistGoalTerminal: (
    state: SessionBundle["state"],
    goal: GoalConfig,
    reason: PersistedGoalTerminationReason,
  ) => boolean;
  getJudgeContext: () => GoalJudgeRuntimeContext | undefined;
  recordCumulativeUsage: (usage: TokenUsage) => unknown;
  recordGoalJudgeUsage: (
    usage: TokenUsage | undefined,
  ) => ReturnType<TurnLoop["recordGoalJudgeUsage"]>;
}): GoalStopHookHandler | null {
  const {
    slots,
    hooks,
    llmClient,
    isSubAgent,
    normalizedGoal,
    persistedRunGoal,
    session,
    sessionManager,
    persistGoalTerminal,
    getJudgeContext,
    recordCumulativeUsage,
    recordGoalJudgeUsage,
  } = args;
  let goalHookHandler: GoalStopHookHandler | null = null;
  if (isSubAgent !== true) {
    // Keep a dormant hook even when this ordinary run inherited a paused
    // persisted goal. A mid-run Resume can then arm Goal mode at the same
    // safe step boundary as Steer instead of waiting for another submit.
    slots.setActiveRuntimeGoal(normalizedGoal ?? null);
    slots.setActivePersistedRunGoal(persistedRunGoal ?? null);
    goalHookHandler = createGoalStopHook({
      goal: normalizedGoal,
      getGoal: () => slots.getActiveRuntimeGoal() ?? undefined,
      llm: llmClient,
      log: logger,
      getJudgeContext: () => getJudgeContext(),
      onJudgeUsage: (usage) => {
        // The provider records this request into llmClient.getUsage() and the
        // process-wide CostTracker. This separate callback feeds the session
        // cumulative cache counters and the live Goal hard-budget tracker.
        if (usage) recordCumulativeUsage(usage);
        // Charge the request even if an edit landed while the judge was
        // awaiting its response. Revision fencing suppresses the old
        // verdict, not the provider cost; otherwise repeated edits can
        // bypass the Goal hard budget.
        return recordGoalJudgeUsage(usage);
      },
      // Clear the persisted active goal the moment the judge says it's met,
      // so a later bare send doesn't re-inherit a satisfied goal. The hook
      // calls this from inside its met branch (single source of truth for
      // "goal achieved"); engine owns the persistence side-effect.
      onMet: () => {
        const runGoal = slots.getActivePersistedRunGoal() ?? persistedRunGoal;
        return runGoal ? persistGoalTerminal(session.state, runGoal, "completed") : true;
      },
      onWaiting: () => {
        const runGoal = slots.getActivePersistedRunGoal() ?? persistedRunGoal;
        return runGoal ? sessionManager.markGoalWaiting(session.state, runGoal) : true;
      },
      // Re-read the persisted goal each turn so a mid-run 清除 (clearGoal
      // wrote state.json but this hook's frozen goal copy + the closure's
      // in-RAM session are untouched) actually stops the judge. Reads disk
      // via readActiveGoal — authoritative and independent of which session
      // instance the run closure holds.
      isGoalActive: (sid) => {
        const runtimeGoal = slots.getActiveRuntimeGoal();
        if (!runtimeGoal) return false;
        // A config-only Goal has no disk record to re-check.
        if (!slots.getActivePersistedRunGoal()) return true;
        const liveGoal = sessionManager.readActiveGoal(sid);
        return liveGoal?.paused !== true && isSameGoalVersion(liveGoal, runtimeGoal);
      },
    });
    if (normalizedGoal) {
      hooks.register("on_stop", goalHookHandler, 0, "goal-stop");
      slots.setActiveGoalHookAttached(true);
    } else {
      slots.setActiveGoalHookAttached(false);
    }
    // Expose for edit/pause/resume/delete mid-run. Already guarded by
    // isSubAgent above.
    slots.setActiveGoalHook(goalHookHandler);
  }
  return goalHookHandler;
}

/** engine.ts:goal 终态落盘 + 事件 + 钩子摘除(闭包工厂)。 */
export function createGoalTerminationApplier(args: {
  slots: GoalRunSlots;
  hooks: HookRegistry;
  session: SessionBundle;
  persistedRunGoal: GoalConfig | undefined;
  goalHookHandler: GoalStopHookHandler | null;
  persistGoalTerminalOutcome: (
    state: SessionBundle["state"],
    goal: GoalConfig,
    termination: PersistedGoalTerminationReason,
  ) => GoalTerminalSaveOutcome;
  readActiveGoal: (sid: string) => GoalConfig | undefined | null;
  onStream: StreamCallback | undefined;
}): (termination: GoalTerminationReason | undefined, round: number | undefined) => void {
  const {
    slots,
    hooks,
    session,
    persistedRunGoal,
    goalHookHandler,
    persistGoalTerminalOutcome,
    readActiveGoal,
    onStream,
  } = args;
  return (termination: GoalTerminationReason | undefined, round: number | undefined): void => {
    const runGoal = slots.getActivePersistedRunGoal() ?? persistedRunGoal;
    if (!termination || !runGoal) return;
    // Judge prompt overflow ends only this run. The objective is unfinished
    // and may be resumed after the user reduces fixed judge context, so it
    // must not get a terminal tombstone or be cleared from activeGoal.
    if (termination === "judge_prompt_too_large") return;
    const outcome = persistGoalTerminalOutcome(session.state, runGoal, termination);
    if (outcome === "failed") {
      // No terminal event has been published. Re-assert the authoritative
      // active Goal in case another optimistic control changed the client.
      const authoritative = readActiveGoal(session.state.sessionId);
      if (authoritative) {
        onStream?.({
          type: "goal_updated",
          goalId: authoritative.goalId,
          revision: authoritative.revision,
          objective: authoritative.objective,
          paused: authoritative.paused === true,
        });
      }
      return;
    }
    if (outcome === "persisted") {
      // The durable terminal transition is the publication barrier: clients
      // must never observe an exhausted Goal that does not exist on disk.
      onStream?.({
        type: "goal_progress",
        goalId: runGoal.goalId,
        revision: runGoal.revision,
        status: "exhausted",
        round: round ?? 0,
      });
    }
    if (goalHookHandler) {
      hooks.unregister("on_stop", goalHookHandler);
      if (slots.getActiveGoalHook() === goalHookHandler) {
        slots.setActiveGoalHook(null);
        slots.setActiveGoalHookAttached(false);
        slots.setActiveRuntimeGoal(null);
        slots.setActivePersistedRunGoal(null);
      }
    }
  };
}
