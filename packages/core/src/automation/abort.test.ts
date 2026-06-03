import { describe, test, expect } from "bun:test";
import { CronScheduler } from "./scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("CronScheduler.abort", () => {
  test("aborts an in-flight run via the AbortSignal handed to the executor", async () => {
    const sched = new CronScheduler();
    let sawAbort = false;
    sched.setExecutor(async (_job, signal) => {
      // Mirror Engine.run: cooperate with the signal, resolve (don't throw) on abort.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          sawAbort = true;
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          resolve();
        });
      });
    });
    const job = sched.create("x", "1h", "p"); // long interval — won't tick during the test
    sched.runNow(job.id);
    await sleep(10); // let fire() install the controller + start the executor
    expect(sched.abort(job.id)).toBe(true);
    await sleep(10);
    expect(sawAbort).toBe(true);
    sched.stopAll();
  });

  test("returns false when the job is not running", () => {
    const sched = new CronScheduler();
    sched.setExecutor(async () => {});
    const job = sched.create("x", "1h", "p");
    expect(sched.abort(job.id)).toBe(false); // never fired
    expect(sched.abort("nope")).toBe(false); // unknown id
    sched.stopAll();
  });

  test("clears the controller after the run settles (no stale abort)", async () => {
    const sched = new CronScheduler();
    sched.setExecutor(async () => {
      await sleep(10);
    });
    const job = sched.create("x", "1h", "p");
    sched.runNow(job.id);
    await sleep(40); // run finished
    // run settled → controller removed → abort is a no-op returning false
    expect(sched.abort(job.id)).toBe(false);
    sched.stopAll();
  });
});
