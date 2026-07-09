import { describe, expect, test } from "bun:test";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../types.js";

function makeDeps(opts: {
  responses: LLMResponse[];
  summarize: (systemPrompt: string, userMessage: string) => Promise<string>;
}): TurnLoopDeps {
  let i = 0;
  const call = async (): Promise<LLMResponse> =>
    opts.responses[Math.min(i++, opts.responses.length - 1)]!;
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
    summarize: opts.summarize,
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
  const hooks = { async emit() { return {}; } } as unknown as TurnLoopDeps["hooks"];
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
    async executeSingle(c: ToolCall): Promise<ToolResult> {
      return { id: c.id, toolName: c.toolName, result: `ok:${c.id}` };
    },
  } as unknown as TurnLoopDeps["toolExecutor"];
  return {
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
}

const toolResp = (): LLMResponse => ({
  text: "",
  toolCalls: [
    { id: "call-read", toolName: "Read", args: { file: "a.ts" } },
    { id: "call-grep", toolName: "Grep", args: { pattern: "needle" } },
  ],
  stopReason: "tool_use",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

const doneResp = (): LLMResponse => ({
  text: "done",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

describe("TurnLoop tool_summary routing contract", () => {
  test("emits toolCallIds for the summarized tool batch", async () => {
    const events: any[] = [];
    const deps = makeDeps({
      responses: [toolResp(), doneResp()],
      summarize: async () => "read and searched",
    });
    const config = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      onStream: (event: unknown) => events.push(event),
    } as unknown as TurnLoopConfig;
    const loop = new TurnLoop(deps, config);

    const result = await loop.run([{ role: "user", content: "go" }]);
    expect(result.reason).toBe("completed");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const summary = events.find((event) => event.type === "tool_summary");
    expect(summary).toMatchObject({
      type: "tool_summary",
      summary: "read and searched",
      toolCallIds: ["call-read", "call-grep"],
    });
  });
});
