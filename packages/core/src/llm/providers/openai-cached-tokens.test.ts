import { describe, it, expect } from "bun:test";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * Prompt-cache visibility (docs/todo/prompt-cache-optimization.md §一/§四 step 1).
 *
 * OpenAI caching is automatic — the API reports cache hits under
 * `usage.prompt_tokens_details.cached_tokens`. The client previously read a
 * non-existent `usage.cacheReadTokens`, so the value was always undefined and
 * hit-rate was invisible. These tests pin the correct field mapping for both
 * the non-streaming and streaming paths.
 */

const opts: CreateMessageOptions = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

function nonStreamClient(usage: any): OpenAIClient {
  const client = new OpenAIClient({
    provider: "openai",
    model: "gpt-4o",
    apiKey: "test",
    providerKind: "openai",
    maxTokens: 2048,
  });
  (client as any)._client = {
    chat: {
      completions: {
        create: async () => ({
          id: "x",
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage,
        }),
      },
    },
  };
  return client;
}

function fakeStream(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function streamClient(finalChunkUsage: any): OpenAIClient {
  const client = new OpenAIClient({
    provider: "openai",
    model: "gpt-4o",
    apiKey: "test",
    providerKind: "openai",
    maxTokens: 2048,
  });
  const chunks = [
    { choices: [{ delta: { content: "done" } }] },
    // Final chunk carries finish_reason + usage like the real SDK does when
    // stream_options.include_usage is set.
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: finalChunkUsage },
  ];
  (client as any)._client = {
    chat: { completions: { create: async () => fakeStream(chunks) } },
  };
  return client;
}

describe("OpenAIClient cached-token mapping", () => {
  it("maps prompt_tokens_details.cached_tokens → usage.cacheReadTokens (non-stream)", async () => {
    const client = nonStreamClient({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    const resp = await client.createMessage(opts);
    expect(resp.usage?.promptTokens).toBe(1000);
    expect(resp.usage?.cacheReadTokens).toBe(800);
  });

  it("maps prompt_tokens_details.cached_tokens → usage.cacheReadTokens (stream)", async () => {
    const client = streamClient({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 600 },
    });
    const resp = await client.createMessage({ ...opts, stream: true, tools: [], onChunk: () => {} });
    expect(resp.usage?.promptTokens).toBe(1000);
    expect(resp.usage?.cacheReadTokens).toBe(600);
  });

  it("leaves cacheReadTokens undefined when the API reports no cache details", async () => {
    const client = nonStreamClient({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    const resp = await client.createMessage(opts);
    expect(resp.usage?.cacheReadTokens).toBeUndefined();
  });
});
