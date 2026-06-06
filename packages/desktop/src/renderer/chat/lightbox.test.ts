import { describe, expect, test } from "bun:test";
import { shouldCloseOnKey, navDeltaForKey, stepIndex } from "./Lightbox";

describe("shouldCloseOnKey", () => {
  test("Escape closes the lightbox", () => {
    expect(shouldCloseOnKey("Escape")).toBe(true);
  });

  test("other keys do not close", () => {
    expect(shouldCloseOnKey("Enter")).toBe(false);
    expect(shouldCloseOnKey("a")).toBe(false);
    expect(shouldCloseOnKey(" ")).toBe(false);
  });
});

describe("navDeltaForKey", () => {
  test("arrow keys map to deltas", () => {
    expect(navDeltaForKey("ArrowLeft")).toBe(-1);
    expect(navDeltaForKey("ArrowRight")).toBe(1);
  });
  test("non-arrow keys are no-ops", () => {
    expect(navDeltaForKey("Escape")).toBe(0);
    expect(navDeltaForKey("a")).toBe(0);
  });
});

describe("stepIndex", () => {
  test("steps forward and back within range", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(1, -1, 3)).toBe(0);
  });
  test("wraps around both ends", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });
  test("single image or empty gallery does not move", () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, -1, 0)).toBe(0);
  });
});
