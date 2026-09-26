import type { AgentModule } from "@cjhyy/code-shell-core/extension";

export const OPTIMIZATION_LAB_MODULE_ID = "optimization-lab";

/** Optimization Lab as an AgentModule. Queries are added as the lab grows. */
export function createOptimizationLabModule(): AgentModule {
  return { id: OPTIMIZATION_LAB_MODULE_ID, protocol: { queries: {} } };
}
