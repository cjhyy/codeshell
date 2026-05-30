import { describe, test, expect } from "bun:test";
import { dayStamp, logPathForDay } from "./desktop-logger.js";

// Regression: logPath() cached the path once and never recomputed, so a
// long-running desktop process kept writing to the start-day's file after
// midnight (review-2026-05-30). The path is now derived from a per-call day
// stamp; these helpers pin that derivation.

describe("desktop log path is day-derived", () => {
  test("dayStamp formats YYYY-MM-DD with zero padding", () => {
    expect(dayStamp(new Date(2026, 0, 5))).toBe("2026-01-05"); // Jan 5
    expect(dayStamp(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  test("different days map to different log files", () => {
    const a = logPathForDay(dayStamp(new Date(2026, 4, 30)));
    const b = logPathForDay(dayStamp(new Date(2026, 4, 31)));
    expect(a).not.toBe(b);
    expect(a).toContain("desktop-2026-05-30.log");
    expect(b).toContain("desktop-2026-05-31.log");
  });
});
