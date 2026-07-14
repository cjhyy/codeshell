import { describe, test, expect } from "bun:test";
import { parseCronExpression, nextCronTime, isCronExpression } from "./cron-expr.js";

describe("isCronExpression", () => {
  test("recognizes 5-field cron expressions", () => {
    expect(isCronExpression("0 9 * * 1-5")).toBe(true);
    expect(isCronExpression("*/15 * * * *")).toBe(true);
    expect(isCronExpression("0 0 1 1 *")).toBe(true);
  });
  test("rejects interval strings and garbage", () => {
    expect(isCronExpression("5m")).toBe(false);
    expect(isCronExpression("1500")).toBe(false);
    expect(isCronExpression("0 9 * *")).toBe(false); // only 4 fields
    expect(isCronExpression("")).toBe(false);
  });
});

describe("parseCronExpression — field parsing", () => {
  test("parses wildcards", () => {
    const c = parseCronExpression("* * * * *");
    expect(c.minutes.has(0)).toBe(true);
    expect(c.minutes.size).toBe(60);
    expect(c.hours.size).toBe(24);
  });
  test("parses a single value", () => {
    const c = parseCronExpression("0 9 * * *");
    expect([...c.minutes]).toEqual([0]);
    expect([...c.hours]).toEqual([9]);
  });
  test("parses ranges", () => {
    const c = parseCronExpression("0 9 * * 1-5");
    expect([...c.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
  test("parses lists", () => {
    const c = parseCronExpression("0 9,12,18 * * *");
    expect([...c.hours].sort((a, b) => a - b)).toEqual([9, 12, 18]);
  });
  test("parses step values", () => {
    const c = parseCronExpression("*/15 * * * *");
    expect([...c.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });
  test("parses range with step", () => {
    const c = parseCronExpression("0 0-12/3 * * *");
    expect([...c.hours].sort((a, b) => a - b)).toEqual([0, 3, 6, 9, 12]);
  });
  test("throws on invalid field count", () => {
    expect(() => parseCronExpression("0 9 * *")).toThrow(/cron/i);
  });
  test("throws on out-of-range values", () => {
    expect(() => parseCronExpression("99 9 * * *")).toThrow();
    expect(() => parseCronExpression("0 25 * * *")).toThrow();
  });
});

describe("nextCronTime — timezone-aware next trigger", () => {
  // Use a fixed reference instant: 2026-01-01T00:00:00Z (Thursday).
  const ref = Date.UTC(2026, 0, 1, 0, 0, 0); // ms

  test("daily 09:00 in UTC from midnight UTC → same day 09:00 UTC", () => {
    const next = nextCronTime(parseCronExpression("0 9 * * *"), "UTC", ref);
    expect(next).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });

  test("daily 09:00 Asia/Shanghai (UTC+8) → 01:00 UTC same day", () => {
    // 09:00 in +08:00 == 01:00 UTC.
    const next = nextCronTime(parseCronExpression("0 9 * * *"), "Asia/Shanghai", ref);
    expect(next).toBe(Date.UTC(2026, 0, 1, 1, 0, 0));
  });

  test("if the matching time today already passed, rolls to next day", () => {
    // ref = 2026-01-01 10:00 UTC; 09:00 already passed → next is Jan 2 09:00.
    const r = Date.UTC(2026, 0, 1, 10, 0, 0);
    const next = nextCronTime(parseCronExpression("0 9 * * *"), "UTC", r);
    expect(next).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  test("weekday-only (Mon-Fri) skips the weekend", () => {
    // 2026-01-01 is Thursday. 0 9 * * 1-5 from Fri 10:00 → next is Mon Jan 5 09:00.
    const friday10 = Date.UTC(2026, 0, 2, 10, 0, 0); // Fri after 09:00
    const next = nextCronTime(parseCronExpression("0 9 * * 1-5"), "UTC", friday10);
    // Jan 3 = Sat, Jan 4 = Sun, Jan 5 = Mon.
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
  });

  test("returns a strictly future time (never the reference instant itself)", () => {
    const exactly9 = Date.UTC(2026, 0, 1, 9, 0, 0);
    const next = nextCronTime(parseCronExpression("0 9 * * *"), "UTC", exactly9);
    expect(next).toBeGreaterThan(exactly9);
  });
});

describe("nextCronTime — DST and calendar boundaries", () => {
  test("skips a nonexistent spring-forward wall-clock minute", () => {
    // America/New_York jumps from 01:59 EST to 03:00 EDT on 2026-03-08,
    // so that day's 02:30 does not exist. The next match is March 9.
    const beforeGap = Date.UTC(2026, 2, 8, 5, 0, 0); // Mar 8 00:00 EST
    const next = nextCronTime(parseCronExpression("30 2 * * *"), "America/New_York", beforeGap);
    expect(next).toBe(Date.UTC(2026, 2, 9, 6, 30, 0)); // Mar 9 02:30 EDT
  });

  test("returns the second repeated wall-clock minute after fall-back", () => {
    // 01:30 occurs twice on 2026-11-01. Starting at the first occurrence must
    // return the second occurrence rather than skipping to the next day.
    const firstOneThirty = Date.UTC(2026, 10, 1, 5, 30, 0); // 01:30 EDT
    const next = nextCronTime(
      parseCronExpression("30 1 * * *"),
      "America/New_York",
      firstOneThirty,
    );
    expect(next).toBe(Date.UTC(2026, 10, 1, 6, 30, 0)); // 01:30 EST
  });

  test("finds February 29 across a non-leap year boundary", () => {
    const march2027 = Date.UTC(2027, 2, 1, 0, 0, 0);
    const next = nextCronTime(parseCronExpression("0 0 29 2 *"), "UTC", march2027);
    expect(next).toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
  });
});

describe("dayOfMonth + dayOfWeek — Vixie/POSIX OR semantics", () => {
  // 2026-01: Jan 1 is a Thursday; the first Monday is Jan 5; Jan 15 is a Thursday.
  const refJan1 = Date.UTC(2026, 0, 1, 0, 0, 0);

  test("both restricted → fires on EITHER the day-of-month OR the day-of-week (Monday comes first)", () => {
    // "0 9 15 * 1" = 09:00 on the 15th OR on any Monday. From Jan 1, the first
    // Monday (Jan 5) must win — NOT "the 15th that is also a Monday" (the old
    // AND bug would skip Jan 5 and Jan 15 entirely).
    const next = nextCronTime(parseCronExpression("0 9 15 * 1"), "UTC", refJan1);
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 0, 0)); // Mon Jan 5
  });

  test("both restricted → fires on the 15th when it precedes the next matching weekday", () => {
    // Reference just after Mon Jan 5: next match is the 15th (Thu), which beats
    // the following Monday (Jan 12 is earlier though) — so pick a ref after Jan 12.
    const afterJan12 = Date.UTC(2026, 0, 13, 0, 0, 0);
    const next = nextCronTime(parseCronExpression("0 9 15 * 1"), "UTC", afterJan12);
    expect(next).toBe(Date.UTC(2026, 0, 15, 9, 0, 0)); // the 15th (OR branch)
  });

  test("only day-of-month restricted (dow=*) → dow is ignored", () => {
    const next = nextCronTime(parseCronExpression("0 9 15 * *"), "UTC", refJan1);
    expect(next).toBe(Date.UTC(2026, 0, 15, 9, 0, 0));
  });

  test("only day-of-week restricted (dom=*) → dom is ignored", () => {
    const next = nextCronTime(parseCronExpression("0 9 * * 1"), "UTC", refJan1);
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 0, 0)); // first Monday
  });

  test("parser records which day fields are restricted", () => {
    const both = parseCronExpression("0 9 15 * 1");
    expect(both.domRestricted).toBe(true);
    expect(both.dowRestricted).toBe(true);
    const neither = parseCronExpression("0 9 * * *");
    expect(neither.domRestricted).toBe(false);
    expect(neither.dowRestricted).toBe(false);
  });
});
