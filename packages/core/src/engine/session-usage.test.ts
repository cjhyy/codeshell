import { describe, it, expect } from "bun:test";
import { foldRunUsage } from "./session-usage.js";
import type { TokenUsage } from "../types.js";
import type { LLMUsageTracker } from "../llm/types.js";

const tracker = (
  p: number,
  c: number,
  read = 0,
  creation = 0,
): LLMUsageTracker => ({
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
