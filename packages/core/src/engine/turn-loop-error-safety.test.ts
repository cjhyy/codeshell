import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { Message } from "../types.js";

/**
 * A1/A4: TurnLoop.run must never reject. The engine's post-run bookkeeping
 * (saveState with the terminal reason, session_end hook) lives AFTER the
 * `await turnLoop.run(...)` call and outside its try — so if run() threw, the
 * session was left frozen at status "active" on disk. run() must catch
 * unexpected throws and resolve with a terminal reason instead.
 */
function depsWithThrowingManage(): TurnLoopDeps {
  const model = {
    async call() {
      return { text: "", toolCalls: [], stopReason: "stop" };
    },
    async callWithoutStreaming() {
      return { text: "", toolCalls: [], stopReason: "stop" };
    },
    getUsage: () => ({
      records: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    }),
    getOutputTokens: () => 0,
  } as unknown as TurnLoopDeps["model"];

  const contextManager = {
    async manageAsync() {
      throw new Error("boom from context manager");
    },
    manage: (m: Message[]) => m,
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
    hooks: { async emit() { return {}; } } as unknown as TurnLoopDeps["hooks"],
    transcript: {
      appendToolUse() {},
      appendToolResult() {},
      appendTurnBoundary() {},
      appendMessage() {},
    } as unknown as TurnLoopDeps["transcript"],
    systemPrompt: "sys",
    tools: [],
    sessionId: "test",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };
}

const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };

describe("TurnLoop error safety", () => {
  it("resolves with a terminal reason instead of rejecting when a dep throws", async () => {
    const loop = new TurnLoop(depsWithThrowingManage(), config);
    // Must not reject.
    const result = await loop.run([{ role: "user", content: "go" }]);
    expect(result.reason).toBe("model_error");
    // messages are still returned so the engine can persist something coherent.
    expect(Array.isArray(result.messages)).toBe(true);
  });
});
