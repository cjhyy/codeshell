import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../types.js";

/**
 * B-3: when a model emits more tool calls than maxToolCallsPerTurn, the excess
 * is sliced off and never executed. Without a heads-up the model assumes they
 * ran. The loop must (a) execute only the cap, and (b) inject a system-reminder
 * naming the dropped calls so the model re-issues them.
 */
function makeDeps(responses: LLMResponse[]): {
  deps: TurnLoopDeps;
  callArgs: Message[][];
  executed: string[];
} {
  let i = 0;
  const callArgs: Message[][] = [];
  const executed: string[] = [];
  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    callArgs.push(messages.map((m) => ({ ...m })));
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
    async executeSingle(call: ToolCall): Promise<ToolResult> {
      executed.push(call.toolName);
      return { id: call.id, toolName: call.toolName, result: "ok" };
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

  return { deps, callArgs, executed };
}

function manyToolCalls(n: number): ToolCall[] {
  return Array.from({ length: n }, (_, k) => ({
    id: `c${k}`,
    toolName: `Tool${k}`,
    args: {},
  }));
}

const toolResp = (calls: ToolCall[]): LLMResponse => ({
  text: "",
  toolCalls: calls,
  stopReason: "tool_use",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});
const doneResp = (): LLMResponse => ({
  text: "done",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

describe("TurnLoop per-turn tool-call cap (B-3)", () => {
  it("executes only the cap and warns the model about the dropped calls", async () => {
    const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 3 };
    // Turn 1: model asks for 5 tools (cap is 3). Turn 2: it finishes.
    const { deps, callArgs, executed } = makeDeps([toolResp(manyToolCalls(5)), doneResp()]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    // Only the first 3 tools ran — the other 2 were dropped, not executed.
    expect(executed).toEqual(["Tool0", "Tool1", "Tool2"]);

    // The SECOND model call's message history must carry the cap reminder
    // naming the dropped tools (Tool3, Tool4) so the model knows to re-issue.
    const turn2Messages = callArgs[1];
    const reminder = turn2Messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .find((c) => c.includes("Only the first 3 of your 5 tool calls"));
    expect(reminder).toBeDefined();
    expect(reminder).toContain("Tool3");
    expect(reminder).toContain("Tool4");
  });

  it("does NOT inject a reminder when calls are within the cap", async () => {
    const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };
    const { deps, callArgs, executed } = makeDeps([toolResp(manyToolCalls(2)), doneResp()]);
    const loop = new TurnLoop(deps, config);
    await loop.run([{ role: "user", content: "go" }]);

    expect(executed).toEqual(["Tool0", "Tool1"]);
    const turn2Messages = callArgs[1] ?? [];
    const reminder = turn2Messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .find((c) => c.includes("tool calls ran this turn"));
    expect(reminder).toBeUndefined();
  });
});
