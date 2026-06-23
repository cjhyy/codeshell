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

describe("ModelPool.toLLMConfig extraBody passthrough", () => {
  it("carries entry.extraBody into LLMConfig", () => {
    const pool = new ModelPool([]);
    const entry = { key: "k", provider: "openai", model: "m", apiKey: "x", baseUrl: "u", extraBody: { temperature: 0.7, top_p: 0.9 } };
    pool.register(entry as never);
    const cfg = pool.toLLMConfig(entry as never);
    expect(cfg.extraBody).toEqual({ temperature: 0.7, top_p: 0.9 });
  });
  it("omits extraBody when entry has none", () => {
    const pool = new ModelPool([]);
    const entry = { key: "k2", provider: "openai", model: "m", apiKey: "x", baseUrl: "u" };
    pool.register(entry as never);
    const cfg = pool.toLLMConfig(entry as never);
    expect(cfg.extraBody).toBeUndefined();
  });
});
