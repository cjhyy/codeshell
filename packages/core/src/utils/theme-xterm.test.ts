import { describe, test, expect } from "bun:test";
import { rgbToXterm256 } from "./theme.js";

// Regression: the grayscale ramp used (r-8)/247*24, but the xterm-256 ramp is
// 24 steps (idx 232-255) over RGB [8,248] = 240 units → (r-8)/240*23
// (review-2026-05-30). The old formula produced off-by-one indices.

describe("rgbToXterm256 grayscale ramp", () => {
  test("ramp endpoints map correctly", () => {
    expect(rgbToXterm256(8, 8, 8)).toBe(232); // start of ramp
    expect(rgbToXterm256(248, 248, 248)).toBe(255); // end of ramp
  });

  test("the documented off-by-one cases are fixed", () => {
    // Finding: r=148 and r=168 mapped to 246/249 (wrong) instead of 245/247.
    expect(rgbToXterm256(148, 148, 148)).toBe(245);
    expect(rgbToXterm256(168, 168, 168)).toBe(247);
  });

  test("indices stay within the grayscale band 232..255", () => {
    for (let v = 8; v <= 248; v += 4) {
      const idx = rgbToXterm256(v, v, v);
      expect(idx).toBeGreaterThanOrEqual(232);
      expect(idx).toBeLessThanOrEqual(255);
    }
  });
});
