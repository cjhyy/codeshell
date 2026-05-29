import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message } from "../types.js";

/**
 * Build minimal fake deps for TurnLoop. Only the methods exercised by the
 * max-output continuation path are implemented; the rest are no-ops/getters.
 */
function makeDeps(responses: LLMResponse[]): { deps: TurnLoopDeps; calls: () => number } {
  let i = 0;
  const callArgs: Message[][] = [];
  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    callArgs.push(messages);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
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

  const hooks = {
    async emit() {
      return {};
    },
  } as unknown as TurnLoopDeps["hooks"];

  const transcript = {
    appendToolUse() {},
    appendToolResult() {},
    appendTurnBoundary() {},
    appendMessage() {},
  } as unknown as TurnLoopDeps["transcript"];

  const toolExecutor = {
    setLogger() {},
    getInvestigationGuard() {
      return undefined;
    },
    getTaskGuard() {
      return undefined;
    },
    isConcurrencySafe() {
      return false;
    },
  } as unknown as TurnLoopDeps["toolExecutor"];

  const deps: TurnLoopDeps = {
    model,
    toolExecutor,
    contextManager,
    hooks,
    transcript,
    systemPrompt: "sys",
    tools: [],
    sessionId: "test",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };

  return { deps, calls: () => i };
}

const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };

const resp = (text: string, stopReason: string): LLMResponse => ({
  text,
  toolCalls: [],
  stopReason,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

describe("TurnLoop max-output continuation", () => {
  it("continues when an OpenAI stream stops with 'length' (output cap)", async () => {
    // First response truncated ("length"); continuation finishes clean.
    const { deps, calls } = makeDeps([resp("part one ", "length"), resp("part two", "stop")]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    // Continuation must have fired: model.call invoked at least twice.
    expect(calls()).toBeGreaterThanOrEqual(2);
    // Combined text from both halves.
    expect(result.text).toBe("part one part two");
    expect(result.reason).toBe("completed");
  });

  it("does not continue on a clean 'stop'", async () => {
    const { deps, calls } = makeDeps([resp("all done", "stop")]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);
    expect(calls()).toBe(1);
    expect(result.text).toBe("all done");
  });
});
