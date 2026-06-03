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
    await expect(sched.abort(job.id)).resolves.toBe(true);
    expect(sawAbort).toBe(true);
    sched.stopAll();
  });

  test("the returned promise resolves only AFTER the run fully settles", async () => {
    const sched = new CronScheduler();
    let finishedWriting = false;
    sched.setExecutor(async (_job, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve());
      });
      // Simulate Engine's post-abort bookkeeping (the saveState that recreated
      // the deleted session dir in the race we're closing). The abort() promise
      // MUST NOT resolve until this has run.
      await sleep(20);
      finishedWriting = true;
    });
    const job = sched.create("x", "1h", "p");
    sched.runNow(job.id);
    await sleep(10);
    await sched.abort(job.id); // awaiting this must wait out the post-abort write
    expect(finishedWriting).toBe(true);
    sched.stopAll();
  });

  test("resolves false when the job is not running (no run to wait on)", async () => {
    const sched = new CronScheduler();
    sched.setExecutor(async () => {});
    const job = sched.create("x", "1h", "p");
    await expect(sched.abort(job.id)).resolves.toBe(false); // never fired
    await expect(sched.abort("nope")).resolves.toBe(false); // unknown id
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
    // run settled → controller removed → abort is a no-op resolving false
    await expect(sched.abort(job.id)).resolves.toBe(false);
    sched.stopAll();
  });
});
