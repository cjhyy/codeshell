import { describe, expect, test } from "bun:test";
import { formatRelative } from "./Sidebar";

describe("Sidebar relative time", () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0);

  test("uses the selected UI language", () => {
    expect(formatRelative(now - 3 * 60_000, "zh", now)).toContain("3分钟");
    expect(formatRelative(now - 3 * 60_000, "en", now)).toContain("3m");
    expect(formatRelative(now - 3 * 60_000, "en", now)).not.toContain("分");
  });

  test("clamps future timestamps to the present", () => {
    expect(formatRelative(now + 60_000, "en", now)).toBe("now");
  });
});
