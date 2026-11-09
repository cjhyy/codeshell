/**
 * Renderer projection of the goal-level clock (Codex `time_used_seconds`
 * semantics): it runs while a run of the goal is in flight or the goal is
 * parked on background work, and stops while paused or waiting for the user.
 * Each `goal_progress` marker carries the host's authoritative `activeMs`
 * as of `atMs`; between markers the renderer extrapolates from run lifecycle
 * events. Pure helpers — the messages reducer owns the state.
 */
import type { ActiveGoal, GoalProgressMessage, Message } from "./types";

interface GoalProgressFields {
  waitingForUser?: string;
  waiting?: { sinceMs: number };
  progress?: { activeMs: number; atMs: number };
}

/** Adopt a marker's authoritative accounting. */
export function goalClockAfterProgress(
  goal: ActiveGoal,
  event: GoalProgressFields,
  nowMs: number,
): ActiveGoal {
  const stopsClock = event.waitingForUser !== undefined;
  if (!event.progress) return stopsClock ? stopGoalClock(goal, nowMs) : goal;
  return {
    ...goal,
    activeMs: event.progress.activeMs,
    clockSinceMs: stopsClock ? undefined : event.progress.atMs,
    waitingBackground: event.waiting !== undefined,
  };
}

/** A run of the goal started: the clock runs (a background wait hands over). */
export function startGoalClock(goal: ActiveGoal, nowMs: number): ActiveGoal {
  if (goal.paused || goal.activeMs === undefined) return goal;
  if (goal.clockSinceMs !== undefined) {
    return goal.waitingBackground ? { ...goal, waitingBackground: false } : goal;
  }
  return { ...goal, clockSinceMs: nowMs, waitingBackground: false };
}

/** Settle the open segment and stop the clock. */
export function stopGoalClock(goal: ActiveGoal, nowMs: number): ActiveGoal {
  if (goal.clockSinceMs === undefined) return goal;
  return {
    ...goal,
    activeMs: (goal.activeMs ?? 0) + Math.max(0, nowMs - goal.clockSinceMs),
    clockSinceMs: undefined,
    waitingBackground: false,
  };
}

/** A run ended: the clock keeps running only while parked on background work. */
export function goalRunEnded(goal: ActiveGoal, nowMs: number): ActiveGoal {
  return goal.waitingBackground ? goal : stopGoalClock(goal, nowMs);
}

/** Goal-level active time at `nowMs`, or undefined before any accounting is known. */
export function goalElapsedMs(goal: ActiveGoal, nowMs: number): number | undefined {
  if (goal.activeMs === undefined) return undefined;
  const open = goal.clockSinceMs === undefined ? 0 : Math.max(0, nowMs - goal.clockSinceMs);
  return goal.activeMs + open;
}

/** Keep the clock fields of the same goal across a projection rebuild. */
export function carryGoalClock(previous: ActiveGoal | null, next: ActiveGoal): ActiveGoal {
  if (!previous || previous.goalId !== next.goalId) return next;
  return {
    ...next,
    ...(previous.activeMs !== undefined && next.activeMs === undefined
      ? {
          activeMs: previous.activeMs,
          clockSinceMs: previous.clockSinceMs,
          waitingBackground: previous.waitingBackground,
        }
      : {}),
  };
}

/** Stamp the end time on every still-open background-wait marker. */
export function closeOpenGoalWaits(messages: Message[], nowMs: number): Message[] {
  let changed = false;
  const next = messages.map((message) => {
    if (
      message.kind !== "goal_progress" ||
      !message.waiting ||
      message.waitEndedAtMs !== undefined
    ) {
      return message;
    }
    changed = true;
    return {
      ...message,
      waitEndedAtMs: Math.max(message.waiting.sinceMs, nowMs),
    } satisfies GoalProgressMessage;
  });
  return changed ? next : messages;
}
