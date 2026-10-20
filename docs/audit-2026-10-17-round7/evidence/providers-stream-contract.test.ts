import { describe, expect, test } from "bun:test";
import { MessageStream } from "../../../packages/core/node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs";
import { AnthropicClient } from "../../../packages/core/src/llm/providers/anthropic.js";
import { OpenAIClient } from "../../../packages/core/src/llm/providers/openai.js";
import { ModelFacade } from "../../../packages/core/src/engine/model-facade.js";
import { Transcript } from "../../../packages/core/src/session/transcript.js";
import type { StreamEvent } from "../../../packages/core/src/types.js";
import {
  initialChatState,
  reduceStream,
} from "../../../packages/web/src/lib/streamReducer.js";

// The installed SDK parses our own newline-delimited stream. No SDK client,
// HTTP transport, socket, provider endpoint, model, or paid service is used.
function memoryStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const bytes = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const stream = MessageStream.fromReadableStream(bytes);
  const encoder = new TextEncoder();
  return {
    stream,
    async send(event: Record<string, unknown>) {
      const observed = stream.emitted("streamEvent");
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      await observed;
    },
    close() {
      controller.close();
    },
  };
}

const start = () => ({
  type: "message_start",
  message: {
    id: "memory-message",
    type: "message",
    role: "assistant",
    model: "memory-model",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  },
});
const toolStart = (index: number, id: string, name: string) => ({
  type: "content_block_start",
  index,
  content_block: { type: "tool_use", id, name, input: {} },
});
const toolArgs = (index: number, args: Record<string, unknown>) => ({
  type: "content_block_delta",
  index,
  delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
});
const toolStop = (index: number) => ({ type: "content_block_stop", index });
async function finish(fixture: ReturnType<typeof memoryStream>) {
  await fixture.send({
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 6 },
  });
  await fixture.send({ type: "message_stop" });
  fixture.close();
}

function anthropicFacade() {
  const fixture = memoryStream();
  const transcript = Transcript.inMemory("provider-round7-anthropic");
  let announce!: () => void;
  const created = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const client = new AnthropicClient(
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    {
      retryMaxAttempts: 1,
      fetch: async () => {
        throw new Error("Unexpected network transport in memory-only audit");
      },
    },
  );
  (client as any)._client = {
    messages: {
      stream: () => {
        announce();
        return fixture.stream;
      },
    },
  };
  const facade = new ModelFacade(client, transcript);
  const events: StreamEvent[] = [];
  const pending = facade.call("memory-system", [{ role: "user", content: "memory-input" }], [],
    (event) => events.push(structuredClone(event)));
  return { fixture, transcript, events, pending, created };
}

