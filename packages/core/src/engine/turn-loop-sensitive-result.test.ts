import { describe, expect, test } from "bun:test";
import { CANCEL_GOAL_TOOL_NAME } from "../tool-system/builtin/cancel-goal.js";
import { SENSITIVE_TOOL_RESULT_PLACEHOLDER } from "../tool-system/tool-result-redaction.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../types.js";
import type { ModelCallRecordingOptions } from "./model-facade.js";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";

const SECRET = "tok-secret-123";
const SECRET_A = "tok-secret-a";
const SECRET_B = "tok-secret-b";
const REDACTED = JSON.stringify({ kind: "value", value: SENSITIVE_TOOL_RESULT_PLACEHOLDER });

function redactedFor(id: string): string {
  return JSON.stringify({ kind: "value", value: SENSITIVE_TOOL_RESULT_PLACEHOLDER, id });
}

function containsSecret(value: unknown, secret = SECRET): boolean {
  return JSON.stringify(value).includes(secret);
}

function containsAnySecret(value: unknown): boolean {
  const raw = JSON.stringify(value);
  return [SECRET, SECRET_A, SECRET_B].some((secret) => raw.includes(secret));
}

function containsRedacted(value: unknown): boolean {
  return JSON.stringify(value).includes(SENSITIVE_TOOL_RESULT_PLACEHOLDER);
}

function credentialCall(id = "cred-call"): ToolCall {
  return { id, toolName: "UseCredential", args: { id: "api" } };
}

function cancelGoalCall(id = "cancel-call"): ToolCall {
  return {
    id,
    toolName: CANCEL_GOAL_TOOL_NAME,
    args: { confirm: true, reason: "user asked to stop" },
  };
}

function toolResp(toolCalls: ToolCall[] = [credentialCall()]): LLMResponse {
  return {
    text: "",
    toolCalls,
    stopReason: "tool_use",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function doneResp(text = "done"): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function sensitiveResult(call: ToolCall, secret = SECRET, redacted = REDACTED): ToolResult {
  return {
    id: call.id,
    toolName: call.toolName,
    result: JSON.stringify({ kind: "value", value: secret }),
    sensitive: true,
    displayResult: redacted,
    transcriptResult: redacted,
  };
}

function toolResultContents(messages: Message[]): Map<string, unknown> {
  const contents = new Map<string, unknown>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        contents.set(block.tool_use_id, block.content);
      }
    }
  }
  return contents;
}

interface HarnessOptions {
  responses?: Array<LLMResponse | Error>;
  execute?: (call: ToolCall) => Promise<ToolResult>;
  maxTurns?: number;
  signal?: AbortSignal;
  goal?: TurnLoopConfig["goal"];
  onStream?: boolean;
  clearPersistedGoal?: () => void;
}

