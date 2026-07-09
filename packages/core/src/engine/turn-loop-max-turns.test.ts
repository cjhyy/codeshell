import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message, StreamEvent, ToolCall, ToolResult } from "../types.js";

/**
 * §4.3 coverage gap: the maxTurns ceiling. Existing turn-loop tests cover the
 * per-turn tool cap, abort, continuation, and summary safety — but NOT the case
 * where a model keeps requesting tools until the turn limit bites. This pins:
 *   - the loop stops after exactly maxTurns model turns,
 *   - it makes one final no-tools summary call after the ceiling,
 *   - it returns reason "max_turns"; Engine epilogue owns turn_complete,
 *   - the turns-remaining warning reminders (2 / 1 left) are injected.
 */
function makeDeps(responses: LLMResponse[]): {
  deps: TurnLoopDeps;
  callArgs: Message[][];
  modelCalls: () => number;
} {
  let i = 0;
  let calls = 0;
  const callArgs: Message[][] = [];
  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    calls++;
    callArgs.push(messages.map((m) => ({ ...m })));
    const r = responses[Math.min(i, responses.length - 1)]!;
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
    async executeSingle(c: ToolCall): Promise<ToolResult> {
      return { id: c.id, toolName: c.toolName, result: "ok" };
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
    callArgs,
    modelCalls: () => calls,
  };
}

const toolResp = (): LLMResponse => ({
  text: "",
  toolCalls: [{ id: "c0", toolName: "Tool0", args: {} }] as ToolCall[],
  stopReason: "tool_use",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});
const summaryResp = (): LLMResponse => ({
  text: "final summary",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

describe("TurnLoop maxTurns ceiling (§4.3)", () => {
  it("stops at maxTurns, makes a final summary call, returns reason 'max_turns'", async () => {
    const config: TurnLoopConfig = { maxTurns: 3, maxToolCallsPerTurn: 10 };
    // The model NEVER stops on its own — it asks for a tool on every one of the
    // 3 turns; the 4th (final, no-tools) call returns the summary. The response
    // list is indexed per model.call, so turns 1-3 = toolResp, call 4 = summary.
    const { deps, callArgs, modelCalls } = makeDeps([
      toolResp(),
      toolResp(),
      toolResp(),
      summaryResp(),
    ]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("max_turns");
    expect(result.text).toBe("final summary");
    // 3 turn-calls + 1 final summary call = 4 model calls.
    expect(modelCalls()).toBe(4);
    // The final call's messages must carry the "Turn limit reached" summary ask.
    const finalMessages = callArgs[callArgs.length - 1]!;
    const finalReminder = finalMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .find((c) => c.includes("Turn limit reached"));
    expect(finalReminder).toBeDefined();
  });

  it("injects the turns-remaining warning reminders (2 and 1 left)", async () => {
    const config: TurnLoopConfig = { maxTurns: 3, maxToolCallsPerTurn: 10 };
    const { deps, callArgs } = makeDeps([toolResp(), toolResp(), toolResp(), summaryResp()]);
    const loop = new TurnLoop(deps, config);
    await loop.run([{ role: "user", content: "go" }]);

    // With maxTurns=3: turn 1 → 2 remaining (warn), turn 2 → 1 remaining (warn).
    const allContent = callArgs
      .flat()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(allContent).toContain("only 2 turns remaining");
    expect(allContent).toContain("only 1 turn remaining");
  });

  it("a model that stops early never hits the ceiling", async () => {
    const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };
    // Stops immediately on turn 1.
    const { deps, modelCalls } = makeDeps([summaryResp()]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    // Exactly one model call — no ceiling, no extra summary turn.
    expect(modelCalls()).toBe(1);
  });

  it("does not emit turn_complete from TurnLoop when maxTurns is reached", async () => {
    const events: StreamEvent[] = [];
    const config: TurnLoopConfig = {
      maxTurns: 1,
      maxToolCallsPerTurn: 10,
      onStream: (event) => {
        events.push(event);
      },
    };
    const { deps } = makeDeps([toolResp(), summaryResp()]);
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);
    const terminalEvents = events.filter((event) => event.type === "turn_complete");
    const summaryMessages = events.filter(
      (event) => event.type === "assistant_message" && event.message.content === "final summary",
    );

    expect(result.reason).toBe("max_turns");
    expect(terminalEvents).toHaveLength(0);
    expect(summaryMessages).toHaveLength(1);
  });
});
