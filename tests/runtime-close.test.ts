/** Runtime shutdown quiesces Engines before releasing its shared resources once. */
import { describe, it, expect } from "bun:test";
import { EngineRuntime } from "../packages/core/src/engine/runtime.js";
import { ModelPool } from "../packages/core/src/llm/model-pool.js";
import { ToolRegistry } from "../packages/core/src/tool-system/registry.js";
import { SettingsManager } from "../packages/core/src/settings/manager.js";
import { CostTracker } from "../packages/core/src/cost-tracker.js";
import type { MCPManager } from "../packages/core/src/tool-system/mcp-manager.js";

function makeRuntime(disconnect?: () => Promise<void>) {
  const state = { disconnects: 0 };
  const modelPool = new ModelPool();
  modelPool.register({ key: "fixture", provider: "fixture", model: "fixture" });
  const toolRegistry = new ToolRegistry({ builtinTools: [] });
  toolRegistry.registerTool({
    name: "FixtureTool",
    description: "In-memory shutdown fixture",
    inputSchema: { type: "object", properties: {} },
    source: "builtin",
    permissionDefault: "allow",
  });
  const runtime = new EngineRuntime({
    modelPool,
    toolRegistry,
    settings: new SettingsManager("/unused", "isolated"),
    mcpPool: {
      disconnectAll: async () => {
        state.disconnects += 1;
        await disconnect?.();
      },
    } as MCPManager,
    costTracker: new CostTracker(),
  });
  return { runtime, state, modelPool, toolRegistry };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("EngineRuntime.close (Gate 2)", () => {
  it("disconnects MCP connections and clears real model and tool registries", async () => {
    const { runtime, state, modelPool, toolRegistry } = makeRuntime();
    expect(modelPool.size).toBe(1);
    expect(toolRegistry.hasTool("FixtureTool")).toBe(true);
    await runtime.close();
    expect(state.disconnects).toBe(1);
    expect(modelPool.size).toBe(0);
    expect(toolRegistry.getToolDefinitions()).toEqual([]);
  });

  it("shares pending shutdown and releases every resource exactly once", async () => {
    const engineStarted = deferred();
    const engineFinished = deferred();
    const { runtime, state, modelPool } = makeRuntime();
    let closes = 0;
    runtime.ownEngine(async () => {
      closes += 1;
      engineStarted.resolve();
      await engineFinished.promise;
    });
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await engineStarted.promise;
    // A running Engine can still use shared resources until it has quiesced.
    expect(state.disconnects).toBe(0);
    expect(modelPool.size).toBe(1);
    expect(() => runtime.ownEngine(async () => {})).toThrow("closed");
    engineFinished.resolve();
    await first;
    await runtime.close();
    expect(closes).toBe(1);
    expect(state.disconnects).toBe(1);
    expect(modelPool.size).toBe(0);
  });

  it("clears the sandbox cache on shutdown", async () => {
    const { runtime } = makeRuntime();
    const cache = (runtime as any).sandboxCache as Map<string, unknown>;
    cache.set("auto:/x", Promise.resolve("backend"));
    expect(cache.size).toBe(1);
    await runtime.close();
    expect(cache.size).toBe(0);
  });

  it("releases shared resources after an Engine or MCP shutdown failure", async () => {
    const { runtime, state, modelPool, toolRegistry } = makeRuntime(async () => {
      throw new Error("synthetic MCP close failure");
    });
    let closes = 0;
    runtime.ownEngine(async () => {
      closes += 1;
      throw new Error("synthetic Engine close failure");
    });
    const first = runtime.close();
    await expect(first).rejects.toBeInstanceOf(AggregateError);
    expect(state.disconnects).toBe(1);
    expect(closes).toBe(1);
    expect(modelPool.size).toBe(0);
    expect(toolRegistry.getToolDefinitions()).toEqual([]);
    expect(runtime.close()).toBe(first);
  });
});
