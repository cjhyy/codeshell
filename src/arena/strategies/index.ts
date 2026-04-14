/**
 * Arena strategies — mode-specific behavior for the arena orchestration loop.
 */

export { ReviewStrategy } from "./review.js";
export { DiscussionStrategy } from "./discussion.js";
export { PlanningStrategy } from "./planning.js";

import type { ArenaMode, ArenaStrategy } from "../types.js";
import { ReviewStrategy } from "./review.js";
import { DiscussionStrategy } from "./discussion.js";
import { PlanningStrategy } from "./planning.js";

const STRATEGY_MAP: Record<ArenaMode, () => ArenaStrategy> = {
  review: () => new ReviewStrategy(),
  discussion: () => new DiscussionStrategy(),
  planning: () => new PlanningStrategy(),
};

/** Get the default strategy for a given arena mode. */
export function getStrategy(mode: ArenaMode): ArenaStrategy {
  return STRATEGY_MAP[mode]();
}
