import { describe, expect, it } from "bun:test";
import type { LLMResponse, Message, StreamCallback, StreamEvent } from "../types.js";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";

function finalResponse(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  };
}

function makeDeps(
  eventsFromStreaming: StreamEvent[],
  replacement: LLMResponse = finalResponse("final"),
): TurnLoopDeps {
  const model = {
    async call(
      _system: string,
      _messages: Message[],
      _tools: unknown[],
      onStream?: StreamCallback,
    ): Promise<LLMResponse> {
      for (const event of eventsFromStreaming) {
        onStream?.(event);
      }
      throw new Error("stream failed");
    },
    async callWithoutStreaming(): Promise<LLMResponse> {
      return replacement;
    },
    getUsage: () => ({
      records: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    }),
    getOutputTokens: () => 0,
    summarize: undefined,
  } as unknown as TurnLoopDeps["model"];

  const contextManager = {
    async manageAsync(messages: Message[]) {
      return messages;
    },
    manage(messages: Message[]) {
      return messages;
    },
    recordActualUsage() {},
    shouldReactiveCompact() {
      return false;
    },
  } as unknown as TurnLoopDeps["contextManager"];

  return {
    model,
    toolExecutor: {
      setLogger() {},
      getInvestigationGuard: () => undefined,
      getTaskGuard: () => undefined,
      isConcurrencySafe: () => false,
    } as unknown as TurnLoopDeps["toolExecutor"],
    contextManager,
    hooks: {
      async emit() {
        return {};
      },
    } as unknown as TurnLoopDeps["hooks"],
    transcript: {
      appendToolUse() {},
      appendToolResult() {},
      appendTurnBoundary() {},
      appendTurnStopped() {},
      appendMessage() {},
    } as unknown as TurnLoopDeps["transcript"],
    systemPrompt: "sys",
    tools: [],
    sessionId: "fallback-test",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };
}

describe("TurnLoop streaming fallback messageId contract", () => {
  it("uses the stream_request_start messageId for tombstone and final assistant_message", async () => {
    const events: StreamEvent[] = [];
    const deps = makeDeps([{ type: "text_delta", text: "partial" } as StreamEvent]);
    const config: TurnLoopConfig = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      onStream: (event) => {
        events.push(event);
      },
    };
    const loop = new TurnLoop(deps, config);

    const result = await loop.run([{ role: "user", content: "go" }]);

    const start = events.find(
      (event): event is Extract<StreamEvent, { type: "stream_request_start" }> =>
        event.type === "stream_request_start",
    );
    const tombstone = events.find(
      (event): event is Extract<StreamEvent, { type: "tombstone" }> => event.type === "tombstone",
    );
    const assistant = events.find(
      (event): event is Extract<StreamEvent, { type: "assistant_message" }> =>
        event.type === "assistant_message",
    );
    if (!start || !tombstone || !assistant) {
      throw new Error(`missing fallback events: ${events.map((event) => event.type).join(",")}`);
    }
    const messageId = start.messageId;
    if (!messageId) {
      throw new Error("stream_request_start missing messageId");
    }

    expect(result.text).toBe("final");
    expect(messageId).toMatch(/^assistant_/);
    expect(tombstone.messageId).toBe(messageId);
    expect(assistant.messageId).toBe(messageId);
    expect(assistant.message.content).toBe("final");
  });
});

it("reopens a revoked stream with the fallback provider's complete reasoning and answer exactly once", async () => {
  const events: StreamEvent[] = [];
  const deps = makeDeps(
    [
      { type: "thinking_delta", text: "failed partial reasoning" },
      { type: "text_delta", text: "failed partial answer" },
    ],
    { ...finalResponse("replacement answer"), reasoningContent: "replacement reasoning" },
  );
  const result = await new TurnLoop(deps, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    onStream: (event) => events.push(event),
  }).run([{ role: "user", content: "go" }]);
  expect(result.text).toBe("replacement answer");
  const revokedAt = events.findIndex((event) => event.type === "tombstone");
  const after = events
    .slice(revokedAt + 1)
    .filter((event) =>
      ["stream_request_start", "thinking_delta", "text_delta", "assistant_message"].includes(
        event.type,
      ),
    );
  const firstStart = events.find((event) => event.type === "stream_request_start");
  expect(after).toEqual([
    { type: "stream_request_start", turnNumber: 1, messageId: firstStart?.messageId },
    { type: "thinking_delta", text: "replacement reasoning" },
    { type: "text_delta", text: "replacement answer" },
    {
      type: "assistant_message",
      messageId: firstStart?.messageId,
      message: { role: "assistant", content: "replacement answer" },
    },
  ]);
});

it("does not publish fallback reasoning or text after cancellation during the replacement request", async () => {
  const events: StreamEvent[] = [];
  const controller = new AbortController();
  const deps = makeDeps([]);
  deps.model.callWithoutStreaming = async () => {
    controller.abort();
    return { ...finalResponse("too late"), reasoningContent: "too late" };
  };
  const result = await new TurnLoop(deps, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    signal: controller.signal,
    onStream: (event) => events.push(event),
  }).run([{ role: "user", content: "go" }]);
  expect(result.reason).toBe("aborted_streaming");
  expect(
    events.filter((event) => event.type === "thinking_delta" || event.type === "text_delta"),
  ).toEqual([]);
  expect(events.filter((event) => event.type === "stream_request_start")).toHaveLength(1);
});

it("revokes unexecuted streamed tool placeholders before committing fallback output", async () => {
  const events: StreamEvent[] = [];
  const deps = makeDeps([
    { type: "tool_use_start", toolCall: { id: "partial-tool", toolName: "Read", args: {} } },
  ]);
  await new TurnLoop(deps, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    onStream: (event) => events.push(event),
  }).run([{ role: "user", content: "go" }]);
  const tombstones = events.filter((event) => event.type === "tombstone");
  expect(tombstones).toHaveLength(2);
  expect(tombstones[1]).toEqual({ type: "tombstone", messageId: "partial-tool" });
  const revokedAt = events.findIndex((event) => event === tombstones[1]);
  expect(events.slice(revokedAt + 1).find((event) => event.type === "text_delta")).toEqual({
    type: "text_delta",
    text: "final",
  });
});
