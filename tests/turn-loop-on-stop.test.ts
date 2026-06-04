import { describe, it, expect } from "bun:test";
import { TurnLoop } from "../packages/core/src/engine/turn-loop.ts";
import type {
  TurnLoopConfig,
  TurnLoopDeps,
} from "../packages/core/src/engine/turn-loop.ts";
import { HookRegistry } from "../packages/core/src/hooks/registry.ts";
import type { LLMResponse, Message } from "../packages/core/src/types.ts";

/**
 * Scripted model: returns the next queued response per call. All responses
 * here have no tool calls, so each one drives the loop to the on_stop seam.
 */
function scriptedModel(responses: LLMResponse[]) {
  let i = 0;
  const calls: Message[][] = [];
  const facade = {
    call: async (_sys: string, messages: Message[]) => {
      calls.push(messages.map((m) => ({ ...m })));
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
    callWithoutStreaming: async (_sys: string, messages: Message[]) => {
      calls.push(messages.map((m) => ({ ...m })));
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
    getUsage: () => ({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
    }),
    getOutputTokens: () => 0,
  };
  return { facade, calls, callCount: () => i };
}

function makeDeps(model: ReturnType<typeof scriptedModel>): {
  deps: TurnLoopDeps;
  hooks: HookRegistry;
} {
  const hooks = new HookRegistry();
  const deps = {
    model: model.facade,
    toolExecutor: {
      setLogger: () => {},
      getInvestigationGuard: () => undefined,
      getTaskGuard: () => undefined,
    },
    contextManager: {
      manageAsync: async (m: Message[]) => m,
      manage: (m: Message[]) => m,
      recordActualUsage: () => {},
      shouldReactiveCompact: () => false,
    },
    hooks,
    transcript: {
      appendToolUse: () => {},
      appendToolResult: () => {},
      appendTurnBoundary: () => {},
    },
    systemPrompt: "sys",
    tools: [],
    sessionId: "s1",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  } as unknown as TurnLoopDeps;
  return { deps, hooks };
}

const noTool = (text: string): LLMResponse => ({ text, toolCalls: [] });

function makeConfig(over: Partial<TurnLoopConfig> = {}): TurnLoopConfig {
  return { maxTurns: 20, maxToolCallsPerTurn: 10, ...over };
}

describe("TurnLoop on_stop seam", () => {
  it("returns completed normally when no on_stop handler is registered", async () => {
    const model = scriptedModel([noTool("done")]);
    const { deps } = makeDeps(model);
    const loop = new TurnLoop(deps, makeConfig());
    const result = await loop.run([{ role: "user", content: "go" }]);
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("done");
    expect(model.callCount()).toBe(1);
  });

  it("blocks termination and injects messages when handler returns continueSession", async () => {
    const model = scriptedModel([noTool("first"), noTool("second")]);
    const { deps, hooks } = makeDeps(model);
    let fired = 0;
    hooks.register("on_stop", () => {
      fired++;
      // Block only the first stop; allow the second.
      if (fired === 1) {
        return { continueSession: true, messages: ["keep going: do X"] };
      }
      return {};
    });
    const loop = new TurnLoop(deps, makeConfig());
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(result.text).toBe("second");
    // Two model calls: the blocked one + the continuation.
    expect(model.callCount()).toBe(2);
    // The continuation turn saw the injected reminder in its message array.
    const secondTurnMessages = model.calls[1];
    const injected = secondTurnMessages.find(
      (m) => typeof m.content === "string" && m.content.includes("keep going: do X"),
    );
    expect(injected).toBeDefined();
    expect(injected!.role).toBe("user");
  });

  it("forces a stop after maxStopBlocks consecutive blocks", async () => {
    // Handler always wants to continue — only the cap should stop it.
    const model = scriptedModel([noTool("loop")]);
    const { deps, hooks } = makeDeps(model);
    let fired = 0;
    hooks.register("on_stop", () => {
      fired++;
      return { continueSession: true, messages: ["again"] };
    });
    const loop = new TurnLoop(deps, makeConfig({ maxStopBlocks: 3 }));
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    // 3 blocks → 1 initial + 3 continuation turns = 4 model calls.
    expect(model.callCount()).toBe(4);
    // on_stop fired once per completion attempt: 3 blocked + 1 final (capped).
    expect(fired).toBe(4);
  });

  it("passes the goal text to on_stop handlers via ctx.data", async () => {
    const model = scriptedModel([noTool("done")]);
    const { deps, hooks } = makeDeps(model);
    let seenGoal: unknown;
    hooks.register("on_stop", (ctx) => {
      seenGoal = ctx.data.goal;
      return {};
    });
    const loop = new TurnLoop(deps, makeConfig({ goal: "ship the feature" }));
    await loop.run([{ role: "user", content: "go" }]);
    expect(seenGoal).toBe("ship the feature");
  });
});

describe("TurnLoop goal_progress events", () => {
  // Goal visibility: the loop emits a goal_progress event each time the judge
  // re-prompts (not_met, with round + gaps), once when the goal is finally met
  // (met, round = total rounds), and once when the block cap forces a stop
  // (exhausted). The UI counts these to show how many rounds the goal ran.
  type GP = Extract<import("../packages/core/src/types.ts").StreamEvent, { type: "goal_progress" }>;

  it("emits not_met with running round + gaps each time the judge re-prompts, then met", async () => {
    const model = scriptedModel([noTool("a"), noTool("b"), noTool("c")]);
    const { deps, hooks } = makeDeps(model);
    let fired = 0;
    // Judge: not met (round 1), not met (round 2), then met.
    hooks.register("on_stop", () => {
      fired++;
      if (fired === 1) return { continueSession: true, messages: ["go"], data: { goalVerdict: { met: false, gaps: "缺测试" } } };
      if (fired === 2) return { continueSession: true, messages: ["go"], data: { goalVerdict: { met: false, gaps: "缺类型" } } };
      return { data: { goalVerdict: { met: true, gaps: "" } } };
    });
    const events: GP[] = [];
    const loop = new TurnLoop(deps, makeConfig({
      goal: "make it pass",
      onStream: (e) => { if (e.type === "goal_progress") events.push(e as GP); },
    }));
    await loop.run([{ role: "user", content: "go" }]);

    expect(events).toEqual([
      { type: "goal_progress", status: "not_met", round: 1, gaps: "缺测试" },
      { type: "goal_progress", status: "not_met", round: 2, gaps: "缺类型" },
      { type: "goal_progress", status: "met", round: 3 },
    ]);
  });

  it("emits exhausted when the block cap forces a stop", async () => {
    const model = scriptedModel([noTool("loop")]);
    const { deps, hooks } = makeDeps(model);
    hooks.register("on_stop", () => ({
      continueSession: true,
      messages: ["again"],
      data: { goalVerdict: { met: false, gaps: "still going" } },
    }));
    const events: GP[] = [];
    const loop = new TurnLoop(deps, makeConfig({
      goal: "unsatisfiable",
      maxStopBlocks: 2,
      onStream: (e) => { if (e.type === "goal_progress") events.push(e as GP); },
    }));
    await loop.run([{ role: "user", content: "go" }]);

    // 2 not_met rounds, then exhausted at the cap.
    expect(events.map((e) => e.status)).toEqual(["not_met", "not_met", "exhausted"]);
    expect(events[events.length - 1]!.round).toBe(2);
  });

  it("emits nothing when there is no goal (plain run)", async () => {
    const model = scriptedModel([noTool("done")]);
    const { deps } = makeDeps(model);
    const events: GP[] = [];
    const loop = new TurnLoop(deps, makeConfig({
      onStream: (e) => { if (e.type === "goal_progress") events.push(e as GP); },
    }));
    await loop.run([{ role: "user", content: "go" }]);
    expect(events).toEqual([]);
  });
});
