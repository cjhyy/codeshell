import type { AgentModule } from "@cjhyy/code-shell-core/extension";
import { OPTIMIZATION_LAB_QUERIES } from "./queries.js";

export const OPTIMIZATION_LAB_MODULE_ID = "optimization-lab";

/** Optimization Lab as an AgentModule. Every query is namespaced optimization_lab_*. */
export function createOptimizationLabModule(): AgentModule {
  return { id: OPTIMIZATION_LAB_MODULE_ID, protocol: { queries: OPTIMIZATION_LAB_QUERIES } };
}
