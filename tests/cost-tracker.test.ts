import { describe, it, expect } from "bun:test";
import { CostTracker } from "../src/cli/cost-tracker.js";

describe("CostTracker", () => {
  it("should not double-bill cache tokens", () => {
    const tracker = new CostTracker();

    // Simulate: 10000 prompt tokens, of which 8000 are cache read, 1000 cache write
    // So only 1000 tokens should be billed at the full input rate
    tracker.record("claude-sonnet-4-6", 10000, 500, false, 8000, 1000);

    const cost = tracker.getEstimatedCost();

    // Claude Sonnet 4.6: input=$3/M, output=$15/M, cacheRead=$0.3/M, cacheWrite=$3.75/M
    // Uncached input: (10000 - 8000 - 1000) = 1000 tokens at $3/M = $0.003
    // Output: 500 tokens at $15/M = $0.0075
    // Cache read: 8000 tokens at $0.3/M = $0.0024
    // Cache write: 1000 tokens at $3.75/M = $0.00375
    const expected =
      (1000 / 1_000_000) * 3 +
      (500 / 1_000_000) * 15 +
      (8000 / 1_000_000) * 0.3 +
      (1000 / 1_000_000) * 3.75;

    expect(cost).toBeCloseTo(expected, 10);
  });

  it("estimateForTokens should also subtract cache from input", () => {
    const tracker = new CostTracker();
    const cost = tracker.estimateForTokens("claude-sonnet-4-6", 10000, 500, 8000, 1000);

    const expected =
      (1000 / 1_000_000) * 3 +
      (500 / 1_000_000) * 15 +
      (8000 / 1_000_000) * 0.3 +
      (1000 / 1_000_000) * 3.75;

    expect(cost).toBeCloseTo(expected, 10);
  });

  it("should handle zero cache tokens without error", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", 5000, 1000);
    const cost = tracker.getEstimatedCost();

    // All 5000 prompt tokens at full input price
    const expected =
      (5000 / 1_000_000) * 3 +
      (1000 / 1_000_000) * 15;

    expect(cost).toBeCloseTo(expected, 10);
  });

  it("should clamp uncached input to zero if cache exceeds prompt", () => {
    const tracker = new CostTracker();
    // Edge case: cache tokens reported larger than prompt (shouldn't happen, but be safe)
    tracker.record("claude-sonnet-4-6", 5000, 500, false, 4000, 3000);

    const cost = tracker.getEstimatedCost();
    // uncachedInput = max(0, 5000 - 4000 - 3000) = 0
    const expected =
      (0 / 1_000_000) * 3 +
      (500 / 1_000_000) * 15 +
      (4000 / 1_000_000) * 0.3 +
      (3000 / 1_000_000) * 3.75;

    expect(cost).toBeCloseTo(expected, 10);
  });
});