describe("Round 7 provider tool progress boundary", () => {
  test("installed SDK emits inputJson before contentBlock, and returns correct final input", async () => {
    const fixture = memoryStream();
    const order: string[] = [];
    fixture.stream.on("inputJson", () => order.push("inputJson"));
    fixture.stream.on("contentBlock", () => order.push("contentBlock"));
    await fixture.send(start());
    await fixture.send(toolStart(0, "call-one", "Read"));
    expect(order).toEqual([]);
    await fixture.send(toolArgs(0, { path: "one.txt" }));
    expect(order).toEqual(["inputJson"]);
    await fixture.send(toolStop(0));
    expect(order).toEqual(["inputJson", "contentBlock"]);
    await finish(fixture);
    const final = await fixture.stream.finalMessage();
    expect(final.content).toEqual([
      { type: "tool_use", id: "call-one", name: "Read", input: { path: "one.txt" } },
    ]);
  });

  test("Anthropic first-tool progress drops all args and announces the start only at block stop", async () => {
    const { fixture, created, events, pending } = anthropicFacade();
    await created;
    await fixture.send(start());
    await fixture.send(toolStart(0, "call-one", "Read"));
    await fixture.send(toolArgs(0, { path: "one.txt" }));
    expect(events).toEqual([]);
    await fixture.send(toolStop(0));
    expect(events).toEqual([
      { type: "tool_use_start", toolCall: { id: "call-one", toolName: "Read", args: {} } },
    ]);
    await finish(fixture);
    const result = await pending;
    expect(result.toolCalls).toEqual([
      { id: "call-one", toolName: "Read", args: { path: "one.txt" } },
    ]);
    expect(events.filter((event) => event.type === "tool_use_args_delta")).toEqual([]);
  });

  test("Anthropic second-tool args land on the previous tool in the actual ModelFacade and Web reducer", async () => {
    const { fixture, created, events, pending, transcript } = anthropicFacade();
    await created;
    await fixture.send(start());
    await fixture.send(toolStart(0, "call-one", "Read"));
    await fixture.send(toolArgs(0, { path: "one.txt" }));
    await fixture.send(toolStop(0));
    await fixture.send(toolStart(1, "call-two", "Write"));
    await fixture.send(toolArgs(1, { path: "two.txt", content: "second input" }));
    expect(events.at(-1)).toEqual({
      type: "tool_use_args_delta",
      toolCallId: "call-one",
      args: { path: "two.txt", content: "second input" },
    });
    await fixture.send(toolStop(1));
    await finish(fixture);
    const result = await pending;
    expect(result.toolCalls).toEqual([
      { id: "call-one", toolName: "Read", args: { path: "one.txt" } },
      { id: "call-two", toolName: "Write", args: { path: "two.txt", content: "second input" } },
    ]);
    const state = events.reduce(reduceStream, initialChatState());
    expect(state.items).toEqual([
      {
        kind: "tool", id: "call-one", name: "Read",
        args: { path: "two.txt", content: "second input" },
        summary: undefined, done: false, result: undefined, error: undefined, agentId: undefined,
      },
      {
        kind: "tool", id: "call-two", name: "Write", args: {},
        summary: undefined, done: false, result: undefined, error: undefined, agentId: undefined,
      },
    ]);
    const recorded = transcript.getEvents().find((event) => event.type === "message");
    expect(recorded?.data.content).toEqual([
      { type: "tool_use", id: "call-one", name: "Read", input: { path: "one.txt" } },
      { type: "tool_use", id: "call-two", name: "Write", input: { path: "two.txt", content: "second input" } },
    ]);
  });

  test("OpenAI complete identity control routes progress correctly; later identity never emits a start", async () => {
    async function run(fragmentIdentity: boolean) {
      const client = new OpenAIClient(
        { provider: "openai", model: "memory-model" },
        { retryMaxAttempts: 1, fetch: async () => { throw new Error("Unexpected network transport"); } },
      );
      const chunks = fragmentIdentity
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: {} }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-one", function: { name: "Read", arguments: '{"path":"one.txt"}' } }] } }] },
          ]
        : [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-one", type: "function", function: { name: "Read", arguments: '{"path":"one.txt"}' } }] } }] },
          ];
      (client as any)._client = { chat: { completions: { create: async () => ({
        async *[Symbol.asyncIterator]() {
          yield* chunks;
          yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } };
        },
      }) } } };
      const events: StreamEvent[] = [];
      const facade = new ModelFacade(client, Transcript.inMemory(`provider-round7-openai-${fragmentIdentity}`));
      const response = await facade.call("memory-system", [{ role: "user", content: "memory-input" }], [],
        (event) => events.push(structuredClone(event)));
      return { events, response, state: events.reduce(reduceStream, initialChatState()) };
    }
    const control = await run(false);
    expect(control.events.map((event) => event.type)).toEqual(["tool_use_start", "tool_use_args_delta"]);
    expect(control.state.items).toHaveLength(1);
    expect(control.state.items[0]?.kind === "tool" && control.state.items[0].args).toEqual({ path: "one.txt" });
    const fragmented = await run(true);
    expect(fragmented.events.map((event) => event.type)).toEqual(["tool_use_args_delta"]);
    expect(fragmented.state.items).toEqual([]);
    expect(fragmented.response.toolCalls).toEqual(control.response.toolCalls);
    expect(fragmented.response.toolCalls).toEqual([{ id: "call-one", toolName: "Read", args: { path: "one.txt" } }]);
  });
});
