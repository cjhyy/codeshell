import { describe, it, expect } from "bun:test";
import { TurnLoop } from "../packages/core/src/engine/turn-loop.ts";
import type { TurnLoopConfig, TurnLoopDeps } from "../packages/core/src/engine/turn-loop.ts";
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
    expect(seenGoal).toMatchObject({ objective: "ship the feature" });
    expect((seenGoal as { goalId?: string }).goalId).toBeString();
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
      if (fired === 1)
        return {
          continueSession: true,
          messages: ["go"],
          data: { goalVerdict: { met: false, gaps: "缺测试" } },
        };
      if (fired === 2)
        return {
          continueSession: true,
          messages: ["go"],
          data: { goalVerdict: { met: false, gaps: "缺类型" } },
        };
      return { data: { goalVerdict: { met: true, gaps: "" } } };
    });
    const events: GP[] = [];
    const loop = new TurnLoop(
      deps,
      makeConfig({
        goal: "make it pass",
        onStream: (e) => {
          if (e.type === "goal_progress") events.push(e as GP);
        },
      }),
    );
    await loop.run([{ role: "user", content: "go" }]);

    const goalId = events[0]?.goalId;
    expect(goalId).toBeString();
    expect(events).toEqual([
      { type: "goal_progress", goalId, status: "not_met", round: 1, gaps: "缺测试" },
      { type: "goal_progress", goalId, status: "not_met", round: 2, gaps: "缺类型" },
      { type: "goal_progress", goalId, status: "met", round: 3 },
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
    const loop = new TurnLoop(
      deps,
      makeConfig({
        goal: "unsatisfiable",
        maxStopBlocks: 2,
        onStream: (e) => {
          if (e.type === "goal_progress") events.push(e as GP);
        },
      }),
    );
    await loop.run([{ role: "user", content: "go" }]);

    // 2 not_met rounds, then exhausted at the cap. An approaching_limit marker
    // is also emitted once as the tight cap (2) is neared; filter it out to
    // assert the verdict sequence.
    const verdicts = events.filter((e) => e.status !== "approaching_limit");
    expect(verdicts.map((e) => e.status)).toEqual(["not_met", "not_met", "exhausted"]);
    expect(verdicts[verdicts.length - 1]!.round).toBe(2);
  });

  it("emits nothing when there is no goal (plain run)", async () => {
    const model = scriptedModel([noTool("done")]);
    const { deps } = makeDeps(model);
    const events: GP[] = [];
    const loop = new TurnLoop(
      deps,
      makeConfig({
        onStream: (e) => {
          if (e.type === "goal_progress") events.push(e as GP);
        },
      }),
    );
    await loop.run([{ role: "user", content: "go" }]);
    expect(events).toEqual([]);
  });

  it("emits approaching_limit (nearest=stopBlocks) BEFORE the cap, not just at maxTurns", async () => {
    // A re-blocked goal with a tight block cap should warn as it nears the cap,
    // carrying nearest=stopBlocks (the limit that actually bites) — the old code
    // only warned at turnsRemaining===2 against maxTurns, which a re-blocked goal
    // never reaches. maxStopBlocks=4, APPROACH_STOP_BLOCKS=3 → warns once when
    // stopBlocksRemaining first hits 3 (after the 1st block).
    const model = scriptedModel([noTool("loop")]);
    const { deps, hooks } = makeDeps(model);
    hooks.register("on_stop", () => ({
      continueSession: true,
      messages: ["again"],
      data: { goalVerdict: { met: false, gaps: "g" } },
    }));
    const events: GP[] = [];
    const loop = new TurnLoop(
      deps,
      makeConfig({
        goal: "unsatisfiable",
        maxTurns: 300,
        maxStopBlocks: 4,
        onStream: (e) => {
          if (e.type === "goal_progress") events.push(e as GP);
        },
      }),
    );
    await loop.run([{ role: "user", content: "go" }]);

    const approaching = events.filter((e) => e.status === "approaching_limit");
    expect(approaching.length).toBe(1); // announced once, not stacked
    expect(approaching[0]!.nearest).toBe("stopBlocks");
    expect(approaching[0]!.stopBlocksRemaining).toBeLessThanOrEqual(3);
    // It must come before the terminal "exhausted".
    const lastStatus = events[events.length - 1]!.status;
    expect(lastStatus).toBe("exhausted");
  });
});

