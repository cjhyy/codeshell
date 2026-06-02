/**
 * Goal mode P0 — run-scoped budget guardrails.
 *
 * `GoalConfig` is the normalized internal shape. Public entry points
 * (protocol/server, engine run) accept `string | GoalConfig` for
 * back-compat and call `normalizeGoal()` once at the boundary; everything
 * inward uses `GoalConfig`.
 *
 * The budget tracker is RUN-scoped (not per-turn like token-budget.ts):
 * it accumulates total tokens across turns and stamps a wall-clock start,
 * so an unattended goal run can't burn tokens or wall time without bound.
 */

export interface GoalConfig {
  /** The objective text shown to the judge / injected into context. */
  objective: string;
  /** Hard cap on total tokens (prompt+completion) for the whole goal run. */
  tokenBudget?: number;
  /** Hard cap on wall-clock duration of the whole goal run, in ms. */
  timeBudgetMs?: number;
}

/**
 * Coerce a raw goal input into a normalized GoalConfig, or undefined when
 * there is effectively no goal (empty objective). Drops non-positive
 * budgets (0 / negative → "no limit", same as absent).
 */
export function normalizeGoal(raw: string | GoalConfig | undefined): GoalConfig | undefined {
  if (raw == null) return undefined;
  const obj: GoalConfig = typeof raw === "string" ? { objective: raw } : { ...raw };
  const objective = (obj.objective ?? "").trim();
  if (!objective) return undefined;
  const out: GoalConfig = { objective };
  if (typeof obj.tokenBudget === "number" && obj.tokenBudget > 0) out.tokenBudget = obj.tokenBudget;
  if (typeof obj.timeBudgetMs === "number" && obj.timeBudgetMs > 0) out.timeBudgetMs = obj.timeBudgetMs;
  return out;
}

export interface GoalBudgetTracker {
  goal: GoalConfig;
  /** Wall-clock start (ms epoch), captured at run start. */
  startedAtMs: number;
  /** Accumulated total tokens (prompt + completion) across all turns. */
  tokensUsed: number;
}

/** Create a run-scoped tracker. `nowMs` is injected for testability. */
export function createGoalBudgetTracker(goal: GoalConfig, nowMs: number): GoalBudgetTracker {
  return { goal, startedAtMs: nowMs, tokensUsed: 0 };
}

/** Add this turn's token usage to the running total. */
export function recordGoalUsage(tracker: GoalBudgetTracker, turnTokens: number): void {
  if (turnTokens > 0) tracker.tokensUsed += turnTokens;
}

/**
 * Has the run exceeded any configured budget? `nowMs` is injected so callers
 * pass the current clock (and tests pass a fixed value).
 */
export function goalBudgetExceeded(tracker: GoalBudgetTracker, nowMs: number): boolean {
  const { tokenBudget, timeBudgetMs } = tracker.goal;
  if (typeof tokenBudget === "number" && tracker.tokensUsed > tokenBudget) return true;
  if (typeof timeBudgetMs === "number" && nowMs - tracker.startedAtMs > timeBudgetMs) return true;
  return false;
}
