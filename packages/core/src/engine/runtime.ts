import type { ModelPool } from "../llm/model-pool.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { SettingsManager } from "../settings/manager.js";
import type { MCPManager } from "../tool-system/mcp-manager.js";
import type { CostTracker } from "../cost-tracker.js";

export interface EngineRuntimeOptions {
  modelPool: ModelPool;
  toolRegistry: ToolRegistry;
  settings: SettingsManager;
  mcpPool: MCPManager;
  costTracker: CostTracker;
}

/**
 * Shared read-only resources used by all Engine instances in a worker.
 * Mutable per-session state stays on Engine itself.
 */
export class EngineRuntime {
  readonly modelPool: ModelPool;
  readonly toolRegistry: ToolRegistry;
  readonly settings: SettingsManager;
  readonly mcpPool: MCPManager;
  readonly costTracker: CostTracker;

  constructor(opts: EngineRuntimeOptions) {
    this.modelPool = opts.modelPool;
    this.toolRegistry = opts.toolRegistry;
    this.settings = opts.settings;
    this.mcpPool = opts.mcpPool;
    this.costTracker = opts.costTracker;
  }
}
