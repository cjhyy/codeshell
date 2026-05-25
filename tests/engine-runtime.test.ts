import { describe, it, expect } from "bun:test";
import { EngineRuntime } from "../packages/core/src/engine/runtime.ts";
import { ModelPool } from "../packages/core/src/llm/model-pool.ts";

describe("EngineRuntime", () => {
  it("exposes shared resources passed in at construction", () => {
    const modelPool = {} as ModelPool;
    const rt = new EngineRuntime({ modelPool });
    expect(rt.modelPool).toBe(modelPool);
  });
});