function makeHarness(options: HarnessOptions = {}) {
  const responses = options.responses ?? [toolResp(), doneResp()];
  let modelCallCount = 0;
  const modelInputs: Message[][] = [];
  const modelRecordingOptions: Array<ModelCallRecordingOptions | undefined> = [];
  const transcriptResults: Array<{
    toolCallId: string;
    toolName: string;
    result?: string;
    error?: string;
    contentBlocks?: unknown;
  }> = [];
  const manageAsyncInputs: Message[][] = [];
  const manageSyncInputs: Message[][] = [];
  const summarizePrompts: string[] = [];
  const events: unknown[] = [];

  const call = async (
    _systemPrompt: string,
    messages: Message[],
    _tools?: unknown,
    _onStream?: unknown,
    _signal?: unknown,
    recordingOptions?: ModelCallRecordingOptions,
  ): Promise<LLMResponse> => {
    modelInputs.push(structuredClone(messages));
    modelRecordingOptions.push(
      recordingOptions?.sensitiveToolResultRedactions
        ? {
            sensitiveToolResultRedactions: new Map(recordingOptions.sensitiveToolResultRedactions),
          }
        : undefined,
    );
    const response = responses[Math.min(modelCallCount, responses.length - 1)]!;
    modelCallCount++;
    if (response instanceof Error) throw response;
    return response;
  };

  const callWithoutStreaming = async (
    systemPrompt: string,
    messages: Message[],
    tools?: unknown,
    signal?: unknown,
    recordingOptions?: ModelCallRecordingOptions,
  ): Promise<LLMResponse> => {
    return call(systemPrompt, messages, tools, undefined, signal, recordingOptions);
  };

  const model = {
    call,
    callWithoutStreaming,
    getUsage: () => ({
      records: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    }),
    getOutputTokens: () => 0,
    summarize: async (_systemPrompt: string, userMessage: string) => {
      summarizePrompts.push(userMessage);
      return "used credential";
    },
  } as unknown as TurnLoopDeps["model"];

  const contextManager = {
    async manageAsync(m: Message[]) {
      manageAsyncInputs.push(structuredClone(m));
      return m;
    },
    manage(m: Message[]) {
      manageSyncInputs.push(structuredClone(m));
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
    appendToolResult(
      toolCallId: string,
      toolName: string,
      result?: string,
      error?: string,
      contentBlocks?: unknown,
    ) {
      transcriptResults.push({ toolCallId, toolName, result, error, contentBlocks });
    },
    appendTurnBoundary() {},
    appendMessage() {},
    appendTurnStopped() {},
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
    async executeSingle(c: ToolCall): Promise<ToolResult> {
      if (options.execute) return options.execute(c);
      return sensitiveResult(c);
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
    clearPersistedGoal: options.clearPersistedGoal,
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };

  const config = {
    maxTurns: options.maxTurns ?? 5,
    maxToolCallsPerTurn: 10,
    signal: options.signal,
    goal: options.goal,
    ...(options.onStream
      ? {
          onStream: (event: unknown) => {
            events.push(event);
          },
        }
      : {}),
  } as TurnLoopConfig;

  return {
    config,
    deps,
    events,
    manageAsyncInputs,
    manageSyncInputs,
    modelCallCount: () => modelCallCount,
    modelInputs,
    modelRecordingOptions,
    summarizePrompts,
    transcriptResults,
  };
}

describe("TurnLoop sensitive ToolResult handling", () => {
  test("keeps plaintext model-only and redacts stream, transcript, summaries, and returned history", async () => {
    const harness = makeHarness({ onStream: true });
    const loop = new TurnLoop(harness.deps, harness.config);
    const result = await loop.run([{ role: "user", content: "use credential" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result.reason).toBe("completed");
    expect(harness.modelInputs.length).toBe(2);
    expect(containsSecret(harness.modelInputs[1])).toBe(true);
    expect(harness.modelRecordingOptions[1]?.sensitiveToolResultRedactions?.get("cred-call")).toBe(
      REDACTED,
    );
    expect(containsSecret(result.messages)).toBe(false);
    expect(containsRedacted(result.messages)).toBe(true);
    expect(harness.transcriptResults).toEqual([
      {
        toolCallId: "cred-call",
        toolName: "UseCredential",
        result: REDACTED,
        error: undefined,
        contentBlocks: undefined,
      },
    ]);
    expect(containsSecret(harness.transcriptResults)).toBe(false);

    const streamResult = harness.events.find(
      (event) => (event as { type?: string }).type === "tool_result",
    ) as { result?: ToolResult } | undefined;
    expect(streamResult?.result?.result).toBe(REDACTED);
    expect(containsSecret(streamResult)).toBe(false);
    expect(harness.summarizePrompts[0]).toContain(SENSITIVE_TOOL_RESULT_PLACEHOLDER);
    expect(harness.summarizePrompts[0]).not.toContain(SECRET);
    expect(harness.manageAsyncInputs).toHaveLength(1);
  });

  test("redacts returned history when loop-top abort fires with pending sensitive result", async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      signal: controller.signal,
      responses: [toolResp()],
      execute: async (call) => {
        controller.abort();
        return sensitiveResult(call);
      },
    });
    const loop = new TurnLoop(harness.deps, harness.config);
    const result = await loop.run([{ role: "user", content: "use credential" }]);

    expect(result.reason).toBe("aborted_streaming");
    expect(harness.modelCallCount()).toBe(1);
    expect(containsSecret(result.messages)).toBe(false);
    expect(containsRedacted(result.messages)).toBe(true);
    expect(containsSecret(harness.transcriptResults)).toBe(false);
  });

  test("redacts returned history when confirmed cancel_goal shares a batch with a sensitive result", async () => {
    let cleared = false;
    const harness = makeHarness({
      goal: { objective: "keep working" },
      responses: [toolResp([credentialCall(), cancelGoalCall()])],
      clearPersistedGoal: () => {
        cleared = true;
      },
      execute: async (call) => {
        if (call.toolName === CANCEL_GOAL_TOOL_NAME) {
          return { id: call.id, toolName: call.toolName, result: "goal cancelled" };
        }
        return sensitiveResult(call);
      },
    });
    const loop = new TurnLoop(harness.deps, harness.config);
    const result = await loop.run([{ role: "user", content: "use credential then cancel" }]);

    expect(result.reason).toBe("completed");
    expect(cleared).toBe(true);
    expect(harness.modelCallCount()).toBe(1);
    expect(containsSecret(result.messages)).toBe(false);
    expect(containsRedacted(result.messages)).toBe(true);
    expect(containsSecret(harness.transcriptResults)).toBe(false);
  });

  test("skips max-turns context management for pending sensitive result and redacts returned history", async () => {
    const harness = makeHarness({
      maxTurns: 1,
      responses: [toolResp(), doneResp("final summary")],
    });
    const loop = new TurnLoop(harness.deps, harness.config);
    const result = await loop.run([{ role: "user", content: "use credential" }]);

    expect(result.reason).toBe("max_turns");
    expect(result.text).toBe("final summary");
    expect(harness.modelInputs).toHaveLength(2);
    expect(containsSecret(harness.modelInputs[1])).toBe(true);
    expect(harness.manageSyncInputs).toHaveLength(0);
    expect(containsSecret(harness.manageAsyncInputs)).toBe(false);
    expect(containsSecret(result.messages)).toBe(false);
    expect(containsRedacted(result.messages)).toBe(true);
    expect(containsSecret(harness.transcriptResults)).toBe(false);
  });

  test("redacts multiple sensitive results by tool id after their model-only consumption", async () => {
    const credA = credentialCall("cred-a");
    const credB = credentialCall("cred-b");
    const harness = makeHarness({
      responses: [toolResp([credA, credB]), doneResp()],
      execute: async (call) => {
        if (call.id === credA.id) return sensitiveResult(call, SECRET_A, redactedFor(call.id));
        return sensitiveResult(call, SECRET_B, redactedFor(call.id));
      },
    });
    const loop = new TurnLoop(harness.deps, harness.config);
    const result = await loop.run([{ role: "user", content: "use credentials" }]);
    const contents = toolResultContents(result.messages);

    expect(result.reason).toBe("completed");
    expect(containsSecret(harness.modelInputs[1], SECRET_A)).toBe(true);
    expect(containsSecret(harness.modelInputs[1], SECRET_B)).toBe(true);
    expect(containsAnySecret(result.messages)).toBe(false);
    expect(contents.get(credA.id)).toBe(redactedFor(credA.id));
    expect(contents.get(credB.id)).toBe(redactedFor(credB.id));
    expect(containsAnySecret(harness.transcriptResults)).toBe(false);
  });

  test("redacts returned history when a sensitive result is followed by model_error", async () => {
    const harness = makeHarness({
      responses: [toolResp(), new Error("model failed")],
    });
    const loop = new TurnLoop(harness.deps, harness.config);
    const result = await loop.run([{ role: "user", content: "use credential" }]);

    expect(result.reason).toBe("model_error");
    expect(harness.modelInputs).toHaveLength(2);
    expect(containsSecret(harness.modelInputs[1])).toBe(true);
    expect(containsSecret(result.messages)).toBe(false);
    expect(containsRedacted(result.messages)).toBe(true);
    expect(containsSecret(harness.transcriptResults)).toBe(false);
  });
});
