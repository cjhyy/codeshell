import { describe, expect, it } from "bun:test";
import {
  createPromptCacheKey,
  PromptCacheHistory,
  resolvePromptCachePolicy,
  uniquePromptCacheBreakpointIndexes,
} from "./prompt-cache.js";

describe("prompt cache policy", () => {
  it("combines implicit tails with explicit boundaries on GPT-5.6 routes", () => {
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
        strategy: "openai-hybrid",
        breakpoints: ["system", "stable-history", "rolling-history"],
        promptCacheOptions: { mode: "implicit", ttl: "30m" },
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

describe("prompt cache history", () => {
  function request(
    messages: string[],
    scopeKey = "scope",
    requestIdentity: unknown = { model: "m" },
  ) {
    return { scopeKey, messages, latestBoundaryIndex: messages.length - 1, requestIdentity };
  }

  it("reads only committed boundaries and advances through an unchanged prefix", () => {
    const history = new PromptCacheHistory();
    const first = history.prepare(request(["system", "user"]));
    expect(first.readBoundaryIndex).toBeUndefined();
    expect(history.prepare(request(["system", "user", "tool"])).readBoundaryIndex).toBeUndefined();
    history.commit(first);
    const second = history.prepare(request(["system", "user", "tool"]));
    expect(second.readBoundaryIndex).toBe(1);
    history.commit(second);
    expect(history.prepare(request(["system", "user", "tool", "next"])).readBoundaryIndex).toBe(2);
  });

  it("rejects rewritten, truncated, reordered, or differently configured prefixes", () => {
    const history = new PromptCacheHistory();
    history.commit(history.prepare(request(["system", "user", "tool"])));
    for (const messages of [
      ["changed", "user", "tool", "next"],
      ["system", "tool", "user", "next"],
      ["system", "summary"],
    ]) {
      expect(history.prepare(request(messages)).readBoundaryIndex).toBeUndefined();
    }
    expect(
      history.prepare(request(["system", "user", "tool"], "scope", { model: "changed" }))
        .readBoundaryIndex,
    ).toBeUndefined();
    expect(
      history.prepare(request(["system", "user", "tool"], "other")).readBoundaryIndex,
    ).toBeUndefined();
  });

  it("retains the successful boundary when a later request fails", () => {
    const history = new PromptCacheHistory();
    history.commit(history.prepare(request(["system", "user"])));
    // An attempted request is prepared but never committed after its failure.
    history.prepare(request(["system", "user", "failed tail"]));
    expect(history.prepare(request(["system", "user", "retry tail"])).readBoundaryIndex).toBe(1);
  });

  it("does not roll back after concurrent requests finish out of order", () => {
    const history = new PromptCacheHistory();
    const older = history.prepare(request(["system", "user"]));
    const newer = history.prepare(request(["system", "user", "tool"]));
    history.commit(newer);
    history.commit(older);
    expect(history.prepare(request(["system", "user", "tool", "next"])).readBoundaryIndex).toBe(2);
  });

  it("expires entries and evicts the least recently successful scope at its bound", () => {
    const history = new PromptCacheHistory(2, 1000);
    history.commit(history.prepare(request(["a"], "a"), 0), 0);
    history.commit(history.prepare(request(["b"], "b"), 10), 10);
    history.commit(history.prepare(request(["a"], "a"), 20), 20);
    history.commit(history.prepare(request(["c"], "c"), 30), 30);
    expect(history.prepare(request(["b"], "b"), 40).readBoundaryIndex).toBeUndefined();
    expect(history.prepare(request(["a"], "a"), 1019).readBoundaryIndex).toBe(0);
    expect(history.prepare(request(["a"], "a"), 1020).readBoundaryIndex).toBeUndefined();
  });

  it("retains hashes and indexes without storing message or request bodies", () => {
    const history = new PromptCacheHistory();
    const plan = history.prepare(
      request(["PRIVATE_SYSTEM", "PRIVATE_TOOL_OUTPUT"], "scope", { secret: "PRIVATE_CONFIG" }),
    );
    history.commit(plan);
    const retained = JSON.stringify({ plan, boundaries: [...(history as any).boundaries] });
    expect(retained).not.toContain("PRIVATE_");
    expect(plan.nextBoundary?.prefixHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
