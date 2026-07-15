import { describe, test, expect } from "bun:test";
import {
  normalizeGoal,
  createGoalBudgetTracker,
  recordGoalUsage,
  goalBudgetExceeded,
  resolveMaxTurns,
  resolveMaxStopBlocks,
  resolveGoalSetAt,
  applyGoalExtension,
  limitProximity,
  GOAL_DEFAULT_MAX_TURNS,
  GOAL_DEFAULT_MAX_STOP_BLOCKS,
  INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS,
  INTERACTIVE_DEFAULT_MAX_TURNS,
  APPROACH_TURNS,
  APPROACH_STOP_BLOCKS,
  MAX_GOAL_TERMINALS,
  isGoalTerminated,
  isSameGoalInstance,
  mergeGoalTerminals,
  armGoalLifecycle,
  createGoalLifecycle,
  decodeGoalLifecycle,
  goalConfigFromLifecycle,
  isGoalLifecycleArmable,
  terminateGoalLifecycle,
  waitGoalLifecycle,
  type GoalConfig,
} from "./lifecycle.js";

describe("GoalLifecycleV1", () => {
  test("stores identity and control revision once outside config", () => {
    const lifecycle = createGoalLifecycle(
      { objective: "ship", goalId: "goal-a", revision: 3, paused: true, tokenBudget: 10 },
      "paused",
      100,
    );
    expect(lifecycle).toMatchObject({
      version: 1,
      goalId: "goal-a",
      revision: 3,
      phase: "paused",
      config: { objective: "ship", tokenBudget: 10 },
    });
    expect(lifecycle.config).not.toHaveProperty("goalId");
    expect(lifecycle.config).not.toHaveProperty("paused");
    expect(goalConfigFromLifecycle(lifecycle)).toMatchObject({
      objective: "ship",
      goalId: "goal-a",
      revision: 3,
      paused: true,
    });
  });

  test("active waits, waiting arms with the same id, and terminal never arms", () => {
    const active = createGoalLifecycle({ objective: "ship", goalId: "goal-a" }, "active", 100);
    const waiting = waitGoalLifecycle(active, 200)!;
    expect(isGoalLifecycleArmable(waiting)).toBe(true);
    expect(armGoalLifecycle(waiting, 300)).toMatchObject({
      goalId: "goal-a",
      phase: "active",
      updatedAtMs: 300,
    });
    const terminal = terminateGoalLifecycle(waiting, "completed", 400)!;
    expect(isGoalLifecycleArmable(terminal)).toBe(false);
    expect(armGoalLifecycle(terminal)).toBeUndefined();
  });

  test("strict decoder rejects unknown versions and incomplete phases", () => {
    const valid = createGoalLifecycle({ objective: "ship", goalId: "goal-a" }, "active", 100);
    expect(decodeGoalLifecycle(valid)).toEqual(valid);
    expect(decodeGoalLifecycle({ ...valid, version: 2 })).toBeUndefined();
    expect(decodeGoalLifecycle({ ...valid, phase: "waiting" })).toBeUndefined();
    expect(
      decodeGoalLifecycle({ ...valid, config: { ...valid.config, goalId: "duplicate" } }),
    ).toBeUndefined();
    expect(
      decodeGoalLifecycle({ ...valid, config: { ...valid.config, revision: 99 } }),
    ).toBeUndefined();
    expect(
      decodeGoalLifecycle({ ...valid, config: { ...valid.config, paused: true } }),
    ).toBeUndefined();
    for (const key of ["tokenBudget", "timeBudgetMs", "maxTurns", "maxStopBlocks"] as const) {
      expect(
        decodeGoalLifecycle({ ...valid, config: { ...valid.config, [key]: -1 } }),
      ).toBeUndefined();
    }
    expect(
      decodeGoalLifecycle({ ...valid, config: { ...valid.config, maxTurns: 1.5 } }),
    ).toBeUndefined();
    expect(
      decodeGoalLifecycle({ ...valid, terminal: { reason: "completed", atMs: 2 } }),
    ).toBeUndefined();
    expect(
      decodeGoalLifecycle({
        ...valid,
        phase: "waiting",
        waitingFor: "finite_background_work",
        waitingSinceMs: 2,
        terminal: { reason: "completed", atMs: 2 },
      }),
    ).toBeUndefined();
  });
});

