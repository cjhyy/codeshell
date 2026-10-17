import { describe, expect, test } from "bun:test";
import { CostTracker } from "../../../packages/core/src/cost-tracker.js";
import { findOpenRouterModel } from "../../../packages/core/src/data/openrouter-models.js";
import { MODEL_PRICING } from "../../../packages/core/src/data/model-metadata.js";
import { UsageLedger } from "../../../packages/core/src/cost-ledger/store.js";
import { checkTokenBudget, createBudgetTracker } from "../../../packages/core/src/engine/token-budget.js";

describe("round9 standalone CostTracker identity characterization", () => {
  const model = "google/gemini-4-argon";
  test("full bundled identity estimates 12 but record loses vendor and totals 18", () => {
    const hit = findOpenRouterModel(model)!;
    expect(hit.inputPricePerMillion).toBe(2);
    expect(hit.outputPricePerMillion).toBe(10);
    expect(MODEL_PRICING["gemini-4-argon"]).toBeUndefined();
    const tracker = new CostTracker();
    expect(tracker.estimateForTokens(model, 1_000_000, 1_000_000)).toBe(12);
    tracker.record(model, 1_000_000, 1_000_000);
    expect(tracker.getEstimatedCost()).toBe(18);
    expect(tracker.serialize().records[0].model).toBe("gemini-4-argon");
    expect(tracker.getTotalTokens()).toEqual({ prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 });
    expect(tracker.formatSummary()).not.toContain("unknown models");
  });
  test("summary and persisted standalone restore retain the erroneous estimate", () => {
    const tracker = new CostTracker();
    tracker.record(model, 1_000_000, 1_000_000);
    expect(tracker.formatCompact()).toContain("cost: $18");
    expect(tracker.formatSummary()).toContain("Total cost:    $18");
    const state = tracker.serialize();
    expect(state.estimatedCost).toBe(18);
    const restored = new CostTracker();
    restored.restore(state);
    expect(restored.getEstimatedCost()).toBe(18);
  });
  test("direct metadata matches its estimate and a bound ledger owns accounting", () => {
    const direct = new CostTracker();
    direct.record("devstral-medium", 1_000_000, 1_000_000);
    expect(direct.getEstimatedCost()).toBe(2);
    expect(direct.getEstimatedCost()).toBe(direct.estimateForTokens("devstral-medium", 1_000_000, 1_000_000));
    const ledger = new UsageLedger();
    const bound = new CostTracker();
    bound.bindLedger(ledger);
    bound.record(model, 1_000_000, 1_000_000);
    expect(bound.getEstimatedCost()).toBe(0);
    expect(bound.getRequestCount()).toBe(0);
    const receipt = ledger.begin(ledger.owner("round9-owned-memory-session"), { provider: "openrouter", model });
    ledger.settle(receipt, { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 });
    ledger.finish(receipt, "completed");
    expect(bound.getEstimatedCost()).toBe(12);
    expect(bound.getRequestCount()).toBe(1);
  });
});

describe("round9 token-budget normal policy controls", () => {
  test("below threshold continues; threshold nudges then stops", () => {
    const tracker = createBudgetTracker();
    expect(checkTokenBudget(899, 1000, tracker)).toBe("continue");
    expect(checkTokenBudget(900, 1000, tracker)).toBe("nudge");
    expect(checkTokenBudget(1000, 1000, tracker)).toBe("stop");
    expect(tracker.continuationCount).toBe(1);
  });
  test("infinite or disabled budgets continue without changing tracker", () => {
    const tracker = createBudgetTracker();
    const initial = { ...tracker };
    expect(checkTokenBudget(10000, Infinity, tracker)).toBe("continue");
    expect(checkTokenBudget(10000, 0, tracker)).toBe("continue");
    expect(tracker).toEqual(initial);
  });
});
