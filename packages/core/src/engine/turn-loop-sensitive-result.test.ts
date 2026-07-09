import { describe, expect, test } from "bun:test";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import { SENSITIVE_TOOL_RESULT_PLACEHOLDER } from "../tool-system/tool-result-redaction.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../types.js";

const SECRET = "tok-secret-123";
const REDACTED = JSON.stringify({ kind: "value", value: SENSITIVE_TOOL_RESULT_PLACEHOLDER });

function containsSecret(value: unknown): boolean {
  return JSON.stringify(value).includes(SECRET);
}

function containsRedacted(value: unknown): boolean {
  return JSON.stringify(value).includes(SENSITIVE_TOOL_RESULT_PLACEHOLDER);
}

function toolResp(): LLMResponse {
  return {
    text: "",
    toolCalls: [{ id: "cred-call", toolName: "UseCredential", args: { id: "api" } }],
    stopReason: "tool_use",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function doneResp(): LLMResponse {
  return {
    text: "done",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe("TurnLoop sensitive ToolResult handling", () => {
  test("keeps plaintext model-only and redacts stream, transcript, summaries, and returned history", async () => {
    const modelInputs: Message[][] = [];
    let modelCallCount = 0;
    let summaryPrompt = "";
    let manageCalls = 0;
    const transcriptResults: Array<{ result?: string; contentBlocks?: unknown }> = [];
    const events: unknown[] = [];

    const call = async (_systemPrompt: string, messages: Message[]): Promise<LLMResponse> => {
      modelInputs.push(structuredClone(messages));
      modelCallCount++;
      return modelCallCount === 1 ? toolResp() : doneResp();
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
      summarize: async (_systemPrompt: string, userMessage: string) => {
        summaryPrompt = userMessage;
        return "used credential";
      },
    } as unknown as TurnLoopDeps["model"];
    const contextManager = {
      async manageAsync(m: Message[]) {
        manageCalls++;
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
      appendToolResult(
        _toolCallId: string,
        _toolName: string,
        result?: string,
        _error?: string,
        contentBlocks?: unknown,
      ) {
        transcriptResults.push({ result, contentBlocks });
      },
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
      async executeSingle(c: ToolCall): Promise<ToolResult> {
        return {
          id: c.id,
          toolName: c.toolName,
          result: JSON.stringify({ kind: "value", value: SECRET }),
          sensitive: true,
          displayResult: REDACTED,
          transcriptResult: REDACTED,
        };
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
    const config = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      onStream: (event: unknown) => {
        events.push(event);
      },
    } as TurnLoopConfig;

    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "use credential" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result.reason).toBe("completed");
    expect(modelInputs.length).toBe(2);
    expect(containsSecret(modelInputs[1])).toBe(true);
    expect(containsSecret(result.messages)).toBe(false);
    expect(containsRedacted(result.messages)).toBe(true);
    expect(transcriptResults).toEqual([{ result: REDACTED, contentBlocks: undefined }]);

    const streamResult = events.find(
      (event) => (event as { type?: string }).type === "tool_result",
    ) as { result?: ToolResult } | undefined;
    expect(streamResult?.result?.result).toBe(REDACTED);
    expect(containsSecret(streamResult)).toBe(false);
    expect(summaryPrompt).toContain(SENSITIVE_TOOL_RESULT_PLACEHOLDER);
    expect(summaryPrompt).not.toContain(SECRET);
    expect(manageCalls).toBe(1);
  });
});
