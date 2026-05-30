import { describe, test, expect } from "bun:test";
import { getEventListeners } from "node:events";
import { sleepTool } from "./sleep.js";

// Regression: the abort listener was added but never removed, so every Sleep
// call leaked a listener on the shared per-turn signal (review-2026-05-30).

describe("sleepTool abort-listener cleanup", () => {
  test("does not leak abort listeners across normal completions", async () => {
    const ac = new AbortController();
    const before = getEventListeners(ac.signal, "abort").length;
    // Several short sleeps that all complete normally.
    for (let i = 0; i < 5; i++) {
      await sleepTool({ seconds: 0.1, __signal: ac.signal });
    }
    const after = getEventListeners(ac.signal, "abort").length;
    expect(after).toBe(before); // listeners removed on completion
  });

  test("aborts promptly when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await sleepTool({ seconds: 5, __signal: ac.signal })).toBe("Sleep aborted.");
  });

  test("returns the slept message on normal completion", async () => {
    expect(await sleepTool({ seconds: 0.1 })).toContain("Slept for");
  });
});
