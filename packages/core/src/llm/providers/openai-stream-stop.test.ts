import { describe, it, expect } from "bun:test";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * Build a fake OpenAI streaming response: an async-iterable of chat-completion
 * chunks. The final chunk carries `finish_reason` like the real SDK does.
 */
function fakeStream(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** An OpenAIClient whose network client is replaced by a canned stream. */
function clientReturning(chunks: any[]): OpenAIClient {
  const client = new OpenAIClient({
    provider: "openai",
    model: "gpt-4o",
    apiKey: "test",
  });
  // Replace the lazy SDK client with a stub that yields our chunks.
  (client as any)._client = {
    chat: { completions: { create: async () => fakeStream(chunks) } },
  };
  return client;
}

const baseOpts = (): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  stream: true,
  onChunk: () => {},
});

describe("OpenAIClient streaming stopReason", () => {
  it("returns finish_reason 'length' (output cap) instead of hardcoded 'stop'", async () => {
    const chunks = [
      { choices: [{ delta: { content: "partial answer" } }] },
      // Final chunk: content delta empty, finish_reason set — like the SDK.
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];
    const resp = await clientReturning(chunks).createMessage(baseOpts());
    expect(resp.text).toBe("partial answer");
    expect(resp.stopReason).toBe("length");
  });

  it("returns 'stop' for a normally-completed stream", async () => {
    const chunks = [
      { choices: [{ delta: { content: "done" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const resp = await clientReturning(chunks).createMessage(baseOpts());
    expect(resp.stopReason).toBe("stop");
  });
});
