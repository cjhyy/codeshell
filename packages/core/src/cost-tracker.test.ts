import { describe, it, expect } from "bun:test";
import { CostTracker } from "./cost-tracker.js";

/**
 * Cost path had zero direct tests. These exercise the full
 * lookupPricing → MODEL_PRICING (now data/model-metadata.json) → dollar-math
 * chain, verifying the Phase-1 pricing extraction produces correct costs.
 *
 * Models chosen are confirmed ABSENT from the bundled OpenRouter snapshot
 * (devstral-medium / mistral-large / claude-opus-4-6 / a fake id), so lookup
 * deterministically falls through to MODEL_PRICING / DEFAULT_PRICING rather
 * than snapshot pricing.
 */
describe("CostTracker cost math (over extracted MODEL_PRICING)", () => {
  it("estimateForTokens uses the data-layer price (devstral-medium = $0.5/$1.5 per 1M)", () => {
    const t = new CostTracker();
    // 1M input + 1M output, no cache → 0.5 + 1.5 = 2.0
    expect(t.estimateForTokens("devstral-medium", 1_000_000, 1_000_000)).toBeCloseTo(2.0, 9);
    // 2M input only → 1.0
    expect(t.estimateForTokens("devstral-medium", 2_000_000, 0)).toBeCloseTo(1.0, 9);
  });

  it("uses DEFAULT_PRICING ($3/$15) for an unknown model and flags it", () => {
    const t = new CostTracker();
    // 1M in + 1M out at default = 3 + 15 = 18
    expect(t.estimateForTokens("totally-made-up-model-zzz", 1_000_000, 1_000_000)).toBeCloseTo(18, 9);
  });

  it("getEstimatedCost subtracts cache tokens from input to avoid double-billing", () => {
    const t = new CostTracker();
    // mistral-large = $2 in / $6 out; cacheRead derived = 2*0.1 = 0.2/1M.
    // record: 1M prompt of which 400k are cacheRead, 600k completion.
    t.record("mistral-large", 1_000_000, 600_000, false, 400_000, 0);
    // uncached input = 1M - 400k = 600k → 0.6*2 = 1.2
    // completion = 600k → 0.6*6 = 3.6
    // cacheRead = 400k → 0.4*0.2 = 0.08
    // total = 1.2 + 3.6 + 0.08 = 4.88
    expect(t.getEstimatedCost()).toBeCloseTo(4.88, 9);
  });

  it("canonicalizes vendor-prefixed + date-suffixed ids to the same price", () => {
    const t = new CostTracker();
    // claude-opus-4-6 → MODEL_PRICING $15/$75. The prefixed + dated forms must
    // canonicalize to the same entry (getCanonicalName strips both).
    const bare = t.estimateForTokens("claude-opus-4-6", 1_000_000, 0);
    const dated = t.estimateForTokens("anthropic/claude-opus-4-6-20250101", 1_000_000, 0);
    expect(bare).toBeCloseTo(15, 9);
    expect(dated).toBeCloseTo(15, 9);
  });

  it("accumulates recorded usage into total tokens and cost", () => {
    const t = new CostTracker();
    t.record("devstral-medium", 1_000_000, 0); // $0.5
    t.record("devstral-medium", 0, 1_000_000); // $1.5
    expect(t.getTotalTokens().total).toBe(2_000_000);
    expect(t.getEstimatedCost()).toBeCloseTo(2.0, 9);
    expect(t.getRequestCount()).toBe(2);
  });
});
