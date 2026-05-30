import { describe, test, expect } from "bun:test";
import { formatDuration } from "./format.js";

// Regression: for ms in [1, 1000) the function fell through to
// Math.floor(ms/1000)="0" → "0s" (review-2026-05-30). Sub-second non-zero
// durations should show a decimal second.

describe("formatDuration sub-second handling", () => {
  test("exactly 0 → 0s", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  test("500ms → 0.5s (was wrongly 0s)", () => {
    expect(formatDuration(500)).toBe("0.5s");
  });

  test("1ms → 0.0s, not 0s", () => {
    expect(formatDuration(1)).toBe("0.0s");
  });

  test("999ms → 1.0s", () => {
    expect(formatDuration(999)).toBe("1.0s");
  });

  test("1000ms → 1s (whole second, no decimal)", () => {
    expect(formatDuration(1000)).toBe("1s");
  });

  test("1500ms → 1s (floored whole second)", () => {
    expect(formatDuration(1500)).toBe("1s");
  });
});
