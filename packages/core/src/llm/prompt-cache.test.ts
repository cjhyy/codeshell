import { describe, expect, it } from "bun:test";
import {
  createPromptCacheKey,
  resolvePromptCachePolicy,
  uniquePromptCacheBreakpointIndexes,
} from "./prompt-cache.js";

describe("prompt cache policy", () => {
  it("uses GPT-5.6 explicit caching on native OpenAI and OpenRouter OpenAI routes", () => {
    for (const input of [
      { provider: "openai", providerKind: "openai", model: "gpt-5.6-sol" },
      {
        provider: "openai",
        providerKind: "openrouter",
        model: "openai/gpt-5.6-sol",
      },
    ]) {
      expect(
        resolvePromptCachePolicy({
          ...input,
          request: { scopeId: "s-cache" },
        }),
      ).toMatchObject({
        strategy: "openai-explicit",
        breakpoints: ["system", "stable-history", "rolling-history"],
        promptCacheOptions: { mode: "explicit", ttl: "30m" },
      });
    }
  });

  it("keeps older OpenAI models on implicit prefix caching with session affinity", () => {
    const policy = resolvePromptCachePolicy({
      provider: "openai",
      providerKind: "openai",
      model: "gpt-5.5",
      request: { scopeId: "s-cache" },
    });
    expect(policy.strategy).toBe("openai-implicit");
    expect(policy.breakpoints).toEqual([]);
    expect(policy.cacheKey).toMatch(/^cs:[a-f0-9]{48}$/);
  });

  it("uses four semantic boundaries for native Anthropic and three through OpenRouter", () => {
    expect(
      resolvePromptCachePolicy({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }).breakpoints,
    ).toEqual(["system", "tools", "stable-history", "rolling-history"]);
    expect(
      resolvePromptCachePolicy({
        provider: "openai",
        providerKind: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      }).breakpoints,
    ).toEqual(["system", "stable-history", "rolling-history"]);
  });

  it("falls back from explicit to implicit without changing the affinity key", () => {
    const base = {
      provider: "openai",
      providerKind: "openrouter",
      model: "openai/gpt-5.6-sol",
      request: { scopeId: "s-cache" },
    };
    const explicit = resolvePromptCachePolicy(base);
    const fallback = resolvePromptCachePolicy({ ...base, explicitDisabled: true });
    expect(fallback.strategy).toBe("openai-implicit");
    expect(fallback.cacheKey).toBe(explicit.cacheKey);
  });

  it("produces opaque bounded keys and ordered unique breakpoint indexes", () => {
    const key = createPromptCacheKey("user-visible-session", "openai:gpt-5.6-sol");
    expect(key.length).toBeLessThanOrEqual(64);
    expect(key).not.toContain("user-visible-session");
    expect(uniquePromptCacheBreakpointIndexes([0, 4, 4, undefined, -1, 9])).toEqual([0, 4, 9]);
  });
});
