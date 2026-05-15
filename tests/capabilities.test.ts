import { describe, expect, test } from "bun:test";
import { capabilitiesFor } from "../src/llm/capabilities/index.js";

describe("capabilitiesFor", () => {
  // ─── OpenAI ─────────────────────────────────────────────────
  test("OpenAI gpt-5.5 uses max_completion_tokens + rejects temperature", () => {
    const c = capabilitiesFor("openai", "gpt-5.5");
    expect(c.tokenLimitField).toBe("max_completion_tokens");
    expect(c.rejectedParams.has("temperature")).toBe(true);
    expect(c.rejectedParams.has("top_p")).toBe(true);
    expect(c.reasoning).toEqual({ kind: "openai-effort" });
  });

  test("OpenAI o3 reasoning model — same rules as gpt-5.x", () => {
    const c = capabilitiesFor("openai", "o3");
    expect(c.tokenLimitField).toBe("max_completion_tokens");
    expect(c.rejectedParams.has("temperature")).toBe(true);
  });

  test("OpenAI gpt-4.1 — classic model keeps max_tokens + temperature", () => {
    const c = capabilitiesFor("openai", "gpt-4.1");
    expect(c.tokenLimitField).toBe("max_tokens");
    expect(c.rejectedParams.has("temperature")).toBe(false);
    expect(c.reasoning.kind).toBe("none");
  });

  test("OpenAI gpt-4o — also classic", () => {
    const c = capabilitiesFor("openai", "gpt-4o");
    expect(c.tokenLimitField).toBe("max_tokens");
    expect(c.reasoning.kind).toBe("none");
  });

  // ─── DeepSeek ──────────────────────────────────────────────
  test("DeepSeek V4 — thinking shape, echo when tools", () => {
    const c = capabilitiesFor("deepseek", "deepseek-v4-pro");
    expect(c.reasoning).toEqual({ kind: "deepseek-thinking" });
    expect(c.echoReasoning).toBe("when-tools");
  });

  test("deepseek-reasoner — never echo, no toggle", () => {
    const c = capabilitiesFor("deepseek", "deepseek-reasoner");
    expect(c.reasoning.kind).toBe("none");
    expect(c.echoReasoning).toBe("never");
  });

  test("DeepSeek chat (non-V4 legacy) — falls through to default", () => {
    const c = capabilitiesFor("deepseek", "deepseek-chat");
    expect(c.reasoning.kind).toBe("none");
    expect(c.echoReasoning).toBe("optional");
  });

  // ─── Z.AI ──────────────────────────────────────────────────
  test("Z.AI GLM-5.1 — DeepSeek-shape thinking", () => {
    const c = capabilitiesFor("zai", "glm-5.1");
    expect(c.reasoning).toEqual({ kind: "deepseek-thinking" });
  });

  test("Z.AI GLM-4.6 — same thinking shape", () => {
    const c = capabilitiesFor("zai", "glm-4.6");
    expect(c.reasoning.kind).toBe("deepseek-thinking");
  });

  // ─── Anthropic ─────────────────────────────────────────────
  test("Claude 4.7 (Opus) — adaptive thinking, no opt-in", () => {
    const c = capabilitiesFor("anthropic", "claude-opus-4-7");
    expect(c.reasoning.kind).toBe("anthropic-adaptive");
    expect(c.parallelToolCalls).toBe("anthropic-disable-flag");
    expect(c.streamUsage).toBe("auto");
  });

  test("Claude 4.6 — also adaptive", () => {
    const c = capabilitiesFor("anthropic", "claude-sonnet-4-6");
    expect(c.reasoning.kind).toBe("anthropic-adaptive");
  });

  test("Claude 4.5 — budget-based thinking", () => {
    const c = capabilitiesFor("anthropic", "claude-sonnet-4-5");
    expect(c.reasoning).toEqual({ kind: "anthropic-budget", minBudgetTokens: 1024 });
    expect(c.parallelToolCalls).toBe("anthropic-disable-flag");
  });

  test("Claude 3.5 — no thinking but Anthropic tool shape", () => {
    const c = capabilitiesFor("anthropic", "claude-3-5-sonnet");
    expect(c.reasoning.kind).toBe("none");
    expect(c.parallelToolCalls).toBe("anthropic-disable-flag");
  });

  // ─── Gemini ────────────────────────────────────────────────
  test("Gemini 2.5 Pro — reasoning_effort via OpenAI-compat", () => {
    const c = capabilitiesFor("google", "gemini-2.5-pro");
    expect(c.reasoning.kind).toBe("openai-effort");
  });

  test("Gemini 3.1 Pro preview — same", () => {
    const c = capabilitiesFor("google", "gemini-3.1-pro-preview");
    expect(c.reasoning.kind).toBe("openai-effort");
  });

  // ─── OpenRouter ────────────────────────────────────────────
  test("OpenRouter — always uses unified reasoning {} object", () => {
    const c1 = capabilitiesFor("openrouter", "anthropic/claude-opus-4.7");
    const c2 = capabilitiesFor("openrouter", "openai/gpt-5.5");
    expect(c1.reasoning.kind).toBe("openrouter-reasoning");
    expect(c2.reasoning.kind).toBe("openrouter-reasoning");
  });

  test("OpenRouter — keeps max_tokens (it accepts both)", () => {
    const c = capabilitiesFor("openrouter", "openai/gpt-5.5");
    expect(c.tokenLimitField).toBe("max_tokens");
  });

  // ─── xAI / Mistral / Groq ──────────────────────────────────
  test("xAI grok-4.3 — reasoning_effort with disabledEffort=low (no `minimal`)", () => {
    const c = capabilitiesFor("xai", "grok-4.3");
    expect(c.reasoning).toEqual({ kind: "openai-effort", disabledEffort: "low" });
  });

  test("Mistral magistral — reasoning_effort with disabledEffort=none (only high|none)", () => {
    const c = capabilitiesFor("mistral", "magistral-medium");
    expect(c.reasoning).toEqual({ kind: "openai-effort", disabledEffort: "none" });
  });

  test("OpenAI gpt-5.5 — openai-effort without explicit disabledEffort (caller defaults to minimal)", () => {
    const c = capabilitiesFor("openai", "gpt-5.5");
    expect(c.reasoning.kind).toBe("openai-effort");
    // Other openai-effort users (OpenAI, Gemini, Groq) accept "minimal" — no
    // override needed, the provider falls back to "minimal" by default.
    expect((c.reasoning as { disabledEffort?: string }).disabledEffort).toBeUndefined();
  });

  test("Groq gpt-oss-20b — max_completion_tokens + effort", () => {
    const c = capabilitiesFor("groq", "gpt-oss-20b");
    expect(c.tokenLimitField).toBe("max_completion_tokens");
    expect(c.reasoning.kind).toBe("openai-effort");
  });

  test("Groq qwen3-32b — same", () => {
    const c = capabilitiesFor("groq", "qwen3-32b");
    expect(c.tokenLimitField).toBe("max_completion_tokens");
  });

  // ─── Default fallback ──────────────────────────────────────
  test("unknown provider+model — returns conservative default", () => {
    const c = capabilitiesFor("custom", "some-mystery-model");
    expect(c.tokenLimitField).toBe("max_tokens");
    expect(c.rejectedParams.size).toBe(0);
    expect(c.reasoning.kind).toBe("none");
    expect(c.echoReasoning).toBe("optional");
    expect(c.parallelToolCalls).toBe("openai-flag");
  });

  test("rejectedParams sets are independent across calls (no mutation)", () => {
    const c1 = capabilitiesFor("openai", "gpt-5.5");
    const c2 = capabilitiesFor("openai", "gpt-5.5");
    const before = c1.rejectedParams.size;
    // logit_bias is already in the set — add something that isn't:
    (c1.rejectedParams as Set<string>).add("__test_only__");
    expect(c1.rejectedParams.size).toBe(before + 1);
    expect(c2.rejectedParams.has("__test_only__" as never)).toBe(false);
  });
});
