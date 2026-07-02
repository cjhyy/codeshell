import { describe, it, expect } from "bun:test";
import { AnthropicClient } from "./anthropic.js";
import type { CreateMessageOptions } from "../types.js";
import type { Message } from "../../types.js";

/**
 * Prompt-cache optimization step 3 (docs/todo/prompt-cache-optimization.md §四):
 * put ONE cache_control breakpoint on the LAST content block of the LAST
 * message, so the whole conversation history becomes a cached prefix. CC does
 * exactly this (markerIndex = messages.length - 1, last content block) and
 * warns a second history marker causes KV page eviction. The breakpoint is not
 * scrolled: as history grows the "last message" naturally moves, and the new
 * tail becomes the next write.
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

const opts = (messages: Message[]): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages,
  tools: [],
  stream: false,
  onChunk: () => {},
});

describe("AnthropicClient history prompt-cache breakpoint", () => {
  it("marks the last content block of the last message (string content)", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(
      opts([
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ]),
    );
    const sent = lastBody().messages;
    const last = sent[sent.length - 1];
    // A string-content message must be lifted to a text block to carry the marker.
    expect(Array.isArray(last.content)).toBe(true);
    const lastBlock = last.content[last.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(lastBlock.text).toBe("second");
  });

  it("marks only the last block of the last message, not earlier messages", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(
      opts([
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ]),
    );
    const sent = lastBody().messages;
    const first = sent[0];
    // First message stays a plain string (untouched, no marker).
    expect(first.content).toBe("first");
  });

  it("marks the tool_result block when it is the last block (pairing intact)", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(
      opts([
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
        },
      ]),
    );
    const sent = lastBody().messages;
    const last = sent[sent.length - 1];
    const lastBlock = last.content[last.content.length - 1];
    expect(lastBlock.type).toBe("tool_result");
    expect(lastBlock.tool_use_id).toBe("t1");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
    // The tool_use it pairs with is still present in the prior message.
    expect(sent[sent.length - 2].content[0].type).toBe("tool_use");
  });

  it("does nothing when there are no messages", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(opts([]));
    expect(lastBody().messages).toEqual([]);
  });
});
