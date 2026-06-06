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
  /**
   * Hard cap on total turns for this goal run. When set, it overrides the
   * engine's interactive maxTurns default — a goal ("keep going until done")
   * routinely needs more turns than a single interactive prompt, and the
   * stop-hook keeps re-blocking completion, so the 100-turn interactive
   * ceiling would silently truncate a long unattended goal. Drops
   * non-positive values to "no override". See GOAL_DEFAULT_MAX_TURNS for the
   * fallback applied when a goal is active but no explicit cap was given.
   */
  maxTurns?: number;
  /**
   * Max CONSECUTIVE times the on_stop judge may block termination before the
   * loop forces a stop (the "stuck on an unsatisfiable goal" backstop). A goal
   * that keeps legitimately making progress resets this every accepted turn, so
   * this only bites when the judge re-blocks over and over with no completion.
   * Overrides GOAL_DEFAULT_MAX_STOP_BLOCKS. Non-positive values are dropped.
   */
  maxStopBlocks?: number;
}

/**
 * Default consecutive-stop-block cap for goal runs. The real safety net for an
 * unattended goal is the token/time budget + maxTurns; this cap only stops a
 * goal that the judge keeps re-blocking with NO progress between blocks. 8 was
 * too tight — a complex goal can legitimately get "not yet" several times while
 * advancing — so we allow a generous streak before declaring it stuck.
 */
export const GOAL_DEFAULT_MAX_STOP_BLOCKS = 25;

/**
 * Resolve the consecutive-stop-block cap for a run. Precedence:
 *   1. explicit `configMaxStopBlocks` (engine/caller override)
 *   2. `goal.maxStopBlocks`
 *   3. GOAL_DEFAULT_MAX_STOP_BLOCKS
 * Pure + injectable so engine and tests agree.
 */
export function resolveMaxStopBlocks(
  configMaxStopBlocks: number | undefined,
  goal: GoalConfig | undefined,
): number {
  if (typeof configMaxStopBlocks === "number" && configMaxStopBlocks > 0) {
    return Math.floor(configMaxStopBlocks);
  }
  if (goal?.maxStopBlocks && goal.maxStopBlocks > 0) return goal.maxStopBlocks;
  return GOAL_DEFAULT_MAX_STOP_BLOCKS;
}

/**
 * Turn ceiling applied when a goal is active and neither the GoalConfig nor
 * the engine config set an explicit maxTurns. Higher than the interactive
 * default (100) because goal runs are unattended and the stop-hook keeps the
 * loop going until the objective is met — the real safety backstops are the
 * token/time budgets and maxStopBlocks, not this ceiling. A round 300 gives
 * long goals room while still bounding a pathological loop.
 */
export const GOAL_DEFAULT_MAX_TURNS = 300;

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
  if (typeof obj.maxTurns === "number" && obj.maxTurns > 0) out.maxTurns = Math.floor(obj.maxTurns);
  if (typeof obj.maxStopBlocks === "number" && obj.maxStopBlocks > 0) {
    out.maxStopBlocks = Math.floor(obj.maxStopBlocks);
  }
  return out;
}

/** Interactive (no-goal) turn ceiling — a single prompt rarely needs more. */
export const INTERACTIVE_DEFAULT_MAX_TURNS = 100;

/**
 * Resolve the turn ceiling for a run, honoring goal mode.
 *
 * Precedence (first defined wins):
 *   1. `configMaxTurns` — an explicit engine/caller override (always wins).
 *   2. `goal.maxTurns`  — a per-goal cap from the GoalConfig.
 *   3. `GOAL_DEFAULT_MAX_TURNS` when a goal is active (raise the unattended
 *      ceiling above the interactive default).
 *   4. `INTERACTIVE_DEFAULT_MAX_TURNS` otherwise.
 *
 * Pure + injectable so the engine and tests agree on the rule.
 */
export function resolveMaxTurns(
  configMaxTurns: number | undefined,
  goal: GoalConfig | undefined,
): number {
  if (typeof configMaxTurns === "number" && configMaxTurns > 0) return configMaxTurns;
  if (goal) return goal.maxTurns ?? GOAL_DEFAULT_MAX_TURNS;
  return INTERACTIVE_DEFAULT_MAX_TURNS;
}

export interface GoalExtension {
  addTurns?: number;
  addTokenBudget?: number;
  addTimeBudgetMs?: number;
}

/**
 * Compute the new turn ceiling + goal budgets after a mid-run extension
 * (TODO 3.1). Pure so the TurnLoop and tests agree on the arithmetic:
 *   - addTurns bumps the maxTurns ceiling (floored, positive only).
 *   - addTokenBudget/addTimeBudgetMs raise the goal's caps. When a cap was
 *     previously unset ("unlimited"), we seed it from `tokensUsed` (tokens) or
 *     0 (time) before adding, so extending an unbounded run sets a fresh cap
 *     ABOVE current usage rather than leaving it unbounded.
 * `tokensUsed` is the tracker's running total (used only to seed an unset
 * token cap). Returns the resulting limits; never mutates its inputs.
 */
export function applyGoalExtension(
  currentMaxTurns: number,
  goal: GoalConfig | undefined,
  tokensUsed: number,
  ext: GoalExtension,
): { maxTurns: number; tokenBudget?: number; timeBudgetMs?: number } {
  let maxTurns = currentMaxTurns;
  if (typeof ext.addTurns === "number" && ext.addTurns > 0) {
    maxTurns += Math.floor(ext.addTurns);
  }
  let tokenBudget = goal?.tokenBudget;
  let timeBudgetMs = goal?.timeBudgetMs;
  if (goal) {
    if (typeof ext.addTokenBudget === "number" && ext.addTokenBudget > 0) {
      tokenBudget = (tokenBudget ?? tokensUsed) + Math.floor(ext.addTokenBudget);
    }
    if (typeof ext.addTimeBudgetMs === "number" && ext.addTimeBudgetMs > 0) {
      timeBudgetMs = (timeBudgetMs ?? 0) + Math.floor(ext.addTimeBudgetMs);
    }
  }
  return { maxTurns, tokenBudget, timeBudgetMs };
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
