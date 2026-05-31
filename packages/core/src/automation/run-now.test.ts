import { describe, test, expect } from "bun:test";
import { CronScheduler } from "./scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("CronScheduler.runNow", () => {
  test("fires the executor immediately, out of band of the schedule", async () => {
    const sched = new CronScheduler();
    let fired = 0;
    sched.setExecutor(async () => {
      fired++;
    });
    const job = sched.create("daily", "1h", "p"); // long interval — won't tick during the test
    expect(fired).toBe(0);
    sched.runNow(job.id);
    await sleep(20);
    expect(fired).toBe(1);
    sched.stopAll();
  });

  test("returns false for an unknown id", () => {
    const sched = new CronScheduler();
    expect(sched.runNow("nope")).toBe(false);
    sched.stopAll();
  });

  test("runs even when the job is paused (force)", async () => {
    const sched = new CronScheduler();
    let fired = 0;
    sched.setExecutor(async () => {
      fired++;
    });
    const job = sched.create("x", "1h", "p");
    sched.pause(job.id);
    sched.runNow(job.id);
    await sleep(20);
    expect(fired).toBe(1);
    sched.stopAll();
  });

  test("respects the re-entrancy guard (no double fire while in flight)", async () => {
    const sched = new CronScheduler();
    let concurrent = 0;
    let max = 0;
    sched.setExecutor(async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      await sleep(40);
      concurrent--;
    });
    const job = sched.create("x", "1h", "p");
    sched.runNow(job.id);
    sched.runNow(job.id); // second call while first in flight — should be skipped
    await sleep(80);
    expect(max).toBe(1);
    sched.stopAll();
  });
});
