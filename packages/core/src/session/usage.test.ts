import { describe, it, expect } from "bun:test";
import {
  addCumulativeUsage,
  addTokenUsage,
  cacheHitRateFromUsage,
  cumulativeCacheHitRate,
  foldRunUsage,
  normalizeCumulativeUsageCounters,
} from "./usage.js";
import type { TokenUsage } from "../types.js";
import type { LLMUsageTracker } from "../llm/types.js";

const tracker = (p: number, c: number, read = 0, creation = 0): LLMUsageTracker => ({
  records: [],
  totalPromptTokens: p,
  totalCompletionTokens: c,
  totalTokens: p + c,
  totalCacheReadTokens: read,
  totalCacheCreationTokens: creation,
  requestCount: 1,
});

describe("foldRunUsage", () => {
  it("adds the current run's usage onto the session baseline", () => {
    const baseline: TokenUsage = {
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 60,
      cacheCreationTokens: 20,
    };
    const folded = foldRunUsage(baseline, tracker(50, 10, 30, 5));
    expect(folded.promptTokens).toBe(150);
    expect(folded.completionTokens).toBe(50);
    expect(folded.totalTokens).toBe(200); // baseline 140 + run total 60
    expect(folded.cacheReadTokens).toBe(90);
    expect(folded.cacheCreationTokens).toBe(25);
  });

  it("is idempotent per boundary: same baseline + same run total = same result", () => {
    // Turn-boundary fires many times in one run, each reading the run's running
    // total. baseline+current must NOT double-count — calling twice with the
    // same (baseline, runUsage) yields the same folded value, never 2×.
    const baseline: TokenUsage = {
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 60,
      cacheCreationTokens: 20,
    };
    const run = tracker(50, 10, 30, 5);
    const first = foldRunUsage(baseline, run);
    const second = foldRunUsage(baseline, run);
    expect(second).toEqual(first);
    expect(second.promptTokens).toBe(150); // not 200
  });

  it("treats a fresh session (undefined cache baseline) as zero", () => {
    const baseline: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const folded = foldRunUsage(baseline, tracker(50, 10, 30, 5));
    expect(folded.cacheReadTokens).toBe(30);
    expect(folded.cacheCreationTokens).toBe(5);
    expect(folded.promptTokens).toBe(50);
  });

  it("accumulates across runs when the folded result is fed back as the next baseline", () => {
    let acc: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    acc = foldRunUsage(acc, tracker(50, 10, 30, 5)); // run 1
    acc = foldRunUsage(acc, tracker(80, 20, 40, 0)); // run 2 (new client, from 0)
    expect(acc.promptTokens).toBe(130);
    expect(acc.cacheReadTokens).toBe(70);
    expect(acc.cacheCreationTokens).toBe(5);
  });
});

describe("cumulative prompt-cache usage", () => {
  it("monotonically adds prompt/cache counters across recorded usages", () => {
    let counters = normalizeCumulativeUsageCounters(undefined);

    counters = addCumulativeUsage(counters, {
      promptTokens: 1000,
      completionTokens: 20,
      totalTokens: 1020,
      cacheReadTokens: 800,
      cacheCreationTokens: 50,
    });
    counters = addCumulativeUsage(counters, {
      promptTokens: 500,
      completionTokens: 10,
      totalTokens: 510,
      cacheReadTokens: 250,
      cacheCreationTokens: 25,
    });

    expect(counters.cumulativePromptTokens).toBe(1500);
    expect(counters.cumulativeCacheReadTokens).toBe(1050);
    expect(counters.cumulativeCacheCreationTokens).toBe(75);
    expect(cumulativeCacheHitRate(counters)).toBeCloseTo(0.7, 5);
  });

  it("does not reset when the legacy turn/run accumulator is reset", () => {
    let counters = addCumulativeUsage(undefined, {
      promptTokens: 1000,
      completionTokens: 20,
      totalTokens: 1020,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    });

    // Simulate the old resettable accounting window being zeroed at a boundary.
    const legacyWindow: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    counters = addCumulativeUsage(counters, {
      promptTokens: 400,
      completionTokens: 8,
      totalTokens: 408,
      cacheReadTokens: 200,
      cacheCreationTokens: 0,
    });

    expect(legacyWindow.promptTokens).toBe(0);
    expect(counters.cumulativePromptTokens).toBe(1400);
    expect(counters.cumulativeCacheReadTokens).toBe(900);
    expect(counters.cumulativeCacheCreationTokens).toBe(100);
  });
});

describe("single-turn prompt-cache usage", () => {
  it("reflects only the current turn after the turn accumulator resets", () => {
    let currentTurn: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    currentTurn = addTokenUsage(currentTurn, {
      promptTokens: 1000,
      completionTokens: 20,
      totalTokens: 1020,
      cacheReadTokens: 800,
      cacheCreationTokens: 50,
    });
    expect(cacheHitRateFromUsage(currentTurn)).toBeCloseTo(0.8, 5);

    currentTurn = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    currentTurn = addTokenUsage(currentTurn, {
      promptTokens: 500,
      completionTokens: 10,
      totalTokens: 510,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
    });

    expect(currentTurn.promptTokens).toBe(500);
    expect(currentTurn.cacheReadTokens).toBe(100);
    expect(cacheHitRateFromUsage(currentTurn)).toBeCloseTo(0.2, 5);
  });
});
