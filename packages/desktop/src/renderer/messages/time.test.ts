import { describe, expect, test } from "bun:test";
import { formatClockTime, formatMessageTime } from "./time";

describe("formatClockTime", () => {
  test("returns null for absent / non-finite timestamps", () => {
    expect(formatClockTime(undefined)).toBeNull();
    expect(formatClockTime(NaN)).toBeNull();
  });
  test("formats a finite epoch ms to HH:MM", () => {
    // 2026-06-03T14:32:00 local — exact string is locale-dependent, so just
    // assert it produced a non-empty clock-ish string.
    const out = formatClockTime(new Date(2026, 5, 3, 14, 32).getTime());
    expect(out).toBeTruthy();
    expect(out).toMatch(/\d/);
  });
});

describe("formatMessageTime", () => {
  // Reference "now": Wednesday 2026-06-03 12:00 local.
  const now = new Date(2026, 5, 3, 12, 0, 0).getTime();

  test("returns null for absent timestamps", () => {
    expect(formatMessageTime(undefined, now)).toBeNull();
    expect(formatMessageTime(NaN, now)).toBeNull();
  });

  test("today → clock time only (no date/weekday prefix)", () => {
    const t = new Date(2026, 5, 3, 9, 15).getTime();
    const out = formatMessageTime(t, now)!;
    expect(out).not.toContain("昨天");
    expect(out).not.toContain("星期");
    expect(out).not.toContain("/");
  });

  test("yesterday → 昨天 + time", () => {
    const t = new Date(2026, 5, 2, 22, 5).getTime();
    const out = formatMessageTime(t, now)!;
    expect(out).toContain("昨天");
  });

  test("earlier this week (but not yesterday) → weekday + time", () => {
    // Monday of the same week (now is Wed). Older than yesterday (Tue).
    const t = new Date(2026, 5, 1, 8, 0).getTime();
    const out = formatMessageTime(t, now)!;
    expect(out).toContain("星期");
    expect(out).not.toContain("昨天");
    expect(out).not.toContain("/");
  });

  test("older than this week → full date + time", () => {
    const t = new Date(2026, 4, 20, 8, 0).getTime();
    const out = formatMessageTime(t, now)!;
    expect(out).toContain("/");
    expect(out).not.toContain("星期");
    expect(out).not.toContain("昨天");
  });

  test("future-ish same-day still treated as today", () => {
    const t = new Date(2026, 5, 3, 18, 0).getTime();
    const out = formatMessageTime(t, now)!;
    expect(out).not.toContain("昨天");
    expect(out).not.toContain("星期");
  });
});
