import { describe, it, expect } from "bun:test";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

/** Capture the request body the client sends to the (stubbed) SDK. */
function clientCapturing(
  config: ConstructorParameters<typeof OpenAIClient>[0],
): { client: OpenAIClient; lastBody: () => any } {
  const client = new OpenAIClient(config);
  let body: any;
  (client as any)._client = {
    chat: {
      completions: {
        create: async (b: any) => {
          body = b;
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] };
            },
          };
        },
      },
    },
  };
  return { client, lastBody: () => body };
}

const opts = (): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  stream: true,
  onChunk: () => {},
});

describe("OpenAIClient max_tokens clamp", () => {
  it("clamps a stale 384000 down to gpt-5.5's 128k cap", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 384_000, // the bleed value
    });
    await client.createMessage(opts());
    // gpt-5.5 uses max_completion_tokens, clamped to 128k.
    expect(lastBody().max_completion_tokens).toBe(128_000);
    expect(lastBody().max_tokens).toBeUndefined();
  });

  it("leaves a within-cap value untouched", async () => {
    const { client, lastBody } = clientCapturing({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 16_000,
    });
    await client.createMessage(opts());
    expect(lastBody().max_completion_tokens).toBe(16_000);
  });
});
