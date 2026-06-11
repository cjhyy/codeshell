import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../types.js";

/**
 * B-2: the fire-and-forget tool-use summary chain must never surface as an
 * unhandled rejection — not when summarize() rejects, and not when the
 * onStream handler itself throws on the tool_summary event. The loop result
 * must be unaffected.
 */
function makeDeps(opts: {
  responses: LLMResponse[];
  summarize: (sys: string, user: string) => Promise<string>;
}): TurnLoopDeps {
  let i = 0;
  const call = async (): Promise<LLMResponse> => opts.responses[Math.min(i++, opts.responses.length - 1)];
  const model = {
    call,
    callWithoutStreaming: call,
    getUsage: () => ({ records: [], totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, requestCount: 0 }),
    getOutputTokens: () => 0,
    summarize: opts.summarize,
  } as unknown as TurnLoopDeps["model"];
  const contextManager = {
    async manageAsync(m: Message[]) { return m; },
    manage(m: Message[]) { return m; },
    recordActualUsage() {},
    shouldReactiveCompact() { return false; },
  } as unknown as TurnLoopDeps["contextManager"];
  const hooks = { async emit() { return {}; } } as unknown as TurnLoopDeps["hooks"];
  const transcript = {
    appendToolUse() {}, appendToolResult() {}, appendTurnBoundary() {}, appendMessage() {},
  } as unknown as TurnLoopDeps["transcript"];
  const toolExecutor = {
    setLogger() {},
    getInvestigationGuard() { return undefined; },
    getTaskGuard() { return undefined; },
    isConcurrencySafe() { return false; },
    async executeSingle(c: ToolCall): Promise<ToolResult> {
      return { id: c.id, toolName: c.toolName, result: "ok" };
    },
  } as unknown as TurnLoopDeps["toolExecutor"];
  return {
    model, toolExecutor, contextManager, hooks, transcript,
    systemPrompt: "sys", tools: [], sessionId: "test",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };
}

const toolResp = (): LLMResponse => ({
  text: "",
  toolCalls: [{ id: "c0", toolName: "Read", args: {} }],
  stopReason: "tool_use",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});
const doneResp = (): LLMResponse => ({
  text: "done",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

describe("TurnLoop tool-summary is crash-safe (B-2)", () => {
  it("completes without an unhandled rejection when summarize() rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const deps = makeDeps({
        responses: [toolResp(), doneResp()],
        summarize: async () => {
          throw new Error("summarize boom");
        },
      });
      // onStream present (the summary path only runs when config.onStream is
      // set) and itself throws on tool_summary — the loop's onStream wrap +
      // the new tail .catch must both hold.
      const config = {
        maxTurns: 5,
        maxToolCallsPerTurn: 10,
        onStream: (e: unknown) => {
          if ((e as { type?: string }).type === "tool_summary") throw new Error("onStream boom");
        },
      } as unknown as TurnLoopConfig;
      const loop = new TurnLoop(deps, config);

      const result = await loop.run([{ role: "user", content: "go" }]);
      expect(result.reason).toBe("completed");
      expect(result.text).toBe("done");

      // Let the fire-and-forget summary microtasks flush.
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
