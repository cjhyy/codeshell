import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_P0_PER_HOUR,
  DEFAULT_MAX_PER_HOUR,
  hostTimezoneOffsetMin,
  isInQuietHours,
  localHourIndex,
  route,
  type RouteDecision,
  type RouteNotice,
  type RouteState,
} from "./pet-notice-policy.js";

/** 2023-11-14T22:13:20Z. With a +08:00 offset that is 06:13 local the next day. */
const NOW = 1_700_000_000_000;
const UTC_PLUS_8 = 8 * 60;

/** Epoch ms for a UTC wall time on the NOW day; offset 0 makes it the local time too. */
function utcAt(hh: number, mm: number): number {
  const day = Math.floor(NOW / 86_400_000) * 86_400_000;
  return day + (hh * 60 + mm) * 60_000;
}

function state(overrides: Partial<RouteState> = {}): RouteState {
  return {
    now: utcAt(12, 0),
    present: false,
    quietHours: null,
    timezoneOffsetMin: 0,
    sentThisHour: 0,
    p0SentThisHour: 0,
    maxPerHour: DEFAULT_MAX_PER_HOUR,
    maxP0PerHour: DEFAULT_MAX_P0_PER_HOUR,
    seenDedupeKeys: new Set(),
    imReady: { wechat: "ready", lark: "ready" },
    ...overrides,
  };
}

function notice(overrides: Partial<RouteNotice> = {}): RouteNotice {
  return {
    priority: "P1",
    dedupeKey: "session.done:s1:run-1",
    attention: "always",
    channel: "auto",
    ...overrides,
  };
}

interface Row {
  name: string;
  notice?: Partial<RouteNotice>;
  state?: Partial<RouteState>;
  expected: RouteDecision;
}

const QUIET = { start: "11:00", end: "13:00" };

const rows: Row[] = [
  {
    name: "a seen dedupe key is dropped before anything else",
    notice: { attention: "muted", channel: "wechat" },
    state: { seenDedupeKeys: new Set(["session.done:s1:run-1"]) },
    expected: { outlet: "drop", reason: "duplicate" },
  },
  {
    name: "muted attention is only recorded",
    notice: { attention: "muted", priority: "P0", channel: "wechat" },
    expected: { outlet: "record", reason: "muted" },
  },
  {
    name: "digest attention goes to the digest",
    notice: { attention: "digest", priority: "P0", channel: "wechat" },
    expected: { outlet: "digest", reason: "digest-attention" },
  },
  {
    name: "P0 over its own hourly cap goes to the digest",
    notice: { priority: "P0", channel: "wechat" },
    state: { p0SentThisHour: DEFAULT_MAX_P0_PER_HOUR },
    expected: { outlet: "digest", reason: "p0-cap" },
  },
  {
    name: "P0 ignores the P1/P2 cap and quiet hours",
    notice: { priority: "P0", channel: "wechat" },
    state: { sentThisHour: 99, quietHours: QUIET, p0SentThisHour: DEFAULT_MAX_P0_PER_HOUR - 1 },
    expected: { outlet: "both", im: "wechat", reason: "named-im" },
  },
  {
    name: "an owner-timed P1 (a follow-up) ignores quiet hours and the P1/P2 cap",
    notice: { priority: "P1", ownerTimed: true, channel: "wechat" },
    state: { sentThisHour: 99, quietHours: QUIET, p0SentThisHour: DEFAULT_MAX_P0_PER_HOUR - 1 },
    expected: { outlet: "both", im: "wechat", reason: "named-im" },
  },
  {
    name: "an owner-timed P1 shares the P0 backstop",
    notice: { priority: "P1", ownerTimed: true, channel: "auto" },
    state: { p0SentThisHour: DEFAULT_MAX_P0_PER_HOUR },
    expected: { outlet: "digest", reason: "p0-cap" },
  },
  {
    name: "P1 in quiet hours goes to the digest",
    notice: { priority: "P1", channel: "wechat" },
    state: { quietHours: QUIET },
    expected: { outlet: "digest", reason: "quiet-hours" },
  },
  {
    name: "P2 in quiet hours goes to the digest (checked before the cap)",
    notice: { priority: "P2" },
    state: { quietHours: QUIET, sentThisHour: 99 },
    expected: { outlet: "digest", reason: "quiet-hours" },
  },
  {
    name: "P1 over the hourly cap goes to the digest",
    notice: { priority: "P1", channel: "wechat" },
    state: { sentThisHour: DEFAULT_MAX_PER_HOUR },
    expected: { outlet: "digest", reason: "hourly-cap" },
  },
  {
    name: "P1 just under the hourly cap still routes",
    notice: { priority: "P1", channel: "desktop" },
    state: { sentThisHour: DEFAULT_MAX_PER_HOUR - 1 },
    expected: { outlet: "desktop", reason: "desktop-channel" },
  },
  {
    name: "desktop channel is desktop even when away",
    notice: { channel: "desktop" },
    state: { present: false, lastInboundChannel: "wechat" },
    expected: { outlet: "desktop", reason: "desktop-channel" },
  },
  {
    name: "a named ready channel is used even when present, with a desktop record",
    notice: { channel: "lark" },
    state: { present: true },
    expected: { outlet: "both", im: "lark", reason: "named-im" },
  },
  {
    name: "a named channel with unknown readiness is still tried",
    notice: { channel: "lark" },
    state: { imReady: { lark: "unknown" } },
    expected: { outlet: "both", im: "lark", reason: "named-im" },
  },
  {
    name: "a named unavailable channel falls back to desktop and queues",
    notice: { channel: "lark" },
    state: { imReady: { lark: "unavailable", wechat: "ready" } },
    expected: { outlet: "desktop", im: "lark", queued: true, reason: "im-unavailable-queued" },
  },
  {
    name: "a named channel that is not bound falls back to desktop without queueing",
    notice: { channel: "telegram" },
    expected: { outlet: "desktop", reason: "im-unbound" },
  },
  {
    name: "auto while present stays on the desktop",
    notice: { channel: "auto" },
    state: { present: true, lastInboundChannel: "wechat" },
    expected: { outlet: "desktop", reason: "present-desktop" },
  },
  {
    name: "auto while present with requiresAway is only recorded",
    notice: { channel: "auto", requiresAway: true },
    state: { present: true },
    expected: { outlet: "record", reason: "requires-away-present" },
  },
  {
    name: "auto while away uses the channel the owner last wrote from",
    notice: { channel: "auto", requiresAway: true },
    state: { lastInboundChannel: "lark" },
    expected: { outlet: "im", im: "lark", reason: "away-last-inbound" },
  },
  {
    name: "auto while away skips an unavailable last-inbound channel",
    notice: { channel: "auto" },
    state: {
      lastInboundChannel: "lark",
      imReady: { wechat: "unavailable", lark: "unavailable", telegram: "unknown" },
    },
    expected: { outlet: "im", im: "telegram", reason: "away-first-ready" },
  },
  {
    name: "auto while away ignores a last-inbound channel that is no longer bound",
    notice: { channel: "auto" },
    state: { lastInboundChannel: "slack" },
    expected: { outlet: "im", im: "wechat", reason: "away-first-ready" },
  },
  {
    name: "auto while away with no usable channel falls back to desktop",
    notice: { channel: "auto" },
    state: { imReady: { wechat: "unavailable" }, lastInboundChannel: "wechat" },
    expected: { outlet: "desktop", reason: "no-im-available" },
  },
  {
    name: "auto while away with nothing bound falls back to desktop",
    notice: { channel: "auto" },
    state: { imReady: {} },
    expected: { outlet: "desktop", reason: "no-im-available" },
  },
  {
    name: "important attention routes exactly like always",
    notice: { channel: "auto", attention: "important" },
    state: { lastInboundChannel: "wechat" },
    expected: { outlet: "im", im: "wechat", reason: "away-last-inbound" },
  },
];

