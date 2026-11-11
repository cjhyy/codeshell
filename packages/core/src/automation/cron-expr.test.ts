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
  test("throws on extra range or step separators instead of truncating them", () => {
    expect(() => parseCronExpression("0-1-59 9 * * *")).toThrow(/cron/i);
    expect(() => parseCronExpression("*/5/0 9 * * *")).toThrow(/cron/i);
    expect(() => parseCronExpression("0 1-2/3/4 * * *")).toThrow(/cron/i);
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

  test("a wall-clock minute repeated by fall-back fires once, at its first occurrence", () => {
    // 01:30 occurs twice on 2026-11-01 (EDT, then EST).
    const cron = parseCronExpression("30 1 * * *");
    const before = Date.UTC(2026, 10, 1, 4, 0, 0); // 00:00 EDT
    expect(nextCronTime(cron, "America/New_York", before)).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
    // From the first 01:30 the repeat is skipped: next is Nov 2 01:30 EST.
    const firstOneThirty = Date.UTC(2026, 10, 1, 5, 30, 0);
    expect(nextCronTime(cron, "America/New_York", firstOneThirty)).toBe(
      Date.UTC(2026, 10, 2, 6, 30, 0),
    );
  });

  test("an hourly cron fires once per wall-clock hour across fall-back", () => {
    const cron = parseCronExpression("0 * * * *");
    let at = Date.UTC(2026, 10, 1, 3, 30, 0); // Nov 1 23:30 EDT (Oct 31)
    const fired: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      at = nextCronTime(cron, "America/New_York", at)!;
      fired.push(at);
    }
    // 00:00 EDT, 01:00 EDT, then (01:00 EST is a repeat) 02:00 EST, 03:00 EST.
    expect(fired).toEqual([
      Date.UTC(2026, 10, 1, 4),
      Date.UTC(2026, 10, 1, 5),
      Date.UTC(2026, 10, 1, 7),
      Date.UTC(2026, 10, 1, 8),
    ]);
  });

  test("finds sparse but valid dates years away, quickly", () => {
    const from = Date.UTC(2097, 0, 1);
    const started = performance.now();
    // 2100 is not a leap year: the next Feb 29 after 2096 is in 2104.
    expect(nextCronTime(parseCronExpression("0 9 29 2 *"), "UTC", from)).toBe(
      Date.UTC(2104, 1, 29, 9),
    );
    expect(nextCronTime(parseCronExpression("0 9 30 2 *"), "UTC", from)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
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

/**
 * Reference implementation: the original minute-by-minute scan, plus the
 * fall-back rule (a repeated wall-clock minute fires only the first time).
 */
function bruteNext(
  expr: string,
  timeZone: string,
  fromMs: number,
  maxMinutes: number,
): number | null {
  const cron = parseCronExpression(expr);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wall = (ms: number) => {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const hour = parseInt(get("hour"), 10) % 24;
    return {
      key: `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`,
      minute: parseInt(get("minute"), 10),
      hour,
      day: parseInt(get("day"), 10),
      month: parseInt(get("month"), 10),
      dow: days[get("weekday")] ?? 0,
    };
  };
  let candidate = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < maxMinutes; i += 1, candidate += 60_000) {
    const w = wall(candidate);
    if (!cron.minutes.has(w.minute) || !cron.hours.has(w.hour) || !cron.months.has(w.month))
      continue;
    const dom = cron.daysOfMonth.has(w.day);
    const dow = cron.daysOfWeek.has(w.dow);
    const day =
      cron.domRestricted && cron.dowRestricted
        ? dom || dow
        : cron.domRestricted
          ? dom
          : cron.dowRestricted
            ? dow
            : true;
    if (!day) continue;
    if ([30, 60].some((back) => wall(candidate - back * 60_000).key === w.key)) continue;
    return candidate;
  }
  return null;
}

describe("nextCronTime — matches the brute-force scan", () => {
  /** Deterministic PRNG so failures reproduce. */
  function prng(seed: number) {
    return () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
  }
  const zones: Record<string, number[]> = {
    // Instants a few hours before 2026 transitions (and an ordinary day).
    "America/New_York": [Date.UTC(2026, 2, 8, 3), Date.UTC(2026, 10, 1, 3), Date.UTC(2026, 5, 10)],
    "Europe/London": [
      Date.UTC(2026, 2, 29, 0),
      Date.UTC(2026, 9, 25, 0),
      Date.UTC(2026, 0, 31, 22),
    ],
    "Australia/Lord_Howe": [
      Date.UTC(2026, 3, 4, 13),
      Date.UTC(2026, 9, 3, 14),
      Date.UTC(2026, 6, 1),
    ],
    "Asia/Kathmandu": [Date.UTC(2026, 1, 27, 18), Date.UTC(2026, 11, 31, 17)],
  };
  const pick = (random: () => number, options: string[]) =>
    options[Math.floor(random() * options.length)]!;

  for (const [zone, starts] of Object.entries(zones)) {
    test(`agrees in ${zone}`, () => {
      const random = prng(zone.length * 7_919);
      let compared = 0;
      for (let i = 0; i < 90; i += 1) {
        const expr = [
          pick(random, ["0", "30", "15", "45", "*/20", "0,30", "59", "*"]),
          pick(random, ["*", "0", "1", "2", "3", "1-3", "*/6", "23", "0,12"]),
          pick(random, ["*", "*", "*", "1", "15-20", "28-31", "29"]),
          pick(random, ["*", "*", "*", "3,4", "10-12", "2"]),
          pick(random, ["*", "*", "1-5", "0", "6"]),
        ].join(" ");
        const from =
          starts[Math.floor(random() * starts.length)]! + Math.floor(random() * 6 * 60) * 60_000;
        const reference = bruteNext(expr, zone, from, 14 * 24 * 60);
        if (reference === null) continue; // beyond the reference window
        compared += 1;
        expect({ expr, from, next: nextCronTime(parseCronExpression(expr), zone, from) }).toEqual({
          expr,
          from,
          next: reference,
        });
      }
      expect(compared).toBeGreaterThanOrEqual(30);
    });
  }
});