describe("resolveMaxStopBlocks (TODO 3.1 — 续跑上限调大可配)", () => {
  test("no goal → tighter interactive default (8), NOT the goal default (25)", () => {
    // Bug B3: a non-goal run must not inherit the goal-mode 25-block cap, or a
    // plugin on_stop hook that keeps returning continueSession loops 25× before
    // the backstop bites. Non-goal falls back to INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS.
    expect(resolveMaxStopBlocks(undefined, undefined)).toBe(INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS);
    expect(INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS).toBe(8);
  });
  test("goal active, no override → GOAL_DEFAULT_MAX_STOP_BLOCKS (>8)", () => {
    expect(resolveMaxStopBlocks(undefined, { objective: "x" })).toBe(GOAL_DEFAULT_MAX_STOP_BLOCKS);
    expect(GOAL_DEFAULT_MAX_STOP_BLOCKS).toBeGreaterThan(INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS);
  });
  test("explicit config override wins", () => {
    expect(resolveMaxStopBlocks(40, { objective: "x", maxStopBlocks: 12 })).toBe(40);
  });
  test("goal.maxStopBlocks used when no config override", () => {
    expect(resolveMaxStopBlocks(undefined, { objective: "x", maxStopBlocks: 12 })).toBe(12);
  });
  test("non-positive override falls through (goal→25, no-goal→8)", () => {
    expect(resolveMaxStopBlocks(0, { objective: "x" })).toBe(GOAL_DEFAULT_MAX_STOP_BLOCKS);
    expect(resolveMaxStopBlocks(-3, undefined)).toBe(INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS);
  });
  test("normalizeGoal floors + drops non-positive maxStopBlocks", () => {
    expect(normalizeGoal({ objective: "x", maxStopBlocks: 15.9 })?.maxStopBlocks).toBe(15);
    expect(normalizeGoal({ objective: "x", maxStopBlocks: 0 })?.maxStopBlocks).toBeUndefined();
    expect(normalizeGoal({ objective: "x", maxStopBlocks: -2 })?.maxStopBlocks).toBeUndefined();
  });
});

describe("limitProximity (TODO 3.1 — 统一的「临近上限」信号)", () => {
  test("turns near the cap → approaching, nearest=turns", () => {
    // maxStopBlocks far away, only turns close.
    const p = limitProximity(297, 300, 0, 25);
    expect(p.turnsRemaining).toBe(3);
    expect(p.stopBlocksRemaining).toBe(25);
    expect(p.approaching).toBe(true);
    expect(p.nearest).toBe("turns");
  });
  test("stop-blocks near the cap → approaching, nearest=stopBlocks (the limit that actually bites)", () => {
    // The common case: a re-blocked goal hits the 25-block cap long before turn 298.
    const p = limitProximity(40, 300, 23, 25);
    expect(p.stopBlocksRemaining).toBe(2);
    expect(p.approaching).toBe(true);
    expect(p.nearest).toBe("stopBlocks");
  });
  test("neither near → not approaching", () => {
    const p = limitProximity(40, 300, 2, 25);
    expect(p.approaching).toBe(false);
  });
  test("thresholds: exactly at the approach boundary counts as approaching", () => {
    expect(limitProximity(300 - APPROACH_TURNS, 300, 0, 25).approaching).toBe(true);
    expect(limitProximity(0, 300, 25 - APPROACH_STOP_BLOCKS, 25).approaching).toBe(true);
  });
  test("stopBlocks wins nearest when both are near", () => {
    const p = limitProximity(298, 300, 23, 25);
    expect(p.approaching).toBe(true);
    expect(p.nearest).toBe("stopBlocks");
  });
});