describe("route", () => {
  for (const row of rows) {
    test(row.name, () => {
      expect(route(notice(row.notice), state(row.state))).toEqual(row.expected);
    });
  }

  test("does not mutate its inputs", () => {
    const seen = new Set<string>();
    const s = state({ seenDedupeKeys: seen });
    const n = notice();
    const before = JSON.stringify({ ...s, seenDedupeKeys: [...seen] });
    route(n, s);
    expect(JSON.stringify({ ...s, seenDedupeKeys: [...seen] })).toBe(before);
    expect(seen.size).toBe(0);
  });
});

describe("requiresAway applies to every channel", () => {
  const cases: Array<[string, boolean, RouteDecision]> = [
    ["desktop", true, { outlet: "record", reason: "requires-away-present" }],
    ["desktop", false, { outlet: "desktop", reason: "desktop-channel" }],
    ["wechat", true, { outlet: "record", reason: "requires-away-present" }],
    ["wechat", false, { outlet: "both", im: "wechat", reason: "named-im" }],
    ["auto", true, { outlet: "record", reason: "requires-away-present" }],
    ["auto", false, { outlet: "im", im: "lark", reason: "away-last-inbound" }],
  ];
  for (const [channel, present, expected] of cases) {
    test(`${channel} while ${present ? "present" : "away"}`, () => {
      expect(
        route(
          notice({ channel, requiresAway: true }),
          state({ present, lastInboundChannel: "lark" }),
        ),
      ).toEqual(expected);
    });
  }

  test("throttling still wins over requiresAway (nothing is lost)", () => {
    expect(
      route(
        notice({ channel: "auto", requiresAway: true }),
        state({ present: true, sentThisHour: DEFAULT_MAX_PER_HOUR }),
      ),
    ).toEqual({ outlet: "digest", reason: "hourly-cap" });
  });
});

