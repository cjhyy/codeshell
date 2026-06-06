import { describe, test, expect } from "bun:test";
import {
  normalizeGoal,
  createGoalBudgetTracker,
  recordGoalUsage,
  goalBudgetExceeded,
  resolveMaxTurns,
  resolveMaxStopBlocks,
  applyGoalExtension,
  limitProximity,
  GOAL_DEFAULT_MAX_TURNS,
  GOAL_DEFAULT_MAX_STOP_BLOCKS,
  INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS,
  INTERACTIVE_DEFAULT_MAX_TURNS,
  APPROACH_TURNS,
  APPROACH_STOP_BLOCKS,
  type GoalConfig,
} from "./goal.js";

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
