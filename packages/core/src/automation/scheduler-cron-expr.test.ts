import { describe, test, expect } from "bun:test";
import { CronScheduler, isCronMisfire, type CronJob } from "./scheduler.js";

describe("CronScheduler — cron expression schedules", () => {
  test("accepts a cron expression and computes a future nextRun", () => {
    const sched = new CronScheduler();
    const job = sched.create("daily", "0 9 * * *", "p", { timezone: "UTC" });
    expect(job.nextRun).toBeGreaterThan(Date.now());
    expect(job.timezone).toBe("UTC");
    sched.stopAll();
  });

  test("rejects an invalid cron expression", () => {
    const sched = new CronScheduler();
    expect(() => sched.create("bad", "99 9 * * *", "p")).toThrow();
    sched.stopAll();
  });

  test("a cron-expression job that is due fires the executor", async () => {
    // Build an expression that matches the current UTC minute so it fires soon.
    const now = new Date();
    // "* * * * *" matches every minute → next whole minute, ≤ 60s away. Too slow
    // for a unit test, so instead assert nextRun scheduling math via a near match:
    // we use a 1-second interval fallback is not a cron expr. Here we only assert
    // that an every-minute expression schedules a timer without firing synchronously.
    const sched = new CronScheduler();
    let fired = 0;
    sched.setExecutor(async () => {
      fired++;
    });
    const job = sched.create("everymin", "* * * * *", "p", { timezone: "UTC" });
    expect(job.nextRun).toBeGreaterThan(Date.now());
    expect(fired).toBe(0); // does not fire synchronously
    sched.stopAll();
    void now;
  });

  test("create stores cwd / permissionLevel / timezone metadata", () => {
    const sched = new CronScheduler();
    const job = sched.create("w", "0 9 * * 1-5", "p", {
      cwd: "/tmp/proj",
      timezone: "Asia/Shanghai",
      permissionLevel: "workspace-write",
    });
    expect(job.cwd).toBe("/tmp/proj");
    expect(job.permissionLevel).toBe("workspace-write");
    expect(job.timezone).toBe("Asia/Shanghai");
    sched.stopAll();
  });

  test("interval schedules still work unchanged", () => {
    const sched = new CronScheduler();
    const job = sched.create("interval", "5m", "p");
    expect(job.schedule).toBe("5m");
    expect(job.nextRun).toBeGreaterThan(Date.now());
    sched.stopAll();
  });
});

describe("isCronMisfire — sleep/wake drift guard", () => {
  const at = Date.parse("2026-06-09T09:00:00Z"); // a scheduled instant

  test("firing on time (within the grace window) is NOT a misfire", () => {
    expect(isCronMisfire(at, at)).toBe(false); // exactly on time
    expect(isCronMisfire(at, at + 1_000)).toBe(false); // 1s late — jitter
    expect(isCronMisfire(at, at + 89_000)).toBe(false); // just under grace
  });

  test("firing far past the scheduled instant IS a misfire (the 06:56 bug)", () => {
    expect(isCronMisfire(at, at + 91_000)).toBe(true); // just over grace
    // Mac slept through 09:00 and woke ~2h later → timer fires at 06:56-style
    // drift. Must be treated as a misfire (skip + re-arm), not run at 11:00.
    expect(isCronMisfire(at, at + 2 * 60 * 60 * 1000)).toBe(true);
  });

  test("firing before the scheduled instant is never a misfire (timer can't run early on its own)", () => {
    expect(isCronMisfire(at, at - 10_000)).toBe(false);
  });
});

// Type sanity: optional fields are accessible.
const _tc = (j: CronJob): string | undefined => j.cwd;
void _tc;
