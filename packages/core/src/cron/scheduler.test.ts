import { describe, test, expect } from "bun:test";
import { CronScheduler } from "./scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Regression: setInterval fired every intervalMs regardless of whether the
// previous onExecute had finished, so a job slower than its interval ran
// overlapping copies of itself and double-counted runCount/nextRun
// (review-2026-05-30, high-severity race at scheduler.ts:100-110). The fix is
// a per-job re-entrancy guard: at most one execution in flight at a time.

describe("CronScheduler — no overlapping executions", () => {
  test("a slow job does not run concurrently with itself", async () => {
    const sched = new CronScheduler();
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;

    sched.setExecutor(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(60); // each run is much slower than the 10ms tick
      concurrent--;
      completed++;
    });

    const job = sched.create("slow", "10", "do work"); // 10ms interval
    // Let several ticks fire while the first run is still in flight.
    await sleep(140);
    sched.delete(job.id);
    // Drain any in-flight run.
    await sleep(80);

    expect(maxConcurrent).toBe(1); // never two at once
    expect(completed).toBeGreaterThanOrEqual(1); // it did run
  });
});
