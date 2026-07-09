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

function makeDeps(eventsFromStreaming: StreamEvent[]): TurnLoopDeps {
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
      return finalResponse("final");
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
