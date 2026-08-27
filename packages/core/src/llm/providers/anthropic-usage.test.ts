import { describe, expect, it } from "bun:test";
import { AnthropicClient } from "./anthropic.js";

describe("AnthropicClient token usage", () => {
  it("counts cache reads and writes in the prompt/context total", async () => {
    const client = new AnthropicClient({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test",
    });
    (client as any)._client = {
      messages: {
        create: async () => ({
          id: "usage-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1_000,
            cache_read_input_tokens: 80_000,
            cache_creation_input_tokens: 5_000,
            output_tokens: 200,
          },
        }),
      },
    };

    const response = await client.createMessage({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: false,
    });

    expect(response.usage).toEqual({
      promptTokens: 86_000,
      completionTokens: 200,
      totalTokens: 86_200,
      cacheReadTokens: 80_000,
      cacheCreationTokens: 5_000,
    });
  });

  it("keeps cache counters absent when Anthropic did not report them", async () => {
    const client = new AnthropicClient({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "test",
    });
    (client as any)._client = {
      messages: {
        create: async () => ({
          id: "usage-test-no-cache",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1_000, output_tokens: 200 },
        }),
      },
    };

    const response = await client.createMessage({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: false,
    });

    expect(response.usage).toEqual({
      promptTokens: 1_000,
      completionTokens: 200,
      totalTokens: 1_200,
    });
  });
});
