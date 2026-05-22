/**
 * Token budget — decides whether the agent loop should continue, nudge, or stop.
 *
 * - "continue": keep going normally
 * - "nudge": inject a "please wrap up" message, but continue
 * - "stop": terminate the loop gracefully
 */

export interface BudgetTracker {
  continuationCount: number;
  lastDeltaTokens: number;
  prevTurnTokens: number;
}

export function createBudgetTracker(): BudgetTracker {
  return { continuationCount: 0, lastDeltaTokens: Infinity, prevTurnTokens: 0 };
}

export type BudgetDecision = "continue" | "nudge" | "stop";

/**
 * Check if the turn loop should continue based on token output budget.
 *
 * @param turnOutputTokens - tokens output so far this turn
 * @param budget - max tokens allowed for this turn (Infinity = no limit)
 * @param tracker - mutable tracker state (updated in place)
 */
export function checkTokenBudget(
  turnOutputTokens: number,
  budget: number,
  tracker: BudgetTracker,
): BudgetDecision {
  if (!isFinite(budget) || budget <= 0) return "continue";

  const pct = turnOutputTokens / budget;
  const delta = turnOutputTokens - tracker.prevTurnTokens;

  // Diminishing returns: 3+ continuations and last two deltas both < 500
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    delta < 500 &&
    tracker.lastDeltaTokens < 500;

  // Update tracker
  tracker.lastDeltaTokens = delta;
  tracker.prevTurnTokens = turnOutputTokens;

  // Stop: at/above threshold with prior nudge, or diminishing returns
  if (tracker.continuationCount > 0 && (isDiminishing || pct >= 0.9)) {
    return "stop";
  }

  // Nudge: approaching budget threshold
  if (pct >= 0.9) {
    tracker.continuationCount++;
    return "nudge";
  }

  return "continue";
}
