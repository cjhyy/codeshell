import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message } from "../types.js";

/**
 * Abort-propagation tests for the sub-agent leak fix.
 *
 * Background: a synchronous sub-agent whose signal aborts (parent abort, or
 * the 30min registry timeout) must STOP at the next wait point. The bug was
 * that the turn loop only checked `signal.aborted` AFTER the model call
 * (turn-loop.ts:466), so an aborted child would: run contextManager.manageAsync
 * (itself an LLM call), run a full model call, execute a tool batch, and start
 * another turn — burning turns/tokens long after the parent already returned.
 *
 * These tests assert the loop short-circuits at the loop top and after
 * manageAsync, i.e. WITHOUT issuing the model call for the aborted turn.
 */

interface Hooks {
  manageAsyncSpy?: () => void;
  /** Called after each model.call resolves, with the 1-based call index. */
  afterModelCall?: (n: number) => void;
}

function makeDeps(
  responses: LLMResponse[],
  hooks: Hooks = {},
): { deps: TurnLoopDeps; calls: () => number } {
  let i = 0;
  const call = async (_sys: string, _messages: Message[]): Promise<LLMResponse> => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    hooks.afterModelCall?.(i);
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
      hooks.manageAsyncSpy?.();
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

  const hookReg = {
    async emit() {
      return {};
    },
  } as unknown as TurnLoopDeps["hooks"];

  const transcript = {
    appendToolUse() {},
    appendToolResult() {},
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
  } as unknown as TurnLoopDeps["toolExecutor"];

  const deps: TurnLoopDeps = {
    model,
    toolExecutor,
    contextManager,
    hooks: hookReg,
    transcript,
    systemPrompt: "sys",
    tools: [],
    sessionId: "test",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };

  return { deps, calls: () => i };
}

/** A response that wants to keep going (one tool call) so the loop would
 *  normally start another turn. */
const toolResp = (): LLMResponse => ({
  text: "",
  toolCalls: [{ id: "c1", toolName: "Read", args: { file_path: "/x" } }],
  stopReason: "tool_calls",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

describe("TurnLoop abort propagation", () => {
  it("stops at the loop top when the signal is already aborted (no model call)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, calls } = makeDeps([toolResp()]);
    const config: TurnLoopConfig = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      signal: controller.signal,
    };
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("aborted_streaming");
    // The aborted turn must not have issued a model call at all.
    expect(calls()).toBe(0);
  });

  it("does not start a NEW turn after an abort fires mid-run", async () => {
    // Turn 1 runs fully (model + tool phase) and returns a tool call (loop wants
    // to continue). The signal aborts right after turn 1's model call resolves
    // — simulating a parent abort / timeout landing during turn 1's tool work.
    // Turn 2's loop-top guard must then stop without issuing a second model call.
    const controller = new AbortController();
    const { deps, calls } = makeDeps([toolResp(), toolResp()], {
      afterModelCall: (n) => {
        if (n === 1) controller.abort();
      },
    });
    const config: TurnLoopConfig = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      signal: controller.signal,
    };
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("aborted_streaming");
    // Turn 1 issued exactly one model call; turn 2 must NOT have issued another.
    expect(calls()).toBe(1);
  });

  it("stops after manageAsync if the signal aborts during context management (no model call)", async () => {
    const controller = new AbortController();
    const { deps, calls } = makeDeps([toolResp()], {
      // manageAsync itself can issue an LLM summarization; simulate the signal
      // aborting during that work. The loop must check AFTER manageAsync and
      // bail before the main model call.
      manageAsyncSpy: () => controller.abort(),
    });
    const config: TurnLoopConfig = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      signal: controller.signal,
    };
    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("aborted_streaming");
    expect(calls()).toBe(0);
  });
});
