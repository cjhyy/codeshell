/**
 * Persistent-goal events: judge progress markers, set / update / clear, and
 * the revision fence that drops events aimed at an older goal generation.
 * Each handler is one case of the reducer switch in ../types.ts, moved
 * verbatim.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  carryGoalClock,
  closeOpenGoalWaits,
  goalClockAfterProgress,
  stopGoalClock,
} from "../goalClock";
import type {
  ActiveGoal,
  GoalProgressMessage,
  MessageClock,
  MessagesReducerState,
} from "../messageTypes";
import { freshId } from "./helpers";

type GoalFenceEvent = { goalId?: string; revision?: number };

/** Reject an event that targets an older/different Goal projection. Once a
 *  revisioned goal is visible, a legacy event without a revision is also
 *  fenced out: it cannot prove that it belongs to the current generation. */
function isStaleGoalEvent(
  activeGoal: ActiveGoal,
  event: GoalFenceEvent,
  allowLegacyIdentityUpgrade = false,
): boolean {
  if (activeGoal.goalId !== event.goalId) {
    if (
      !(allowLegacyIdentityUpgrade && activeGoal.goalId === undefined && event.goalId !== undefined)
    ) {
      return true;
    }
  }
  if (activeGoal.revision !== undefined) {
    return event.revision === undefined || event.revision < activeGoal.revision;
  }
  return false;
}

export function applyGoalProgress(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "goal_progress" }>,
  now: MessageClock,
): MessagesReducerState {
  if (state.activeGoal && isStaleGoalEvent(state.activeGoal, event)) {
    return state;
  }
  const msg: GoalProgressMessage = {
    kind: "goal_progress",
    id: freshId("goal"),
    goalId: event.goalId,
    status: event.status,
    round: event.round,
    gaps: event.gaps,
    turnsRemaining: event.turnsRemaining,
    stopBlocksRemaining: event.stopBlocksRemaining,
    nearest: event.nearest,
    ...(event.waiting
      ? { waiting: { sinceMs: event.waiting.sinceMs, tasks: event.waiting.tasks } }
      : {}),
  };
  // The "approaching_limit" marker carries the "再续" button. Only prune it
  // when the moment has TRULY passed:
  //  - met/exhausted → the limit dimension settled / the run stopped.
  //  - a NEW approaching_limit → never stack two (re-announced after extend).
  // A "not_met" event means the goal is still advancing and may still be
  // nearing the cap, so the button must stay (fixes B2: previously not_met
  // pruned the button within the same turn it appeared).
  const dropApproaching =
    event.status === "met" || event.status === "exhausted" || event.status === "approaching_limit";
  // Any later marker ends an earlier background wait still shown as open.
  const base = closeOpenGoalWaits(
    dropApproaching
      ? state.messages.filter(
          (m) => !(m.kind === "goal_progress" && m.status === "approaching_limit"),
        )
      : state.messages,
    now() ?? Date.now(),
  );
  // Track the active goal's round; clear it when the goal settles
  // (met = achieved, exhausted = gave up). not_met/approaching_limit keep
  // it active and bump the round so the popover shows "第 N 轮".
  const activeGoal =
    event.status === "met" || event.status === "exhausted"
      ? null
      : state.activeGoal
        ? goalClockAfterProgress(
            {
              ...state.activeGoal,
              round: event.round,
              revision: event.revision ?? state.activeGoal.revision,
              // Any later progress means the Goal is moving again.
              waitingForUser: event.waitingForUser,
            },
            event,
            now() ?? Date.now(),
          )
        : state.activeGoal;
  return { ...state, messages: [...base, msg], activeGoal };
}

export function applyGoalSet(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "goal_set" }>,
  now: MessageClock,
): MessagesReducerState {
  // A send established or replaced the session's persistent goal.
  if (
    state.activeGoal &&
    state.activeGoal.goalId === event.goalId &&
    isStaleGoalEvent(state.activeGoal, event)
  ) {
    return state;
  }
  const runInFlight = Object.values(state.streamRuns ?? {}).some(
    (run) => !run.completed && !run.stopped,
  );
  return {
    ...state,
    activeGoal: {
      objective: event.objective,
      goalId: event.goalId,
      revision: event.revision,
      round: 0,
      paused: event.paused ?? false,
      ...(event.setAtMs ? { setAtMs: event.setAtMs } : {}),
      // A new goal identity starts its own accounting from zero.
      activeMs: 0,
      ...(runInFlight && !event.paused ? { clockSinceMs: now() ?? Date.now() } : {}),
    },
  };
}

export function applyGoalUpdated(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "goal_updated" }>,
  now: MessageClock,
): MessagesReducerState {
  // An edit or pause/resume can be the first Goal event observed after a
  // reconnect, so establish the projection when goal_set was not replayed.
  // A concrete mismatched id is stale and must not overwrite a replacement
  // goal; an absent id remains compatible with older servers.
  if (state.activeGoal && isStaleGoalEvent(state.activeGoal, event, true)) {
    return state;
  }
  const updated = carryGoalClock(
    state.activeGoal,
    {
      objective: event.objective,
      goalId: event.goalId ?? state.activeGoal?.goalId,
      revision: event.revision ?? state.activeGoal?.revision,
      round: state.activeGoal?.round ?? 0,
      paused: event.paused,
      ...((event.setAtMs ?? state.activeGoal?.setAtMs)
        ? { setAtMs: event.setAtMs ?? state.activeGoal?.setAtMs }
        : {}),
    },
    now() ?? Date.now(),
  );
  if (!event.paused) return { ...state, activeGoal: updated };
  // Pausing stops the goal clock (and ends a shown background wait);
  // resuming restarts it with the next run.
  const pausedAt = now() ?? Date.now();
  return {
    ...state,
    messages: closeOpenGoalWaits(state.messages, pausedAt),
    activeGoal: stopGoalClock(updated, pausedAt),
  };
}

export function applyGoalCleared(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "goal_cleared" }>,
  now: MessageClock,
): MessagesReducerState {
  if (state.activeGoal && isStaleGoalEvent(state.activeGoal, event)) {
    return state;
  }
  return {
    ...state,
    messages: closeOpenGoalWaits(state.messages, now() ?? Date.now()),
    activeGoal: null,
  };
}
