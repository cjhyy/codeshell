import { describe, expect, it } from "bun:test";
import { estimateReceipt } from "./pricing.js";

const identity = {
  provider: "openrouter",
  providerKind: "openrouter",
  model: "openai/gpt-6.1-sol",
};

describe("estimateReceipt", () => {
  it("prices OpenRouter cache reads and writes at their published prices", () => {
    const usage = {
      promptTokens: 100_000,
      completionTokens: 1_000,
      totalTokens: 101_000,
      cacheReadTokens: 80_000,
      cacheCreationTokens: 10_000,
    };
    const receipt = estimateReceipt(identity, usage);
    expect(receipt.pricing).toMatchObject({
      source: "openrouter-snapshot",
      cachePricesEstimated: false,
    });
    const p = receipt.pricing!;
    expect(receipt.estimatedCostUsd).toBeCloseTo(
      (10_000 * p.input + 1_000 * p.output + 80_000 * p.cacheRead + 10_000 * p.cacheWrite) /
        1_000_000,
      12,
    );
  });

  it("uses the long-prompt tier for the whole request once the prompt reaches it", () => {
    const small = estimateReceipt(identity, {
      promptTokens: 200_000,
      completionTokens: 0,
      totalTokens: 200_000,
    });
    const large = estimateReceipt(identity, {
      promptTokens: 300_000,
      completionTokens: 0,
      totalTokens: 300_000,
    });
    expect(large.pricing!.input).toBeGreaterThan(small.pricing!.input);
    expect(large.pricing!.cacheRead).toBeGreaterThan(small.pricing!.cacheRead);
  });
});
