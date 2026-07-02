import { describe, it, expect } from "bun:test";
import { LLMClientBase } from "./client-base.js";
import type { LLMConfig, LLMResponse, TokenUsage } from "../types.js";

// The usage tracker must accumulate cache-read / cache-creation tokens across
// LLM responses (once per real response), so a session-level cumulative cache
// hit rate can be computed. Prior to this it only summed prompt/completion/total.

class TestClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(): Promise<LLMResponse> {
    throw new Error("unused");
  }
  record(usage: TokenUsage): void {
    this.recordUsage(usage);
  }
  reset(): void {
    this.resetUsage();
  }
}

function makeClient(): TestClient {
  const config = { provider: "openai", model: "m", apiKey: "x", baseUrl: "http://localhost" } as LLMConfig;
  return new TestClient(config);
}

const u = (p: number, c: number, read?: number, creation?: number): TokenUsage => ({
  promptTokens: p,
  completionTokens: c,
  totalTokens: p + c,
  ...(read !== undefined ? { cacheReadTokens: read } : {}),
  ...(creation !== undefined ? { cacheCreationTokens: creation } : {}),
});

describe("LLMUsageTracker cache accumulation", () => {
  it("sums cacheReadTokens / cacheCreationTokens across responses", () => {
    const c = makeClient();
    c.record(u(100, 10, 60, 20));
    c.record(u(200, 30, 150, 5));
    const usage = c.getUsage();
    expect(usage.totalCacheReadTokens).toBe(210);
    expect(usage.totalCacheCreationTokens).toBe(25);
    // existing totals still accumulate
    expect(usage.totalPromptTokens).toBe(300);
    expect(usage.requestCount).toBe(2);
  });

  it("treats missing cache fields as zero (provider with no cache info)", () => {
    const c = makeClient();
    c.record(u(100, 10, 60, 20));
    c.record(u(50, 5)); // no cache fields
    const usage = c.getUsage();
    expect(usage.totalCacheReadTokens).toBe(60);
    expect(usage.totalCacheCreationTokens).toBe(20);
  });

  it("starts cache totals at zero", () => {
    const usage = makeClient().getUsage();
    expect(usage.totalCacheReadTokens).toBe(0);
    expect(usage.totalCacheCreationTokens).toBe(0);
  });

  it("resetUsage clears all totals including cache", () => {
    const c = makeClient();
    c.record(u(100, 10, 60, 20));
    c.reset();
    const usage = c.getUsage();
    expect(usage.totalCacheReadTokens).toBe(0);
    expect(usage.totalCacheCreationTokens).toBe(0);
    expect(usage.totalPromptTokens).toBe(0);
    expect(usage.requestCount).toBe(0);
    expect(usage.records).toEqual([]);
  });
});
