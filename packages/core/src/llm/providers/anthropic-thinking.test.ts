import { describe, it, expect } from "bun:test";
import { AnthropicClient } from "./anthropic.js";
import type { CreateMessageOptions } from "../types.js";
import type { ReasoningSetting } from "../reasoning-setting.js";

/**
 * P1 — Anthropic was completely missing thinking/reasoning support: a configured
 * `reasoning` setting was silently dropped. These tests stub the SDK and assert
 * the `thinking` field the client builds, using the same capturing seam as
 * anthropic-max-tokens.test.ts (real entry point: createMessage → SDK body).
 */
function clientCapturing(
  config: ConstructorParameters<typeof AnthropicClient>[0],
): { client: AnthropicClient; lastBody: () => any } {
  const client = new AnthropicClient(config);
  let body: any;
  (client as any)._client = {
    messages: {
      create: async (b: any) => {
        body = b;
        return {
          id: "x",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  return { client, lastBody: () => body };
}

const opts = (reasoning?: ReasoningSetting): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  stream: false,
  onChunk: () => {},
  ...(reasoning ? { reasoning } : {}),
});

// claude-opus-4-5 → anthropic-budget (minBudgetTokens 1024).
const BUDGET_MODEL = "claude-opus-4-5";
// claude-sonnet-4-6 → anthropic-adaptive (thinking is automatic, uncontrollable).
const ADAPTIVE_MODEL = "claude-sonnet-4-6";

describe("AnthropicClient thinking — anthropic-budget", () => {
  it("{mode:budget} sends thinking:{type:enabled,budget_tokens}", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
      maxTokens: 32_000,
    });
    await client.createMessage(opts({ mode: "budget", budgetTokens: 8000 }));
    expect(lastBody().thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });

  it("clamps budget up to the model's minBudgetTokens", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
      maxTokens: 32_000,
    });
    await client.createMessage(opts({ mode: "budget", budgetTokens: 10 }));
    expect(lastBody().thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("{mode:on} uses a default budget (≥ min)", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
      maxTokens: 32_000,
    });
    await client.createMessage(opts({ mode: "on" }));
    expect(lastBody().thinking.type).toBe("enabled");
    expect(lastBody().thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
  });

  it("{mode:effort} on a budget model is treated as on (default budget)", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
      maxTokens: 32_000,
    });
    await client.createMessage(opts({ mode: "effort", effort: "high" }));
    expect(lastBody().thinking.type).toBe("enabled");
    expect(lastBody().thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
  });

  it("{mode:off} does NOT send thinking", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
    });
    await client.createMessage(opts({ mode: "off" }));
    expect(lastBody().thinking).toBeUndefined();
  });

  it("no reasoning set → no thinking field", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
    });
    await client.createMessage(opts());
    expect(lastBody().thinking).toBeUndefined();
  });

  it("caps budget below max_tokens (max_tokens must exceed budget_tokens)", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
      maxTokens: 8000,
    });
    await client.createMessage(opts({ mode: "budget", budgetTokens: 100_000 }));
    expect(lastBody().thinking.budget_tokens).toBeLessThan(lastBody().max_tokens);
  });

  it("falls back to config.reasoning when no per-call reasoning", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: BUDGET_MODEL,
      apiKey: "test",
      maxTokens: 32_000,
      reasoning: { mode: "budget", budgetTokens: 5000 },
    });
    await client.createMessage(opts());
    expect(lastBody().thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
  });
});

describe("AnthropicClient thinking — anthropic-adaptive (Claude 4.6+)", () => {
  it("{mode:off} does NOT send a thinking field", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: ADAPTIVE_MODEL,
      apiKey: "test",
    });
    await client.createMessage(opts({ mode: "off" }));
    expect(lastBody().thinking).toBeUndefined();
  });

  it("never sends thinking even with an explicit budget (would 400)", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: ADAPTIVE_MODEL,
      apiKey: "test",
      maxTokens: 32_000,
    });
    await client.createMessage(opts({ mode: "budget", budgetTokens: 8000 }));
    expect(lastBody().thinking).toBeUndefined();
  });
});
