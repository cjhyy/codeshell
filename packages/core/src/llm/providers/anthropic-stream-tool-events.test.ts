import { describe, expect, it } from "bun:test";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { AnthropicClient } from "./anthropic.js";
import type { LLMStreamChunk } from "../../types.js";

/** Parse an in-memory SSE-equivalent line stream with the installed SDK parser. */
function sdkStream(events: Record<string, unknown>[]): MessageStream {
  const encoder = new TextEncoder();
  const bytes = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
  return MessageStream.fromReadableStream(bytes);
}

const toolBlock = (index: number, id: string, name: string, args: Record<string, unknown>) => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
  },
  { type: "content_block_stop", index },
];

describe("AnthropicClient streamed tool events", () => {
  it("routes each tool's argument deltas to that tool, starting at block start", async () => {
    const client = new AnthropicClient({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test",
    });
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      ...toolBlock(0, "call-one", "Read", { file_path: "/one.txt" }),
      ...toolBlock(1, "call-two", "Write", { file_path: "/two.txt", content: "two" }),
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 6 },
      },
      { type: "message_stop" },
    ];
    (client as any)._client = { messages: { stream: () => sdkStream(events) } };

    const chunks: LLMStreamChunk[] = [];
    const response = await client.createMessage({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: true,
      onChunk: (chunk) => chunks.push(chunk),
    });

    const toolChunks = chunks
      .filter((c) => c.type === "tool_use_start" || c.type === "tool_use_delta")
      .map((c) => ({ type: c.type, id: c.toolCall?.id, args: c.toolCall?.args }));
    expect(toolChunks).toEqual([
      { type: "tool_use_start", id: "call-one", args: {} },
      { type: "tool_use_delta", id: "call-one", args: { file_path: "/one.txt" } },
      { type: "tool_use_start", id: "call-two", args: {} },
      { type: "tool_use_delta", id: "call-two", args: { file_path: "/two.txt", content: "two" } },
    ]);
    expect(response.toolCalls.map((c) => c.id)).toEqual(["call-one", "call-two"]);
  });
});