describe("TurnLoop.extend (TODO 3.1 — 续跑作用于真正逼停的维度)", () => {
  it("addStopBlocks raises the cap AND resets the streak so the run keeps going", async () => {
    // The goal would be capped at maxStopBlocks=3, but we extend at the 2nd
    // block. After extend the streak resets and the cap is higher, so the run
    // survives more blocks before exhausting.
    const model = scriptedModel([noTool("loop")]);
    const { deps, hooks } = makeDeps(model);
    let fired = 0;
    let loopRef: TurnLoop | null = null;
    hooks.register("on_stop", () => {
      fired++;
      if (fired === 2) {
        // Mid-run extension: raise the cap and reset the streak.
        loopRef!.extend({ addStopBlocks: 5 });
      }
      return {
        continueSession: true,
        messages: ["again"],
        data: { goalVerdict: { met: false, gaps: "g" } },
      };
    });
    const loop = new TurnLoop(deps, makeConfig({ goal: { objective: "g" }, maxStopBlocks: 3 }));
    loopRef = loop;
    const result = await loop.run([{ role: "user", content: "go" }]);
    expect(result.reason).toBe("completed");
    // Without extend: capped after 3 blocks (4 fires). With extend at fire #2
    // (reset to 0, cap now 8), it runs well past 4 — at least 6 fires.
    expect(fired).toBeGreaterThan(4);
  });

  it("a budget-only extension also resets the stop-block streak (not just addTurns)", async () => {
    // Bug: the old extend() reset stopBlockCount ONLY for addTurns, so a
    // budget-only extension left a capped goal stuck. Extending time should
    // reset the streak too.
    const model = scriptedModel([noTool("loop")]);
    const { deps, hooks } = makeDeps(model);
    let fired = 0;
    let loopRef: TurnLoop | null = null;
    hooks.register("on_stop", () => {
      fired++;
      if (fired === 2) loopRef!.extend({ addTimeBudgetMs: 600_000 });
      return {
        continueSession: true,
        messages: ["again"],
        data: { goalVerdict: { met: false, gaps: "g" } },
      };
    });
    const loop = new TurnLoop(deps, makeConfig({ goal: { objective: "g" }, maxStopBlocks: 3 }));
    loopRef = loop;
    await loop.run([{ role: "user", content: "go" }]);
    // The streak reset means it doesn't cap at the original 3 blocks (4 fires).
    expect(fired).toBeGreaterThan(4);
  });

  it("extending time on a long-running unbounded goal does NOT insta-stop (B1)", async () => {
    // Goal with no time budget; we extend time mid-run. The new cap must seed
    // from elapsed time, so goalBudgetExceeded does not fire immediately.
    const model = scriptedModel([noTool("loop")]);
    const { deps, hooks } = makeDeps(model);
    let fired = 0;
    let loopRef: TurnLoop | null = null;
    hooks.register("on_stop", () => {
      fired++;
      if (fired === 1) loopRef!.extend({ addTimeBudgetMs: 600_000 });
      // After extend, allow it to finish on the 3rd attempt.
      if (fired >= 3) return { data: { goalVerdict: { met: true, gaps: "" } } };
      return {
        continueSession: true,
        messages: ["again"],
        data: { goalVerdict: { met: false, gaps: "g" } },
      };
    });
    const loop = new TurnLoop(deps, makeConfig({ goal: { objective: "g" }, maxStopBlocks: 25 }));
    loopRef = loop;
    const result = await loop.run([{ role: "user", content: "go" }]);
    // Must reach the met verdict, NOT a premature goal_budget_exhausted.
    expect(result.reason).toBe("completed");
    expect(fired).toBeGreaterThanOrEqual(3);
  });
});
