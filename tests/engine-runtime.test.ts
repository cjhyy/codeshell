import { describe, it, expect } from "bun:test";
import { EngineRuntime } from "../packages/core/src/engine/runtime.ts";
import { ModelPool } from "../packages/core/src/llm/model-pool.ts";

describe("EngineRuntime", () => {
  it("exposes shared resources passed in at construction", () => {
    const modelPool = {} as any;
    const toolRegistry = {} as any;
    const settings = {} as any;
    const mcpPool = {} as any;
    const costTracker = {} as any;
    const rt = new EngineRuntime({ modelPool, toolRegistry, settings, mcpPool, costTracker });
    expect(rt.modelPool).toBe(modelPool);
    expect(rt.toolRegistry).toBe(toolRegistry);
    expect(rt.settings).toBe(settings);
    expect(rt.mcpPool).toBe(mcpPool);
    expect(rt.costTracker).toBe(costTracker);
  });

  it("holds toolRegistry, settings, mcpPool, costTracker", () => {
    const modelPool = {} as any;
    const toolRegistry = {} as any;
    const settings = {} as any;
    const mcpPool = {} as any;
    const costTracker = {} as any;
    const rt = new EngineRuntime({ modelPool, toolRegistry, settings, mcpPool, costTracker });
    expect(rt.toolRegistry).toBe(toolRegistry);
    expect(rt.settings).toBe(settings);
    expect(rt.mcpPool).toBe(mcpPool);
    expect(rt.costTracker).toBe(costTracker);
  });
});
