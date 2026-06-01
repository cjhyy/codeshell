import { describe, it, expect } from "bun:test";
import { AnthropicClient } from "./anthropic.js";
import type { CreateMessageOptions } from "../types.js";

/** Capture the request body the client sends to the (stubbed) SDK. */
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

const opts = (): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  stream: false,
  onChunk: () => {},
});

describe("AnthropicClient max_tokens (required field)", () => {
  it("supplies a conservative default when neither a requested value nor config maxTokens exists", async () => {
    // Anthropic requires max_tokens. After dropping client-base's `?? 8192`,
    // this.maxTokens can be undefined — but we must never send max_tokens:undefined.
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKey: "test",
      // no maxTokens
    });
    await client.createMessage(opts());
    expect(typeof lastBody().max_tokens).toBe("number");
    expect(lastBody().max_tokens).toBeGreaterThan(0);
  });

  it("honors a configured maxTokens", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKey: "test",
      maxTokens: 32_000,
    });
    await client.createMessage(opts());
    expect(lastBody().max_tokens).toBe(32_000);
  });
});