describe("applyGoalExtension (TODO 3.1 — 运行中续轮/加预算)", () => {
  // Signature: applyGoalExtension(currentMaxTurns, goal, tokensUsed, elapsedMs, ext)
  test("addTurns bumps the ceiling (floored, positive only)", () => {
    expect(applyGoalExtension(100, undefined, 0, 0, { addTurns: 50 }).maxTurns).toBe(150);
    expect(applyGoalExtension(100, undefined, 0, 0, { addTurns: 0.9 }).maxTurns).toBe(100);
    expect(applyGoalExtension(100, undefined, 0, 0, { addTurns: -5 }).maxTurns).toBe(100);
    expect(applyGoalExtension(100, undefined, 0, 0, { addTurns: 10.7 }).maxTurns).toBe(110);
  });

  test("raises an existing token/time budget", () => {
    const goal: GoalConfig = { objective: "x", tokenBudget: 1000, timeBudgetMs: 60_000 };
    const r = applyGoalExtension(100, goal, 500, 10_000, {
      addTokenBudget: 500,
      addTimeBudgetMs: 30_000,
    });
    expect(r.tokenBudget).toBe(1500);
    expect(r.timeBudgetMs).toBe(90_000);
  });

  test("seeds an unset token budget from current usage so the new cap is above it", () => {
    const goal: GoalConfig = { objective: "x" }; // unlimited tokens
    const r = applyGoalExtension(100, goal, 800, 0, { addTokenBudget: 200 });
    expect(r.tokenBudget).toBe(1000); // 800 used + 200 added
  });

  test("seeds an unset TIME budget from elapsed (not 0) so extending a long run doesn't insta-stop", () => {
    // Bug B1: a goal alive 120s with no time cap, extended by 60s, must get a cap
    // ABOVE current usage (180s), not 60s — else goalBudgetExceeded fires immediately.
    const goal: GoalConfig = { objective: "x" }; // unlimited time
    const r = applyGoalExtension(100, goal, 0, 120_000, { addTimeBudgetMs: 60_000 });
    expect(r.timeBudgetMs).toBe(180_000); // 120s elapsed + 60s added
  });

  test("addStopBlocks is accepted and does not perturb budgets", () => {
    const goal: GoalConfig = { objective: "x", tokenBudget: 1000 };
    const r = applyGoalExtension(100, goal, 0, 0, { addStopBlocks: 15 });
    expect(r.tokenBudget).toBe(1000);
    expect(r.timeBudgetMs).toBeUndefined();
    expect(r.maxTurns).toBe(100);
  });

  test("does not touch budgets when no goal", () => {
    const r = applyGoalExtension(100, undefined, 0, 0, { addTokenBudget: 500 });
    expect(r.tokenBudget).toBeUndefined();
    expect(r.timeBudgetMs).toBeUndefined();
  });

  test("never mutates the input goal object", () => {
    const goal: GoalConfig = { objective: "x", tokenBudget: 1000 };
    applyGoalExtension(100, goal, 0, 0, { addTokenBudget: 500 });
    expect(goal.tokenBudget).toBe(1000);
  });
});

describe("resolveGoalSetAt (goal-set anchor for relative deadlines)", () => {
  const NOW = 2_000_000_000_000;
  test("first goal on a session → stamps now", () => {
    expect(resolveGoalSetAt("做到3点", undefined, NOW)).toBe(NOW);
  });
  test("a CHANGED objective → fresh stamp (user restated a new goal/deadline)", () => {
    const stored: GoalConfig = { objective: "旧目标", setAtMs: 1_000 };
    expect(resolveGoalSetAt("新目标 做到5点", stored, NOW)).toBe(NOW);
  });
  test("the SAME objective continuing → keeps the original anchor, not now", () => {
    const stored: GoalConfig = { objective: "做到3点", setAtMs: 1_000 };
    expect(resolveGoalSetAt("做到3点", stored, NOW)).toBe(1_000);
  });
  test("same objective but stored predates the field → falls back to now", () => {
    const stored: GoalConfig = { objective: "做到3点" }; // no setAtMs
    expect(resolveGoalSetAt("做到3点", stored, NOW)).toBe(NOW);
  });
});

