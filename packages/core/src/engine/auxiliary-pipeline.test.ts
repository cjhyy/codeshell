import { describe, expect, it } from "bun:test";
import type { LLMConfig } from "../types.js";
import { sameLlmIdentity } from "./auxiliary-pipeline.js";

const base: LLMConfig = {
  apiKey: "primary-key",
  model: "model-a",
  provider: "openai",
  baseUrl: "https://example.test/v1",
};

describe("sameLlmIdentity", () => {
  it("ignores credentials but compares request-shaping fields", () => {
    expect(sameLlmIdentity(base, { ...base, apiKey: "rotated-key" })).toBe(true);
    expect(sameLlmIdentity(base, { ...base, reasoning: { mode: "off" } })).toBe(false);
    expect(sameLlmIdentity(base, { ...base, maxTokens: 2048 })).toBe(false);
  });
});
