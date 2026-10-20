import { describe, expect, test } from "bun:test";
import { AnthropicClient } from "../../../packages/core/src/llm/providers/anthropic.js";
import { ModelFacade } from "../../../packages/core/src/engine/model-facade.js";
import { Transcript } from "../../../packages/core/src/session/transcript.js";

// Only a JSON-returning in-memory messages.create adapter is installed. This
// checks normal response/transcript/request conversion, not provider rejection
// or signature validation. All text and opaque fields below are invented.
async function roundTrip(thinking: boolean) {
  const toolBlock = { type: "tool_use", id: "call-one", name: "Read", input: { path: "own.txt" } };
  const content = thinking
    ? [
        { type: "thinking", thinking: "memory-only thinking summary", signature: "memory-only-opaque-value" },
        { type: "redacted_thinking", data: "memory-only-redacted-value" },
        toolBlock,
      ]
    : [toolBlock];
  const requests: any[] = [];
  const client = new AnthropicClient(
    {
      provider: "anthropic",
      model: "claude-opus-4-5",
      maxTokens: 8192,
      reasoning: thinking ? { mode: "on" } : { mode: "off" },
    },
    {
      retryMaxAttempts: 1,
      fetch: async () => { throw new Error("Unexpected network transport in memory-only audit"); },
    },
  );
  (client as any)._client = {
    messages: {
      create: async (request: unknown) => {
        requests.push(structuredClone(request));
        return {
          id: `memory-response-${requests.length}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-4-5",
          content: requests.length === 1 ? structuredClone(content) : [{ type: "text", text: "done" }],
          stop_reason: requests.length === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 2 },
        };
      },
    },
  };
  const transcript = Transcript.inMemory(`provider-round7-thinking-${thinking}`);
  transcript.appendMessage("user", "memory input");
  const facade = new ModelFacade(client, transcript);
  const response = await facade.callWithoutStreaming("memory system", transcript.toMessages(), []);
  transcript.appendToolResult("call-one", "Read", "memory tool result");
  const continuedMessages = transcript.toMessages();
  await facade.callWithoutStreaming("memory system", continuedMessages, []);
  return { content, requests, response, continuedMessages };
}

describe("Round 7 Anthropic thinking tool round trip", () => {
  test("thinking-enabled tool response loses both thinking block kinds before the continuation request", async () => {
    const { content, requests, response, continuedMessages } = await roundTrip(true);
    expect(requests[0].thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(content.map((block) => block.type)).toEqual(["thinking", "redacted_thinking", "tool_use"]);
    expect(response.toolCalls).toEqual([{ id: "call-one", toolName: "Read", args: { path: "own.txt" } }]);
    expect(response.reasoningContent).toBeUndefined();
    const stored = continuedMessages.find((message) => message.role === "assistant");
    expect(stored?.content).toEqual([{ type: "tool_use", id: "call-one", name: "Read", input: { path: "own.txt" } }]);
    const wire = requests[1].messages.find((message: any) => message.role === "assistant");
    expect(wire.content).toEqual(stored?.content);
    expect(wire.content).not.toEqual(content);
    expect(requests[1].thinking).toEqual(requests[0].thinking);
    expect(requests[1].messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-one", content: "memory tool result" }],
    });
  });

  test("thinking-off control echoes the whole tool response and preserves its result", async () => {
    const { content, requests, continuedMessages } = await roundTrip(false);
    expect(requests[0].thinking).toBeUndefined();
    expect(requests[1].thinking).toBeUndefined();
    expect(requests[1].messages.find((message: any) => message.role === "assistant").content).toEqual(content);
    expect(continuedMessages.at(-1)?.content).toEqual([
      { type: "tool_result", tool_use_id: "call-one", content: "memory tool result" },
    ]);
  });
});