describe("normalizeGoal", () => {
  test("undefined → undefined", () => {
    expect(normalizeGoal(undefined)).toBeUndefined();
  });
  test("empty/whitespace string → undefined (no goal)", () => {
    expect(normalizeGoal("")).toBeUndefined();
    expect(normalizeGoal("   ")).toBeUndefined();
  });
  test("string → {objective}", () => {
    expect(normalizeGoal("ship it")).toEqual({ objective: "ship it" });
  });
  test("object passes through, objective trimmed", () => {
    const g: GoalConfig = { objective: "  do x  ", tokenBudget: 1000, timeBudgetMs: 5000 };
    expect(normalizeGoal(g)).toEqual({ objective: "do x", tokenBudget: 1000, timeBudgetMs: 5000 });
  });
  test("object with empty objective → undefined", () => {
    expect(normalizeGoal({ objective: "  " })).toBeUndefined();
  });
  test("non-positive budgets are dropped (treated as no limit)", () => {
    expect(normalizeGoal({ objective: "x", tokenBudget: 0, timeBudgetMs: -1 })).toEqual({
      objective: "x",
    });
  });
  test("setAtMs (goal-set timestamp) is preserved when positive, dropped otherwise", () => {
    // Preserved so a resumed/inherited goal keeps the moment the user set it —
    // the judge needs it to anchor relative deadlines like 「做到3点」.
    expect(normalizeGoal({ objective: "x", setAtMs: 1_700_000_000_000 })).toEqual({
      objective: "x",
      setAtMs: 1_700_000_000_000,
    });
    // Junk values don't leak through as a bogus anchor.
    expect(normalizeGoal({ objective: "x", setAtMs: 0 })?.setAtMs).toBeUndefined();
    expect(normalizeGoal({ objective: "x", setAtMs: -5 })?.setAtMs).toBeUndefined();
  });
  test("maxTurns is normalized: positive kept (floored), non-positive dropped", () => {
    expect(normalizeGoal({ objective: "x", maxTurns: 250 })).toEqual({
      objective: "x",
      maxTurns: 250,
    });
    expect(normalizeGoal({ objective: "x", maxTurns: 12.9 })).toEqual({
      objective: "x",
      maxTurns: 12,
    });
    expect(normalizeGoal({ objective: "x", maxTurns: 0 })).toEqual({ objective: "x" });
    expect(normalizeGoal({ objective: "x", maxTurns: -5 })).toEqual({ objective: "x" });
  });
});

