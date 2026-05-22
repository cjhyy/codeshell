/**
 * Arena strategies — mode-specific behavior for the arena orchestration loop.
 */

export { ReviewStrategy } from "./review.js";
export { DiscussionStrategy } from "./discussion.js";
export { PlanningStrategy } from "./planning.js";
export { withLens } from "./lens-wrapper.js";

import type { ArenaMode, ArenaStrategy, ArenaPlan } from "../types.js";
import { ReviewStrategy } from "./review.js";
import { DiscussionStrategy } from "./discussion.js";
import { PlanningStrategy } from "./planning.js";
import { withLens } from "./lens-wrapper.js";

const STRATEGY_MAP: Record<ArenaMode, () => ArenaStrategy> = {
  review: () => new ReviewStrategy(),
  discussion: () => new DiscussionStrategy(),
  planning: () => new PlanningStrategy(),
};

/** Get the default strategy for a given arena mode. */
export function getStrategy(mode: ArenaMode): ArenaStrategy {
  return STRATEGY_MAP[mode]();
}

/**
 * Get a strategy for a plan — mode strategy + lens wrapper.
 * This is the new evidence-driven entry point.
 */
export function getStrategyForPlan(plan: ArenaPlan): ArenaStrategy {
  const base = STRATEGY_MAP[plan.mode]();
  return withLens(base, plan);
}
