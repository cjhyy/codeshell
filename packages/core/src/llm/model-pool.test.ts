import { describe, it, expect } from "bun:test";
import { ModelPool } from "./model-pool.js";

describe("ModelPool.toLLMConfig maxTokens", () => {
  it("leaves maxTokens undefined when the entry has no maxOutputTokens", () => {
    const pool = new ModelPool();
    const cfg = pool.toLLMConfig({
      key: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      // no maxOutputTokens — must NOT invent 8192
    });
    expect(cfg.maxTokens).toBeUndefined();
  });

  it("carries maxOutputTokens through unchanged when present", () => {
    const pool = new ModelPool();
    const cfg = pool.toLLMConfig({
      key: "deepseek",
      provider: "openai",
      model: "deepseek-chat",
      maxOutputTokens: 128000,
    });
    expect(cfg.maxTokens).toBe(128000);
  });
});
