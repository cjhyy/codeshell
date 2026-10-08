import type { AgentModule } from "@cjhyy/code-shell-core/extension";
import { createOptimizationLabQueries } from "./queries.js";
import type { ControllerOptions } from "./controller.js";

export const OPTIMIZATION_LAB_MODULE_ID = "optimization-lab";

/** Optimization Lab as a private Desktop-only, default-off AgentModule. */
export function createOptimizationLabModule(options: ControllerOptions = {}): AgentModule {
  return {
    id: OPTIMIZATION_LAB_MODULE_ID,
    protocol: { queries: createOptimizationLabQueries(options) },
  };
}
