import { describe, test, expect } from "bun:test";
import {
  normalizeGoal,
  createGoalBudgetTracker,
  recordGoalUsage,
  goalBudgetExceeded,
  type GoalConfig,
} from "./goal.js";

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
