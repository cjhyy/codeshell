import type { ModelPool } from "../llm/model-pool.js";
import { getMergedCatalog } from "../model-catalog/index.js";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import { defaultCacheDir } from "../llm/model-cache.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { SettingsManager } from "../settings/manager.js";
import type { MCPManager } from "../tool-system/mcp-manager.js";
import type { CostTracker } from "../cost-tracker.js";
import {
  resolveSandboxBackend,
  type SandboxBackend,
  type SandboxConfig,
} from "../tool-system/sandbox/index.js";
import { sandboxCacheKey } from "./sandbox-cache-key.js";
import { LifetimeScope, onceDispose, type Dispose } from "../composition/lifetime.js";
import { UsageLedger } from "../cost-ledger/store.js";

export interface EngineRuntimeOptions {
  modelPool: ModelPool;
  toolRegistry: ToolRegistry;
  settings: SettingsManager;
  mcpPool: MCPManager;
  costTracker: CostTracker;
  usageLedger?: UsageLedger;
  usageStorageDir?: string;
}

/**
 * Shared read-only resources used by all Engine instances in a worker.
 * Mutable per-session state stays on Engine itself.
 */
export class EngineRuntime {
  readonly lifetime = new LifetimeScope("host", "runtime");
  readonly modelPool: ModelPool;
  readonly toolRegistry: ToolRegistry;
  readonly settings: SettingsManager;
  readonly mcpPool: MCPManager;
  readonly costTracker: CostTracker;
  readonly usageLedger: UsageLedger;
  private engines = new Set<() => Promise<void>>();
  private closing?: Promise<void>;

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
    this.usageLedger =
      opts.usageLedger ??
      new UsageLedger({
        storageDir: opts.usageStorageDir,
      });
    this.costTracker.bindLedger?.(this.usageLedger);
    this.lifetime.own(() => this.modelPool.clear());
    this.lifetime.own(() => this.toolRegistry.clear());
    this.lifetime.own(() => this.sandboxCache.clear());
    this.lifetime.own(() => this.mcpPool.disconnectAll());
  }

  clearModels(): void {
    this.modelPool.clear();
  }

  /** Quiesce active Engines before releasing their scopes and shared MCP resources. */
  ownEngine(close: () => Promise<void>): Dispose {
    if (this.closing || this.lifetime.disposed) throw new Error("EngineRuntime has been closed");
    this.engines.add(close);
    return onceDispose(() => {
      this.engines.delete(close);
    });
  }

  reloadModelsFromSettings(): void {
    const settings = this.settings.load();
    const connections = (settings as { modelConnections?: unknown[] }).modelConnections ?? [];
    const credentials = (settings as { credentials?: unknown[] }).credentials ?? [];
    const catalog = getMergedCatalog();
    const entries = modelEntriesFromConnections(
      connections as never[],
      credentials as never[],
      catalog,
    );
    this.modelPool.clear();
    if (entries.length === 0) return;
    for (const entry of entries) this.modelPool.register(entry);
    if (entries.length > 0) {
      const defaultText = (settings as { defaults?: { text?: string } }).defaults?.text;
      const key =
        defaultText && entries.some((e) => e.key === defaultText) ? defaultText : entries[0].key;
      this.modelPool.switch(key);
      this.modelPool.setCacheDir(defaultCacheDir());
      this.modelPool.reloadCachedContextWindows();
    }
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
    const key = sandboxCacheKey(config, cwd);
    let cached = this.sandboxCache.get(key);
    if (!cached) {
      cached = resolveSandboxBackend(config, cwd);
      // Don't cache a rejection: an explicit-mode probe that throws (e.g.
      // `seatbelt` on a host without sandbox-exec) must be retryable after the
      // user fixes the config, not sticky until process restart.
      cached.catch(() => {
        if (this.sandboxCache.get(key) === cached) this.sandboxCache.delete(key);
      });
      this.sandboxCache.set(key, cached);
    }
    return cached;
  }

  /**
   * Tear down runtime-owned resources. Safe to call multiple times; the
   * MCPManager's `disconnectAll` clears its own connection map and the
   * sandbox cache holds resolved-backend promises that don't need
   * explicit cleanup (they're plain objects). Closes Gate 2 bullet
   * "runtime close shuts down MCP connections, timers, and background
   * work."
   *
   * Hosts that own a long-lived Runtime (the stdio worker, future
   * Electron broker, codeshell-serve) should `await runtime.close()`
   * before exiting the process — otherwise MCP child processes may be
   * left running and bound ports may stay held until the OS cleans up.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const results = await Promise.allSettled(
        [...this.engines].reverse().map((close) => Promise.resolve().then(close)),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      try {
        await this.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "EngineRuntime shutdown failed");
    })();
    return this.closing;
  }
}
