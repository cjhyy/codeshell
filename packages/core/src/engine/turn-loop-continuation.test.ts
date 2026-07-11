import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message, StreamEvent } from "../types.js";

/**
 * Build minimal fake deps for TurnLoop. Only the methods exercised by the
 * max-output continuation path are implemented; the rest are no-ops/getters.
 */
function makeDeps(responses: Array<LLMResponse | Error>): {
  deps: TurnLoopDeps;
  calls: () => number;
  callArgs: Message[][];
  stopHookCalls: () => number;
  stoppedMarkers: () => number;
} {
  let i = 0;
  let stopHooks = 0;
  let stopped = 0;
  const callArgs: Message[][] = [];
  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    callArgs.push(messages);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
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
    getPromptPrefixFingerprint: () => ({
      version: 1 as const,
      cacheScopeHash: "scope",
      systemHash: "system",
      toolsHash: "tools",
      configHash: "config",
    }),
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
    async emit(event: string) {
      if (event === "on_stop") stopHooks++;
      return {};
    },
  } as unknown as TurnLoopDeps["hooks"];

  const transcript = {
    appendToolUse() {},
    appendToolResult() {},
    appendTurnBoundary() {},
    appendMessage() {},
    appendTurnStopped() {
      stopped++;
    },
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

  return {
    deps,
    calls: () => i,
    callArgs,
    stopHookCalls: () => stopHooks,
    stoppedMarkers: () => stopped,
  };
}

const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };

const resp = (text: string, stopReason: string): LLMResponse => ({
  text,
  toolCalls: [],
  stopReason,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

describe("TurnLoop max-output continuation", () => {
  it("labels primary and continuation cache diagnostic samples", async () => {
    const { deps } = makeDeps([resp("part one ", "length"), resp("part two", "stop")]);
    const samples: any[] = [];
    deps.recordCacheReadDiagnostics = (sample) => samples.push(sample);

    await new TurnLoop(deps, config).run([{ role: "user", content: "go" }]);

    expect(samples.map((sample) => sample.requestKind)).toEqual(["primary", "continuation"]);
    expect(samples[0].fingerprint).toEqual(samples[1].fingerprint);
  });

  it("continues when an OpenAI stream stops with 'length' (output cap)", async () => {
    // First response truncated ("length"); continuation finishes clean.
    const { deps, calls, stopHookCalls } = makeDeps([
      resp("part one ", "length"),
      resp("part two", "stop"),
    ]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    // Continuation must have fired: model.call invoked at least twice.
    expect(calls()).toBeGreaterThanOrEqual(2);
    // Combined text from both halves.
    expect(result.text).toBe("part one part two");
    expect(result.reason).toBe("completed");
    expect(stopHookCalls()).toBe(1);
  });

  it("returns model_error when a text continuation request fails", async () => {
    const events: StreamEvent[] = [];
    const { deps, stopHookCalls } = makeDeps([
      resp("truncated draft", "length"),
      new Error("continuation network failure"),
    ]);
    const loop = new TurnLoop(deps, {
      ...config,
      onStream: (event) => {
        events.push(event);
      },
    });

    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("model_error");
    expect(stopHookCalls()).toBe(0);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(result.messages).not.toContainEqual({
      role: "assistant",
      content: "truncated draft",
    });
  });

  it("stops cleanly when a text continuation request is aborted", async () => {
    const abortError = new Error("continuation aborted");
    abortError.name = "AbortError";
    const { deps, stopHookCalls, stoppedMarkers } = makeDeps([
      resp("truncated draft", "length"),
      abortError,
    ]);
    const loop = new TurnLoop(deps, config);

    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("aborted_streaming");
    expect(stopHookCalls()).toBe(0);
    expect(stoppedMarkers()).toBe(1);
  });

  it("does not continue on a clean 'stop'", async () => {
    const { deps, calls } = makeDeps([resp("all done", "stop")]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);
    expect(calls()).toBe(1);
    expect(result.text).toBe("all done");
  });

  it("retries with a truncation notice instead of executing a tool call cut off by the output cap", async () => {
    // The bug: a Write whose `content` arg overflowed max_output_tokens arrives
    // with truncated arg JSON (stopReason "length" + a tool call). Executing it
    // raised a misleading "Missing required parameter: file_path". Instead the
    // loop should tell the model its output was truncated and let it retry.
    const truncatedWithTool: LLMResponse = {
      text: "",
      toolCalls: [{ id: "c1", toolName: "Write", args: {} }],
      stopReason: "length",
      usage: { promptTokens: 10, completionTokens: 8192, totalTokens: 8202 },
    };
    const { deps, calls, callArgs } = makeDeps([truncatedWithTool, resp("done", "stop")]);
    const loop = new TurnLoop(deps, config);
    await loop.run([{ role: "user", content: "write a long doc" }]);

    // It must NOT just execute the truncated tool — it retries with the model.
    expect(calls()).toBeGreaterThanOrEqual(2);
    // The retry prompt carries a truncation notice (mentions output/truncated).
    const retryMessages = callArgs[1] ?? [];
    const blob = JSON.stringify(retryMessages);
    expect(blob).toMatch(/truncat|output token|max.?output/i);
  });

  it("charges a truncated tool-call response to the Goal budget before retrying", async () => {
    const truncatedWithTool: LLMResponse = {
      text: "",
      toolCalls: [{ id: "c1", toolName: "Write", args: {} }],
      stopReason: "length",
      usage: { promptTokens: 10, completionTokens: 8192, totalTokens: 8202 },
    };
    const { deps, calls } = makeDeps([truncatedWithTool, resp("should not run", "stop")]);
    const loop = new TurnLoop(deps, {
      ...config,
      goal: { objective: "write a long doc", tokenBudget: 100 },
    });

    const result = await loop.run([{ role: "user", content: "write a long doc" }]);

    expect(result.reason).toBe("goal_budget_exhausted");
    expect(result.goalTermination).toBe("token_budget_exhausted");
    expect(calls()).toBe(1);
  });

  it("charges every text continuation and stops before the next request when over budget", async () => {
    const truncated = (text: string): LLMResponse => ({
      text,
      toolCalls: [],
      stopReason: "length",
      usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    });
    const { deps, calls } = makeDeps([
      truncated("one "),
      truncated("two "),
      truncated("three "),
      resp("should not run", "stop"),
    ]);
    const loop = new TurnLoop(deps, {
      ...config,
      goal: { objective: "continue within budget", tokenBudget: 25 },
    });

    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("goal_budget_exhausted");
    expect(result.goalTermination).toBe("token_budget_exhausted");
    expect(calls()).toBe(3);
  });

  it("publishes normal non-truncated Goal conversation context", async () => {
    let renderedConversation: string | undefined;
    const { deps, calls } = makeDeps([resp("all done", "stop")]);
    deps.publishGoalJudgeContext = (context) => {
      renderedConversation = context.renderedConversation;
    };
    const loop = new TurnLoop(deps, {
      ...config,
      goal: { objective: "finish normally", tokenBudget: 100 },
    });

    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(calls()).toBe(1);
    expect(renderedConversation).toContain("all done");
  });
});
