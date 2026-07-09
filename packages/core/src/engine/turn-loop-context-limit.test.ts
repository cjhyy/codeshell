import { describe, expect, it } from "bun:test";
import { ContextLimitError } from "../exceptions.js";
import type { LLMResponse, Message, StreamEvent } from "../types.js";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";

function makeDeps(script: Array<LLMResponse | Error>): {
  deps: TurnLoopDeps;
  callArgs: Message[][];
  calls: () => number;
} {
  let i = 0;
  const callArgs: Message[][] = [];
  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    callArgs.push(messages.map((message) => ({ ...message })));
    const next = script[Math.min(i, script.length - 1)]!;
    i++;
    if (next instanceof Error) throw next;
    return next;
  };

  const model = {
    call,
    callWithoutStreaming: call,
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
    async manageAsync(m: Message[]) {
      return m;
    },
    manage(m: Message[]) {
      return m;
    },
    recordActualUsage() {},
    shouldReactiveCompact() {
      return false;
    },
  } as unknown as TurnLoopDeps["contextManager"];

  const deps: TurnLoopDeps = {
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
    sessionId: "ctx-limit-test",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };

  return { deps, callArgs, calls: () => i };
}

const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };

const done = (text = "done"): LLMResponse => ({
  text,
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
});

const history: Message[] = [
  { role: "user", content: "round-0 user seed" },
  { role: "assistant", content: "round-1 assistant" },
  { role: "user", content: "round-1 user followup" },
  { role: "assistant", content: "round-2 assistant" },
  { role: "user", content: "current request" },
];

describe("TurnLoop context-limit recovery", () => {
  it("drops the oldest API round and retries after ContextLimitError", async () => {
    const { deps, callArgs, calls } = makeDeps([new ContextLimitError("fake"), done("recovered")]);
    const loop = new TurnLoop(deps, config);

    const result = await loop.run(history);

    expect(result.reason).toBe("completed");
    expect(result.text).toBe("recovered");
    expect(calls()).toBe(2);

    expect(JSON.stringify(callArgs[0])).toContain("round-0 user seed");
    const retryPayload = JSON.stringify(callArgs[1]);
    expect(retryPayload).not.toContain("round-0 user seed");
    expect(retryPayload).toContain("round-1 assistant");
    expect(retryPayload).toContain("Earlier conversation context was removed");
  });

  it("returns prompt_too_long and emits an error after three failed recovery attempts", async () => {
    const events: StreamEvent[] = [];
    const { deps, calls } = makeDeps([
      new ContextLimitError("fake"),
      new ContextLimitError("fake"),
      new ContextLimitError("fake"),
      new ContextLimitError("fake"),
    ]);
    const loop = new TurnLoop(deps, {
      ...config,
      onStream: (event) => {
        events.push(event);
      },
    });

    const result = await loop.run(history);

    expect(result.reason).toBe("prompt_too_long");
    expect(calls()).toBe(4);
    expect(events).toContainEqual({
      type: "error",
      error: "Context limit exceeded after 3 recovery attempts",
    });
  });
});
