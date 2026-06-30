import { describe, it, expect } from "bun:test";
import { cacheHitRate } from "./model-facade.js";

/**
 * cacheHitRate visibility helper (docs/todo/prompt-cache-optimization.md §四 step 1).
 * Hit rate = cacheRead / (cacheRead + cacheCreation + uncachedInput).
 */
describe("cacheHitRate", () => {
  it("returns undefined when there is no usage", () => {
    expect(cacheHitRate(undefined)).toBeUndefined();
  });

  it("returns undefined when no cache tokens were reported (cold provider)", () => {
    expect(cacheHitRate({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050 })).toBeUndefined();
  });

  it("computes the fraction of input served from cache", () => {
    // promptTokens (1000) already includes the 800 cached → 200 uncached input.
    const r = cacheHitRate({
      promptTokens: 1000,
      completionTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 800,
    });
    expect(r).toBeCloseTo(0.8, 5);
  });

  it("counts cache-creation tokens as non-hit input in the denominator", () => {
    // First-ever request: 1000 prompt, all written to cache, zero read.
    const r = cacheHitRate({
      promptTokens: 1000,
      completionTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 0,
      cacheCreationTokens: 1000,
    });
    expect(r).toBe(0);
  });

  it("handles a fully-cached prompt as 1.0", () => {
    const r = cacheHitRate({
      promptTokens: 500,
      completionTokens: 10,
      totalTokens: 510,
      cacheReadTokens: 500,
    });
    expect(r).toBeCloseTo(1.0, 5);
  });
});
