import { describe, test, expect } from "bun:test";
import { sanitizeWindowState } from "./window-state-store.js";

// Regression: loadWindowState spread the parsed file over DEFAULT with no
// validation, so a corrupt window.json (NaN/negative/wrong-typed dims) flowed
// straight into BrowserWindow (review-2026-05-30).

describe("sanitizeWindowState", () => {
  test("keeps valid values", () => {
    expect(sanitizeWindowState({ width: 1000, height: 700, x: 10, y: 20, maximized: true })).toEqual({
      width: 1000,
      height: 700,
      x: 10,
      y: 20,
      maximized: true,
    });
  });

  test("falls back to defaults for non-numeric / NaN / out-of-range dims", () => {
    expect(sanitizeWindowState({ width: "big", height: NaN })).toEqual({ width: 1180, height: 800 });
    expect(sanitizeWindowState({ width: -5, height: 999999 })).toEqual({ width: 1180, height: 800 });
  });

  test("drops invalid optional fields", () => {
    const s = sanitizeWindowState({ width: 1000, height: 700, x: "left", maximized: "yes" });
    expect(s).toEqual({ width: 1000, height: 700 });
  });

  test("handles non-object input", () => {
    expect(sanitizeWindowState(null)).toEqual({ width: 1180, height: 800 });
    expect(sanitizeWindowState("garbage")).toEqual({ width: 1180, height: 800 });
  });
});
