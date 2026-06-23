import { describe, it, expect } from "bun:test";
import {
  deriveModelPoolKey,
  buildModelPool,
  modelDisplayName,
  PROVIDERS,
} from "./onboarding.js";

/**
 * deriveModelPoolKey is the fix for the old modelKey() silent-shadowing bug:
 * distinct models must get distinct pool keys (the old code folded multiple ids
 * to one key, shadowing entries in the pool). buildModelPool / modelDisplayName
 * were untested. These pin the collision-avoidance + label behavior.
 */
describe("deriveModelPoolKey — collision-free pool keys", () => {
  it("prefixes the provider kind when the model id doesn't already start with it", () => {
    expect(deriveModelPoolKey("openai", "gpt-5")).toBe("openai-gpt-5");
    // strips vendor/ prefix from the model id first
    expect(deriveModelPoolKey("openrouter", "anthropic/claude-opus-4.7")).toBe(
      "openrouter-claude-opus-4.7",
    );
  });

  it("does not double-prefix when the base already starts with the kind", () => {
    // base "openai-foo" already starts with "openai-" → kept as-is
    expect(deriveModelPoolKey("openai", "openai-foo")).toBe("openai-foo");
  });

  it("disambiguates collisions with a numeric suffix instead of shadowing", () => {
    const used: string[] = [];
    // "deepseek-chat" already starts with "deepseek-" → no double-prefix.
    const k1 = deriveModelPoolKey("deepseek", "deepseek-chat", used);
    used.push(k1);
    // Re-deriving the SAME candidate while it's already used must NOT collide —
    // it gets -2, -3, … so neither shadows the other (the old modelKey() bug).
    const k2 = deriveModelPoolKey("deepseek", "deepseek-chat", used);
    used.push(k2);
    const k3 = deriveModelPoolKey("deepseek", "deepseek-chat", used);
    expect(k1).toBe("deepseek-chat");
    expect(k2).toBe("deepseek-chat-2");
    expect(k3).toBe("deepseek-chat-3");
    expect(new Set([k1, k2, k3]).size).toBe(3); // all distinct
  });
});

describe("buildModelPool", () => {
  it("produces one distinct key per model with metadata wired in", () => {
    const anthropic = PROVIDERS.find((p) => p.id === "anthropic")!;
    const pool = buildModelPool(anthropic, "sk-ant-test");
    expect(pool.length).toBe(anthropic.models.length);
    // keys are unique
    expect(new Set(pool.map((e) => e.key)).size).toBe(pool.length);
    // each entry carries the provider's adapter kind, baseUrl, and the key
    for (const e of pool) {
      expect(e.provider).toBe("anthropic");
      expect(e.baseUrl).toBe(anthropic.baseUrl);
      expect(e.apiKey).toBe("sk-ant-test");
    }
  });
});

describe("modelDisplayName", () => {
  it("formats known families and strips vendor prefixes", () => {
    expect(modelDisplayName("anthropic/claude-sonnet-4-6")).toBe("Claude Sonnet");
    expect(modelDisplayName("gpt-5-mini")).toBe("GPT-5-mini");
    expect(modelDisplayName("gemini-2.5-pro")).toBe("Gemini 2.5-pro");
    // unknown family → capitalized base
    expect(modelDisplayName("mistral-large")).toBe("Mistral-large");
  });
});