describe("DST", () => {
  // Bun stops tracking TZ once it is deleted, so restore by reassigning.
  const hostZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  function withTz<T>(tz: string, run: () => T): T {
    process.env.TZ = tz;
    try {
      return run();
    } finally {
      process.env.TZ = hostZone;
    }
  }

  // US spring-forward 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z).
  const beforeSpring = Date.UTC(2026, 2, 8, 6, 30); // 01:30 EST
  const afterSpring = Date.UTC(2026, 2, 8, 7, 30); // 03:30 EDT
  // US fall-back 2026-11-01: 01:00–02:00 local happens twice (05:00Z EDT, 06:00Z EST).
  const firstOne = Date.UTC(2026, 10, 1, 5, 30); // 01:30 EDT
  const secondOne = Date.UTC(2026, 10, 1, 6, 30); // 01:30 EST

  test("the host offset is sampled at each instant", () => {
    withTz("America/New_York", () => {
      expect(hostTimezoneOffsetMin(beforeSpring)).toBe(-300);
      expect(hostTimezoneOffsetMin(afterSpring)).toBe(-240);
    });
    withTz("UTC", () => expect(Object.is(hostTimezoneOffsetMin(beforeSpring), 0)).toBe(true));
  });

  test("quiet hours follow the local wall clock across spring-forward", () => {
    const window = { start: "03:00", end: "04:00" };
    withTz("America/New_York", () => {
      expect(isInQuietHours(window, beforeSpring, hostTimezoneOffsetMin(beforeSpring))).toBe(false);
      expect(isInQuietHours(window, afterSpring, hostTimezoneOffsetMin(afterSpring))).toBe(true);
    });
  });

  test("hour index: spring-forward skips an hour, fall-back repeats one", () => {
    withTz("America/New_York", () => {
      const index = (ms: number) => localHourIndex(ms, hostTimezoneOffsetMin(ms));
      expect(index(afterSpring) - index(beforeSpring)).toBe(2);
      // The repeated 01:00 wall-clock hour is one bucket.
      expect(index(secondOne)).toBe(index(firstOne));
    });
  });
});

describe("quiet hours", () => {
  const overnight = { start: "22:00", end: "07:00" };

  const cases: Array<[string, { start: string; end: string } | null, number, number, boolean]> = [
    ["disabled when null", null, utcAt(23, 0), 0, false],
    ["disabled when start === end", { start: "08:00", end: "08:00" }, utcAt(8, 0), 0, false],
    ["inside a same-day window", QUIET, utcAt(11, 30), 0, true],
    ["start is inclusive", QUIET, utcAt(11, 0), 0, true],
    ["end is exclusive", QUIET, utcAt(13, 0), 0, false],
    ["before a same-day window", QUIET, utcAt(10, 59), 0, false],
    ["overnight: late evening is quiet", overnight, utcAt(23, 30), 0, true],
    ["overnight: just after midnight is quiet", overnight, utcAt(0, 5), 0, true],
    ["overnight: early morning before end is quiet", overnight, utcAt(6, 59), 0, true],
    ["overnight: end is exclusive", overnight, utcAt(7, 0), 0, false],
    ["overnight: midday is not quiet", overnight, utcAt(12, 0), 0, false],
    // 22:13 UTC is 06:13 at +08:00, inside 22:00–07:00 local.
    ["uses the local offset, not UTC", overnight, NOW, UTC_PLUS_8, true],
    // 22:13 UTC is 14:13 at -08:00, outside the window.
    ["negative offsets work", overnight, NOW, -UTC_PLUS_8, false],
    ["a malformed window is ignored", { start: "25:00", end: "07:00" }, utcAt(23, 0), 0, false],
  ];

  for (const [name, window, now, offset, expected] of cases) {
    test(name, () => {
      expect(isInQuietHours(window, now, offset)).toBe(expected);
    });
  }

  test("a P1 crossing midnight in local time is deferred to the digest", () => {
    expect(
      route(
        notice({ channel: "wechat" }),
        state({ now: NOW, timezoneOffsetMin: UTC_PLUS_8, quietHours: overnight }),
      ),
    ).toEqual({ outlet: "digest", reason: "quiet-hours" });
  });

  test("an immediate notice skips quiet hours and the hourly cap, not dedupe", () => {
    const quiet = state({ now: utcAt(23, 30), quietHours: overnight, sentThisHour: 99 });
    expect(route(notice({ channel: "wechat", immediate: true }), quiet)).toEqual({
      outlet: "both",
      im: "wechat",
      reason: "named-im",
    });
    expect(
      route(notice({ channel: "wechat", immediate: true }), {
        ...quiet,
        seenDedupeKeys: new Set([notice().dedupeKey]),
      }),
    ).toEqual({ outlet: "drop", reason: "duplicate" });
  });

  test("a P1 is not deferred when start === end", () => {
    expect(
      route(
        notice({ channel: "wechat" }),
        state({ now: utcAt(8, 0), quietHours: { start: "08:00", end: "08:00" } }),
      ),
    ).toEqual({ outlet: "both", im: "wechat", reason: "named-im" });
  });
});
