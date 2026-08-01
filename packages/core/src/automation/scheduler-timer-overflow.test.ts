// Long schedules must NOT fire early.
//
// Node/Electron timers take a 32-bit signed delay. A delay above 2^31-1 ms
// (~24.8 days) is not waited out — setTimeout emits TimeoutOverflowWarning and
// clamps it to 1ms. armInterval/armCron used to pass the full remaining delay
// straight through, so:
//   - a "30d" interval fired within milliseconds, then again, and again (each
//     re-arm was still out of range → clamped to 1ms again);
//   - a monthly cron whose next occurrence was ~31 days out did the same. The
//     cron misfire guard cannot catch this, because the timer fires BEFORE the
//     scheduled instant (now - scheduledFor is negative, not late).
//
// armAt() now sleeps in <=2^31-1ms chunks and only runs the job once the real
// instant has arrived.
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "./scheduler.js";
import { parseSchedule } from "./scheduler.js";
import { CronStore } from "./store.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const MAX_TIMER = 2_147_483_647;
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let now = START;
let dateNowSpy: { mockRestore: () => void } | undefined;
let schedulers: CronScheduler[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-timer-overflow-"));
  now = START;
  schedulers = [];
  jest.useFakeTimers({ now: 0 });
  dateNowSpy = spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  for (const scheduler of schedulers) scheduler.stopAll();
  schedulers = [];
  dateNowSpy?.mockRestore();
  dateNowSpy = undefined;
  jest.clearAllTimers();
  jest.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function makeScheduler(): CronScheduler {
  const scheduler = new CronScheduler(new CronStore(join(dir, "cron.json")));
  schedulers.push(scheduler);
  return scheduler;
}

/** Advance both the fake clock and the mocked Date.now in lockstep. */
async function advance(ms: number): Promise<void> {
  now += ms;
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

describe("CronScheduler long-delay timers", () => {
  test("a 30d interval does not fire early and fires exactly once on time", async () => {
    const scheduler = makeScheduler();
    const firedAt: number[] = [];
    scheduler.setExecutor(async () => {
      firedAt.push(Date.now());
    });

    const job = scheduler.create("monthly", "30d", "prompt", { timezone: "UTC" });
    expect(job.nextRun).toBe(START + 30 * DAY);

    // The old code fired within ~1ms here.
    await advance(5);
    expect(firedAt).toEqual([]);

    // Cross the 32-bit ceiling: still must not fire (30d > 24.8d).
    await advance(MAX_TIMER - 5);
    expect(firedAt).toEqual([]);

    // Walk up to one tick before the real instant.
    await advance(30 * DAY - MAX_TIMER - 1);
    expect(firedAt).toEqual([]);

    await advance(1);
    expect(firedAt).toEqual([START + 30 * DAY]);

    // And the NEXT occurrence is also a full 30d out, not immediate.
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 60 * DAY);
    await advance(5);
    expect(firedAt).toHaveLength(1);
  });

  test("a monthly cron whose next slot is >24.8 days out does not fire early", async () => {
    // 1 Jan → next "0 0 1 2 *" (Feb 1) is 31 days out, past the timer ceiling.
    const scheduler = makeScheduler();
    const firedAt: number[] = [];
    scheduler.setExecutor(async () => {
      firedAt.push(Date.now());
    });

    const job = scheduler.create("yearly-ish", "0 0 1 2 *", "prompt", { timezone: "UTC" });
    const nextRun = scheduler.get(job.id)?.nextRun;
    expect(nextRun).toBeDefined();
    const scheduledFor = nextRun as number;
    expect(scheduledFor).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    expect(scheduledFor - START).toBeGreaterThan(MAX_TIMER);

    await advance(5);
    expect(firedAt).toEqual([]);

    await advance(MAX_TIMER);
    expect(firedAt).toEqual([]);

    // Arrive exactly at the scheduled instant.
    await advance(scheduledFor - Date.now());
    expect(firedAt).toEqual([scheduledFor]);
  });

  test("a sub-ceiling interval is unaffected", async () => {
    const scheduler = makeScheduler();
    let fired = 0;
    scheduler.setExecutor(async () => {
      fired += 1;
    });

    scheduler.create("hourly", "1h", "prompt", { timezone: "UTC" });
    await advance(60 * 60 * 1000 - 1);
    expect(fired).toBe(0);
    await advance(1);
    expect(fired).toBe(1);
  });
});

describe("parseSchedule range guards", () => {
  test("accepts long-but-sane intervals", () => {
    expect(parseSchedule("30d")).toBe(30 * DAY);
    expect(parseSchedule("365d")).toBe(365 * DAY);
    expect(parseSchedule(String(MAX_TIMER + 1))).toBe(MAX_TIMER + 1);
  });

  test("rejects values that cannot survive schedule arithmetic", () => {
    // Beyond ~10 years: almost certainly a unit mistake (e.g. an epoch
    // timestamp passed as a relative interval) rather than a real schedule.
    expect(() => parseSchedule("4000d")).toThrow(/between 1ms and/);
    expect(() => parseSchedule(String(Number.MAX_SAFE_INTEGER))).toThrow(/between 1ms and/);
    // Still rejects the pre-existing bad input.
    expect(() => parseSchedule("0s")).toThrow(/Invalid schedule/);
    expect(() => parseSchedule("5mn")).toThrow(/Invalid schedule/);
  });
});
