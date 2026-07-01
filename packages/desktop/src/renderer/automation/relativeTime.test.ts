import { describe, test, expect } from "bun:test";
import { fmtRelative } from "./relativeTime";

// Fake t: echoes "key|n=<n>" so we can assert which key + param were chosen.
const t = ((k: string, o?: Record<string, unknown>) => `${k}|${o ? JSON.stringify(o) : ""}`) as never;

describe("fmtRelative", () => {
  const now = 1_000_000_000_000;
  test("null → dash", () => {
    expect(fmtRelative(null, t, now)).toBe("—");
  });
  test("future within an hour → inMinutes with n", () => {
    const s = fmtRelative(now + 10 * 60_000, t, now);
    expect(s).toContain("auto.rel.inMinutes");
    expect(s).toContain("10");
  });
  test("future hours → inHours", () => {
    expect(fmtRelative(now + 3 * 3_600_000, t, now)).toContain("auto.rel.inHours");
  });
  test("past hours → hoursAgo", () => {
    expect(fmtRelative(now - 2 * 3_600_000, t, now)).toContain("auto.rel.hoursAgo");
  });
  test("future days → inDays", () => {
    expect(fmtRelative(now + 2 * 86_400_000, t, now)).toContain("auto.rel.inDays");
  });
  test("under a minute → now", () => {
    expect(fmtRelative(now + 5_000, t, now)).toContain("auto.rel.now");
  });
});
