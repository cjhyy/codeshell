import { describe, expect, test } from "bun:test";
import { CronScheduler, type CronJobLifecycleEvent } from "./scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("CronScheduler job lifecycle events", () => {
  test("a successful run emits job_start then job_end with a duration", async () => {
    const sched = new CronScheduler();
    const events: CronJobLifecycleEvent[] = [];
    sched.setJobEventListener((event) => events.push(event));
    sched.setExecutor(async () => {
      await sleep(5);
    });

    const job = sched.create("ok", "20", "p");
    await sleep(60);
    sched.delete(job.id);
    await sleep(10);

    const first = events.slice(0, 2);
    expect(first.map((e) => e.type)).toEqual(["job_start", "job_end"]);
    expect(first[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(first[0].job.name).toBe("ok");
  });

  test("a throwing run emits job_error with the message and keeps ticking", async () => {
    const sched = new CronScheduler();
    const events: CronJobLifecycleEvent[] = [];
    sched.setJobEventListener((event) => {
      events.push(event);
      throw new Error("observer boom"); // must not break the tick loop
    });
    let runs = 0;
    sched.setExecutor(async () => {
      runs++;
      throw new Error("job boom");
    });

    const job = sched.create("flaky", "20", "p");
    await sleep(80);
    sched.delete(job.id);
    await sleep(10);

    expect(runs).toBeGreaterThanOrEqual(2); // scheduler survived listener + job errors
    const errors = events.filter((e) => e.type === "job_error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].error).toBe("job boom");
  });
});
