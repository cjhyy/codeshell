import type { ModelPool } from "../llm/model-pool.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { SettingsManager } from "../settings/manager.js";
import type { MCPManager } from "../tool-system/mcp-manager.js";
import type { CostTracker } from "../cost-tracker.js";
import {
  resolveSandboxBackend,
  type SandboxBackend,
  type SandboxConfig,
} from "../tool-system/sandbox/index.js";

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

  // A2: cached sandbox backends, keyed by (mode + cwd). The capability
  // probe (seatbelt availability, bwrap binary) and the per-turn
  // downgrade-to-off warning fire at most once per (mode, cwd) pair
  // per Runtime — not once per turn.
  private sandboxCache = new Map<string, Promise<SandboxBackend>>();

  constructor(opts: EngineRuntimeOptions) {
    this.modelPool = opts.modelPool;
    this.toolRegistry = opts.toolRegistry;
    this.settings = opts.settings;
    this.mcpPool = opts.mcpPool;
    this.costTracker = opts.costTracker;
  }

  /**
   * Lazily resolve and cache a sandbox backend for `(mode, cwd)`.
   *
   * Explicit modes (`seatbelt`, `bwrap`) propagate the underlying
   * `resolveSandboxBackend` throw — there is no silent downgrade. Only
   * `auto` may degrade to `off` (handled inside the resolver itself).
   * The Engine must not catch the throw at turn time; doing so would
   * violate standard §S4 fail-closed rule.
   */
  resolveSandbox(config: SandboxConfig, cwd: string): Promise<SandboxBackend> {
    const key = `${config.mode}:${cwd}`;
    let cached = this.sandboxCache.get(key);
    if (!cached) {
      cached = resolveSandboxBackend(config, cwd);
      this.sandboxCache.set(key, cached);
    }
    return cached;
  }
}