describe("goal instance identity", () => {
  test("goalId is authoritative while two id-less values use the legacy signature", () => {
    expect(
      isSameGoalInstance(
        { objective: "renamed", goalId: "goal-1", setAtMs: 2 },
        { objective: "old", goalId: "goal-1", setAtMs: 1 },
      ),
    ).toBe(true);
    expect(
      isSameGoalInstance(
        { objective: "same", goalId: "goal-1", setAtMs: 1 },
        { objective: "same", goalId: "goal-2", setAtMs: 1 },
      ),
    ).toBe(false);
    expect(
      isSameGoalInstance({ objective: "legacy", setAtMs: 1 }, { objective: "legacy", setAtMs: 1 }),
    ).toBe(true);
  });

  test("a migrated terminal still rejects an id-less legacy snapshot", () => {
    expect(
      isGoalTerminated({ objective: "legacy", setAtMs: 1 }, [
        {
          objective: "legacy",
          goalId: "migrated-id",
          setAtMs: 1,
          reason: "completed",
        },
      ]),
    ).toBe(true);
  });

  test("terminal identity history is deduped and bounded", () => {
    const terminals = mergeGoalTerminals(
      Array.from({ length: MAX_GOAL_TERMINALS + 2 }, (_, index) => ({
        objective: `goal ${index}`,
        goalId: `goal-${index}`,
        reason: "cancelled" as const,
      })),
    );
    expect(terminals).toHaveLength(MAX_GOAL_TERMINALS);
    expect(terminals[0]?.goalId).toBe("goal-2");
    expect(terminals.at(-1)?.goalId).toBe(`goal-${MAX_GOAL_TERMINALS + 1}`);
  });

  test("terminal identity history keeps the newest timestamps regardless of source order", () => {
    const newer = Array.from({ length: MAX_GOAL_TERMINALS }, (_, index) => ({
      objective: `new goal ${index}`,
      goalId: `new-${index}`,
      reason: "cancelled" as const,
      terminatedAtMs: 1_000 + index,
    }));
    const older = Array.from({ length: MAX_GOAL_TERMINALS }, (_, index) => ({
      objective: `old goal ${index}`,
      goalId: `old-${index}`,
      reason: "cancelled" as const,
      terminatedAtMs: index,
    }));

    const terminals = mergeGoalTerminals(newer, older);

    expect(terminals.map((terminal) => terminal.goalId)).toEqual(
      newer.map((terminal) => terminal.goalId),
    );
  });
});

// TODO §3.1 — goal runs need a higher turn ceiling than interactive prompts.
describe("resolveMaxTurns (goal-aware turn ceiling)", () => {
  test("no goal, no override → interactive default", () => {
    expect(resolveMaxTurns(undefined, undefined)).toBe(INTERACTIVE_DEFAULT_MAX_TURNS);
  });
  test("goal active, no per-goal cap → goal default (higher)", () => {
    expect(resolveMaxTurns(undefined, { objective: "x" })).toBe(GOAL_DEFAULT_MAX_TURNS);
    expect(GOAL_DEFAULT_MAX_TURNS).toBeGreaterThan(INTERACTIVE_DEFAULT_MAX_TURNS);
  });
  test("per-goal maxTurns wins over the goal default", () => {
    expect(resolveMaxTurns(undefined, { objective: "x", maxTurns: 42 })).toBe(42);
  });
  test("explicit config override always wins (even over goal cap)", () => {
    expect(resolveMaxTurns(7, { objective: "x", maxTurns: 42 })).toBe(7);
    expect(resolveMaxTurns(7, undefined)).toBe(7);
  });
  test("non-positive config override is ignored, falls through", () => {
    expect(resolveMaxTurns(0, { objective: "x" })).toBe(GOAL_DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(-1, undefined)).toBe(INTERACTIVE_DEFAULT_MAX_TURNS);
  });
});

describe("goal budget tracker", () => {
  test("fresh tracker is under budget", () => {
    const t = createGoalBudgetTracker({ objective: "x", tokenBudget: 100 }, 1000);
    expect(goalBudgetExceeded(t, 1000)).toBe(false);
  });
  test("token budget exceeded after recording usage", () => {
    const t = createGoalBudgetTracker({ objective: "x", tokenBudget: 100 }, 1000);
    recordGoalUsage(t, 60);
    expect(goalBudgetExceeded(t, 1000)).toBe(false);
    recordGoalUsage(t, 50); // total 110 > 100
    expect(goalBudgetExceeded(t, 1000)).toBe(true);
  });
  test("time budget exceeded by wall clock", () => {
    const t = createGoalBudgetTracker({ objective: "x", timeBudgetMs: 5000 }, 1000);
    expect(goalBudgetExceeded(t, 5500)).toBe(false); // 4500ms elapsed
    expect(goalBudgetExceeded(t, 6001)).toBe(true); // 5001ms elapsed
  });
  test("no budgets set → never exceeded", () => {
    const t = createGoalBudgetTracker({ objective: "x" }, 1000);
    recordGoalUsage(t, 1_000_000);
    expect(goalBudgetExceeded(t, 10_000_000)).toBe(false);
  });
});
