/**
 * EngineRuntime.close() — Gate 2 bullet "runtime close shuts down MCP
 * connections, timers, and background work."
 *
 * The real MCPManager owns child processes; we don't spawn one here.
 * The test uses a fake mcpPool implementing the disconnectAll contract
 * and asserts close() calls it. It also covers the idempotency claim
 * in the docstring (safe to call twice).
 */
import { describe, it, expect } from "bun:test";
import { EngineRuntime } from "../packages/core/src/engine/runtime.ts";

function makeRuntime(): { runtime: EngineRuntime; disconnects: number } {
  const state = { disconnects: 0 };
  const fakeMcp = {
    disconnectAll: async () => {
      state.disconnects += 1;
    },
  };
  const runtime = new EngineRuntime({
    modelPool: {} as any,
    toolRegistry: {} as any,
    settings: {} as any,
    mcpPool: fakeMcp as any,
    costTracker: {} as any,
  });
  return { runtime, disconnects: state.disconnects } as any;
}

describe("EngineRuntime.close (Gate 2)", () => {
  it("disconnects MCP connections", async () => {
    const calls = { n: 0 };
    const runtime = new EngineRuntime({
      modelPool: {} as any,
      toolRegistry: {} as any,
      settings: {} as any,
      mcpPool: { disconnectAll: async () => { calls.n += 1; } } as any,
      costTracker: {} as any,
    });
    await runtime.close();
    expect(calls.n).toBe(1);
  });

  it("is idempotent — second call still resolves and re-disconnects (no internal flag)", async () => {
    // We don't guard with a "closed" flag because MCPManager.disconnectAll
    // is itself idempotent (it clears the connections map). Calling twice
    // is benign; the test just asserts no error throws.
    const runtime = new EngineRuntime({
      modelPool: {} as any,
      toolRegistry: {} as any,
      settings: {} as any,
      mcpPool: { disconnectAll: async () => {} } as any,
      costTracker: {} as any,
    });
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("clears the sandbox cache so subsequent resolveSandbox re-probes", async () => {
    const runtime = new EngineRuntime({
      modelPool: {} as any,
      toolRegistry: {} as any,
      settings: {} as any,
      mcpPool: { disconnectAll: async () => {} } as any,
      costTracker: {} as any,
    });
    // Access the private cache via an `as any` cast — runtime is the unit
    // under test, and the cache invariant is the whole point of this case.
    const cache = (runtime as any).sandboxCache as Map<string, unknown>;
    cache.set("auto:/x", Promise.resolve("backend"));
    expect(cache.size).toBe(1);
    await runtime.close();
    expect(cache.size).toBe(0);
  });
});
