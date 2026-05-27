import { describe, it, expect } from "bun:test";
import { ModelPool } from "../packages/core/src/llm/model-pool.ts";
import { resolveChildLlm } from "../packages/core/src/engine/engine.ts";

const baseLlm = {
  provider: "openai",
  model: "anthropic/claude-opus-4-6",
  baseUrl: "https://parent.example/v1",
  apiKey: "parent-key",
} as const;

function poolWithFlash(): ModelPool {
  const pool = new ModelPool();
  pool.register({ key: "flash", provider: "google", model: "gemini-flash", baseUrl: "https://flash.example/v1", apiKey: "flash-key" });
  return pool;
}

describe("resolveChildLlm", () => {
  it("returns parent llm unchanged when no model requested", () => {
    const llm = resolveChildLlm(undefined, poolWithFlash(), baseLlm);
    expect(llm.model).toBe("anthropic/claude-opus-4-6");
    expect(llm.baseUrl).toBe("https://parent.example/v1");
  });

  it("resolves the requested model key from the pool", () => {
    const llm = resolveChildLlm("flash", poolWithFlash(), baseLlm);
    expect(llm.model).toBe("gemini-flash");
    expect(llm.baseUrl).toBe("https://flash.example/v1");
    expect(llm.apiKey).toBe("flash-key");
  });

  it("falls back to parent llm when the key is unknown (no throw)", () => {
    const llm = resolveChildLlm("nonexistent", poolWithFlash(), baseLlm);
    expect(llm.model).toBe("anthropic/claude-opus-4-6");
  });

  it("falls back to parent llm when there is no pool", () => {
    const llm = resolveChildLlm("flash", undefined, baseLlm);
    expect(llm.model).toBe("anthropic/claude-opus-4-6");
  });
});
