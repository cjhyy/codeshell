/** What a top-level run did, reported once on its `turn_complete`. */
import type { SessionRunTrigger, StreamEvent, TurnOutcome } from "../types.js";

type TopLevelEvent<T extends StreamEvent["type"]> = Extract<StreamEvent, { type: T }>;

function isChildEvent(event: StreamEvent): boolean {
  return "agentId" in event && event.agentId !== undefined;
}

/**
 * Follows one top-level run's own stream and attaches `outcome` to its
 * `turn_complete`, so hosts read what happened instead of inferring it.
 *
 * Only top-level events count: a sub-agent's tool calls are the work of the
 * `Agent` call that spawned it, which is already a top-level tool call.
 *
 * Goal signals are the ones this run published (`goal_progress`,
 * `goal_cleared`), so the outcome can never disagree with the events a host
 * saw before it. A pause stays recorded for the rest of the run even if a
 * queued message re-drives it.
 */
export function createTurnOutcomeTracker(isBookkeepingTool: (toolName: string) => boolean): {
  prepareEvent(event: StreamEvent): StreamEvent;
} {
  let didWork = false;
  let waitingForUser = false;
  let goalExhausted = false;
  let goal: TurnOutcome["goal"];

  const observeGoalProgress = (event: TopLevelEvent<"goal_progress">): void => {
    if (event.status === "met") {
      goal = "met";
      return;
    }
    if (event.status === "exhausted") goalExhausted = true;
    const asksUser = !!event.waitingForUser?.trim();
    if (asksUser) waitingForUser = true;
    if (asksUser || event.waiting) goal = "paused";
  };

  const outcome = (event: TopLevelEvent<"turn_complete">): TurnOutcome => {
    const blockedOn: TurnOutcome["blockedOn"] = goalExhausted
      ? "goal_exhausted"
      : waitingForUser
        ? "user"
        : event.completionKind === "limit_stop"
          ? "limit"
          : undefined;
    return {
      didWork,
      ...(blockedOn ? { blockedOn } : {}),
      ...(goal ? { goal } : {}),
      backgroundPending: event.completionKind === "background_wait",
    };
  };

  return {
    prepareEvent(event) {
      if (isChildEvent(event)) return event;
      switch (event.type) {
        case "tool_use_start":
          if (!isBookkeepingTool(event.toolCall.toolName)) didWork = true;
          return event;
        case "goal_progress":
          observeGoalProgress(event);
          return event;
        case "goal_cleared":
          goal = "cleared";
          return event;
        case "turn_complete":
          return { ...event, outcome: outcome(event) };
        default:
          return event;
      }
    },
  };
}

/**
 * Stamp why the run started on its `turn_complete.outcome`. A background wake
 * exists to act on finished work, so it counts as work even without a tool.
 */
export function withOutcomeTrigger(
  event: StreamEvent,
  trigger: SessionRunTrigger | undefined,
): StreamEvent {
  if (trigger === undefined || event.type !== "turn_complete" || !event.outcome) return event;
  if (isChildEvent(event)) return event;
  return {
    ...event,
    outcome: {
      ...event.outcome,
      didWork: event.outcome.didWork || trigger === "background_wake",
      trigger,
    },
  };
}
