/**
 * Goal lifecycle projection for persisted Session state.
 *
 * Owns the one-way migration from the legacy goal aliases (`activeGoal`,
 * `goalTerminal`, `goalTerminals`) into the canonical `goalLifecycle` union,
 * the persistence projection that never writes those aliases back, and the
 * temporary adapter for whole-state callers that still mutate the aliases.
 * The Goal-domain CAS updates themselves stay on SessionManager.
 */

import type { SessionState } from "../types.js";
import { SessionError } from "../exceptions.js";
import {
  carryGoalProgress,
  createGoalLifecycle,
  decodeGoalLifecycle,
  deriveLegacyGoalId,
  goalConfigFromLifecycle,
  isSameGoalVersion,
  mergeGoalTerminals,
  terminateGoalLifecycle,
  type GoalConfig,
  type GoalLifecycleTerminalReason,
  type GoalLifecycleV1,
  type GoalTerminal,
  type PersistedGoalTerminationReason,
} from "../goal/lifecycle.js";

export function lifecycleTerminalReason(
  reason: PersistedGoalTerminationReason,
): GoalLifecycleTerminalReason {
  return reason;
}

function newestLegacyTerminal(state: SessionState): GoalTerminal | undefined {
  return mergeGoalTerminals(state.goalTerminals, state.goalTerminal).at(-1);
}

function legacyTerminalMatchesGoal(terminal: GoalTerminal, goal: GoalConfig): boolean {
  if (terminal.goalId && goal.goalId) {
    return (
      terminal.goalId === goal.goalId &&
      Math.max(1, Math.floor(terminal.revision ?? 1)) ===
        Math.max(1, Math.floor(goal.revision ?? 1))
    );
  }
  return terminal.objective === goal.objective && terminal.setAtMs === goal.setAtMs;
}

/** Decode the canonical union or derive it once from legacy aliases. */
export function hydrateGoalLifecycle(state: SessionState): SessionState {
  const hasCanonical = Object.prototype.hasOwnProperty.call(state, "goalLifecycle");
  const persistedLifecycle = (state as { goalLifecycle?: unknown }).goalLifecycle;
  let lifecycle: GoalLifecycleV1 | undefined;
  if (hasCanonical && persistedLifecycle !== undefined) {
    lifecycle = decodeGoalLifecycle(persistedLifecycle);
    if (!lifecycle) {
      throw new SessionError(
        `Session goal lifecycle is unsupported or corrupt for ${state.sessionId}`,
      );
    }
  } else if (state.activeGoal) {
    const active: GoalConfig = {
      ...state.activeGoal,
      goalId: state.activeGoal.goalId ?? deriveLegacyGoalId(state.sessionId, state.activeGoal),
      revision: Math.max(1, Math.floor(state.activeGoal.revision ?? 1)),
    };
    const terminal = mergeGoalTerminals(state.goalTerminals, state.goalTerminal).find((candidate) =>
      legacyTerminalMatchesGoal(candidate, active),
    );
    const base = createGoalLifecycle(active, active.paused === true ? "paused" : "active");
    lifecycle = terminal
      ? terminateGoalLifecycle(
          base,
          lifecycleTerminalReason(terminal.reason),
          terminal.terminatedAtMs ?? Date.now(),
        )
      : base;
  } else {
    const terminal = newestLegacyTerminal(state);
    if (terminal) {
      const goal: GoalConfig = {
        objective: terminal.objective,
        goalId:
          terminal.goalId ??
          deriveLegacyGoalId(state.sessionId, {
            objective: terminal.objective,
            setAtMs: terminal.setAtMs,
          }),
        revision: Math.max(1, Math.floor(terminal.revision ?? 1)),
        ...(terminal.setAtMs !== undefined ? { setAtMs: terminal.setAtMs } : {}),
      };
      lifecycle = terminateGoalLifecycle(
        createGoalLifecycle(goal, "active", terminal.terminatedAtMs ?? Date.now()),
        lifecycleTerminalReason(terminal.reason),
        terminal.terminatedAtMs ?? Date.now(),
      );
    }
  }

  if (lifecycle) state.goalLifecycle = lifecycle;
  else delete state.goalLifecycle;

  // Legacy aliases are migration inputs only. Never reconstruct them in RAM:
  // all runtime readers and writers consume the canonical lifecycle union.
  delete state.activeGoal;
  delete state.goalTerminal;
  delete state.goalTerminals;
  return state;
}

/** New files and runtime state contain only the canonical union. */
export function stateForPersistence(state: SessionState): SessionState {
  const persisted = { ...state };
  delete persisted.activeGoal;
  delete persisted.goalTerminal;
  delete persisted.goalTerminals;
  return persisted;
}

/**
 * Temporary adapter for tests/older in-repo callers that still mutate the
 * hydrated aliases before calling whole-state saveState. Production Goal paths
 * use the domain methods below. The adapter never writes aliases to disk.
 */
export function adoptCompatibilityGoalMutation(state: SessionState): void {
  const activeTouched = Object.prototype.hasOwnProperty.call(state, "activeGoal");
  const terminalTouched =
    Object.prototype.hasOwnProperty.call(state, "goalTerminal") ||
    Object.prototype.hasOwnProperty.call(state, "goalTerminals");
  if (!activeTouched && !terminalTouched) return;
  const lifecycle = decodeGoalLifecycle(state.goalLifecycle);
  const alias = state.activeGoal
    ? {
        ...state.activeGoal,
        goalId: state.activeGoal.goalId ?? deriveLegacyGoalId(state.sessionId, state.activeGoal),
        revision: Math.max(1, Math.floor(state.activeGoal.revision ?? 1)),
      }
    : undefined;
  const terminals = mergeGoalTerminals(state.goalTerminals, state.goalTerminal);

  if (!lifecycle) {
    if (alias) {
      state.goalLifecycle = createGoalLifecycle(alias, alias.paused === true ? "paused" : "active");
    }
    return;
  }

  if (alias) {
    const sameIdentity = lifecycle.goalId === alias.goalId;
    const sameRevision = lifecycle.revision === alias.revision;
    const matchingTerminal = terminals.find((terminal) =>
      legacyTerminalMatchesGoal(terminal, alias),
    );
    if (matchingTerminal) {
      const base = createGoalLifecycle(alias, alias.paused === true ? "paused" : "active");
      state.goalLifecycle = terminateGoalLifecycle(
        base,
        lifecycleTerminalReason(matchingTerminal.reason),
        matchingTerminal.terminatedAtMs ?? Date.now(),
      );
      return;
    }
    if (lifecycle.phase === "terminal" && sameIdentity && sameRevision) return;
    const canonicalGoal = goalConfigFromLifecycle(lifecycle);
    if (!sameIdentity || !sameRevision || !isSameGoalVersion(alias, canonicalGoal)) {
      state.goalLifecycle = carryGoalProgress(
        createGoalLifecycle(alias, alias.paused === true ? "paused" : "active"),
        lifecycle,
      );
    }
    return;
  }

  const matchingTerminal = terminals.find((terminal) =>
    legacyTerminalMatchesGoal(terminal, goalConfigFromLifecycle(lifecycle)),
  );
  if (matchingTerminal && lifecycle.phase !== "terminal") {
    state.goalLifecycle = terminateGoalLifecycle(
      lifecycle,
      lifecycleTerminalReason(matchingTerminal.reason),
      matchingTerminal.terminatedAtMs ?? Date.now(),
    );
  }
}
