import { describe, it, expect } from "bun:test";
import { EngineRuntime } from "../packages/core/src/engine/runtime.ts";
import { ModelPool } from "../packages/core/src/llm/model-pool.ts";
import { ToolRegistry } from "../packages/core/src/tool-system/registry.ts";

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

  it("B1: resolveSandbox caches per (mode, cwd)", async () => {
    const { defaultSandboxConfig } =
      await import("../packages/core/src/tool-system/sandbox/index.ts");
    const rt = new EngineRuntime({
      modelPool: {} as any,
      toolRegistry: new ToolRegistry({ builtinTools: [] }),
      settings: {} as any,
      mcpPool: {} as any,
      costTracker: {} as any,
    });
    const cfg = defaultSandboxConfig("off");
    const a = await rt.resolveSandbox(cfg, process.cwd());
    const b = await rt.resolveSandbox(cfg, process.cwd());
    // Same backend instance — the second call hits the cache.
    expect(a).toBe(b);
  });

  it("Engine accepts a shared EngineRuntime via constructor", async () => {
    const { Engine } = await import("../packages/core/src/engine/engine.ts");
    const rt = new EngineRuntime({
      modelPool: {} as any,
      toolRegistry: new ToolRegistry({ builtinTools: [] }),
      settings: {} as any,
      mcpPool: {} as any,
      costTracker: {} as any,
    });
    const e = new Engine({ runtime: rt, cwd: "/tmp", llm: { provider: "noop" } as any });
    expect(e.runtime).toBe(rt);
  });

  it("Engine exposes planMode/permissionMode as instance fields", async () => {
    const { Engine } = await import("../packages/core/src/engine/engine.ts");
    const e = new Engine({ cwd: "/tmp", llm: { provider: "noop" } as any, permissionMode: "plan" });
    expect(e.permissionMode).toBe("plan");
    expect(e.planMode).toBe(true);
  });
});
