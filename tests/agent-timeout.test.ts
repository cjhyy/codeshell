import { describe, it, expect } from "bun:test";
import { runWithTimeout, DEFAULT_SUBAGENT_TIMEOUT_MS } from "../packages/core/src/tool-system/builtin/agent.ts";

describe("runWithTimeout", () => {
  it("exposes a positive default timeout", () => {
    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("resolves with the value when work finishes in time", async () => {
    const out = await runWithTimeout(() => Promise.resolve("done"), 1000, () => {});
    expect(out).toBe("done");
  });

  it("aborts and throws a timeout error when work exceeds the limit", async () => {
    let aborted = false;
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    await expect(runWithTimeout(slow, 20, () => { aborted = true; })).rejects.toThrow(/timed out/i);
    expect(aborted).toBe(true);
  });
});
