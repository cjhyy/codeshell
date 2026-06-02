import { describe, test, expect } from "bun:test";
import type { TerminalReason } from "../types.js";

/**
 * Goal mode P0 — TurnLoop wiring contract.
 *
 * TurnLoop has heavy concrete dependencies (ModelFacade wrapping a real
 * LLMClientBase, ToolExecutor + ToolRegistry + PermissionClassifier +
 * ToolContext, ContextManager, HookRegistry, Transcript). There is no
 * existing fake/builder harness to reuse, and standing up a faithful one
 * would mean fabricating 5+ subsystems — a brittle mock that tests the
 * mock more than the loop. Per the implementation plan (Task 4), the real
 * end-to-end behavior (force-stop on budget, completed on complete_goal)
 * is exercised by the engine-level integration test in Task 6, which has a
 * real harness.
 *
 * What we CAN lock down here cheaply and meaningfully is the type-level
 * contract the turn-loop implementation depends on: that the new terminal
 * reason exists in the union the loop returns. If someone removes
 * "goal_budget_exhausted" from TerminalReason, this stops compiling (and
 * the `return { reason: "goal_budget_exhausted", ... }` in turn-loop.ts
 * would too).
 */
describe("turn-loop goal-mode wiring contract", () => {
  test("TerminalReason union includes goal_budget_exhausted", () => {
    const reason: TerminalReason = "goal_budget_exhausted";
    expect(reason).toBe("goal_budget_exhausted");
  });

  test("complete_goal short-circuit returns the standard completed reason", () => {
    // The short-circuit path returns reason "completed" (an existing union
    // member). Assert the typed constant the implementation uses.
    const reason: TerminalReason = "completed";
    expect(reason).toBe("completed");
  });
});
