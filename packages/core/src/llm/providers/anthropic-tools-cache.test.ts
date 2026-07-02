import { describe, it, expect } from "bun:test";
import { AnthropicClient } from "./anthropic.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * Prompt-cache optimization step 2 (docs/todo/prompt-cache-optimization.md §四):
 * put ONE cache_control breakpoint on the LAST tool so the whole tools array
 * (all ~73 definitions) becomes a cached prefix. CC treats tools as a single
 * stable block and marks the tail, rather than one marker per tool. These tests
 * stub the SDK and assert the request body, using the same capturing seam as
 * anthropic-thinking.test.ts.
 */
function clientCapturing(): { client: AnthropicClient; lastBody: () => any } {
  const client = new AnthropicClient({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "test",
  });
  let body: any;
  const resp = {
    id: "x",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  (client as any)._client = {
    messages: {
      create: async (b: any) => {
        body = b;
        return resp;
      },
    },
  };
  return { client, lastBody: () => body };
}

const TOOLS = [
  { name: "a", description: "tool a", inputSchema: { type: "object" } },
  { name: "b", description: "tool b", inputSchema: { type: "object" } },
  { name: "c", description: "tool c", inputSchema: { type: "object" } },
];

const opts = (tools: CreateMessageOptions["tools"]): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools,
  stream: false,
  onChunk: () => {},
});

describe("AnthropicClient tools prompt-cache breakpoint", () => {
  it("marks the LAST tool with cache_control ephemeral", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(opts(TOOLS));
    const sent = lastBody().tools;
    expect(sent).toHaveLength(3);
    expect(sent[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT mark any tool before the last", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(opts(TOOLS));
    const sent = lastBody().tools;
    expect(sent[0].cache_control).toBeUndefined();
    expect(sent[1].cache_control).toBeUndefined();
  });

  it("sends no tools field when the tool list is empty", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(opts([]));
    expect(lastBody().tools).toBeUndefined();
  });
});
