import { describe, expect, test } from "bun:test";
import {
  isCronExpression,
  nextCronTime,
  parseCronExpression,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/automation/cron-expr.ts";

describe("round23 actual cron expression short ordinary controls", () => {
  test("unions duplicate and overlapping supported list/range parts", () => {
    const parsed = parseCronExpression("1,1,1-3,2-4/2 0 * * *");
    expect([...parsed.minutes].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect([...parsed.hours]).toEqual([0]);
    expect(parsed.domRestricted).toBe(false);
    expect(parsed.dowRestricted).toBe(false);
  });

  test("recognizes ordinary field whitespace and combines lists with stepped ranges", () => {
    const expression = "  5-15/5\t9,12  * * *  ";
    expect(isCronExpression(expression)).toBe(true);
    const parsed = parseCronExpression(expression);
    expect([...parsed.minutes]).toEqual([5, 10, 15]);
    expect([...parsed.hours]).toEqual([9, 12]);
  });

  test("rounds a sub-minute UTC reference to the next whole minute", () => {
    const from = Date.UTC(2026, 9, 17, 12, 34, 45, 123);
    expect(nextCronTime(parseCronExpression("* * * * *"), "UTC", from)).toBe(
      Date.UTC(2026, 9, 17, 12, 35),
    );
  });

  test("finds the next minute in a supported combined minute list", () => {
    const parsed = parseCronExpression("1,3-5/2 * * * *");
    expect([...parsed.minutes]).toEqual([1, 3, 5]);
    expect(nextCronTime(parsed, "UTC", Date.UTC(2026, 9, 17, 12, 1))).toBe(
      Date.UTC(2026, 9, 17, 12, 3),
    );
  });

  test("finds midnight across a UTC day boundary in the next minute", () => {
    const from = Date.UTC(2026, 9, 17, 23, 59, 59, 999);
    expect(nextCronTime(parseCronExpression("0 0 * * *"), "UTC", from)).toBe(
      Date.UTC(2026, 9, 18),
    );
  });

  test("finds a January first trigger immediately across the UTC year boundary", () => {
    const from = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    expect(nextCronTime(parseCronExpression("0 0 1 1 *"), "UTC", from)).toBe(
      Date.UTC(2027, 0, 1),
    );
  });

  test("keeps explicit full day ranges restricted even though the sets equal wildcards", () => {
    const explicit = parseCronExpression("* * 1-31 * 0-6");
    const wildcards = parseCronExpression("* * * * *");
    expect(explicit.domRestricted).toBe(true);
    expect(explicit.dowRestricted).toBe(true);
    expect(wildcards.domRestricted).toBe(false);
    expect(wildcards.dowRestricted).toBe(false);
    expect(explicit.daysOfMonth).toEqual(wildcards.daysOfMonth);
    expect(explicit.daysOfWeek).toEqual(wildcards.daysOfWeek);
    expect(nextCronTime(explicit, "UTC", Date.UTC(2026, 9, 17))).toBe(
      Date.UTC(2026, 9, 17, 0, 1),
    );
  });
});
