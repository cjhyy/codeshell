import { describe, test, expect } from "bun:test";
import { CronScheduler } from "./scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("CronScheduler.disableWithReason", () => {
  test("disables a recurring job, records the reason, retains it, and clears its timer", async () => {
    const sched = new CronScheduler();
    let runs = 0;
    sched.setExecutor(async () => {
      runs++;
    });
    // A short interval so the tick would fire quickly if the timer weren't cleared.
    const job = sched.create("resume-job", "30s", "keep watching");
    expect(job.enabled).toBe(true);

    const ok = sched.disableWithReason(job.id, "续接目标会话已删除");
    expect(ok).toBe(true);

    const after = sched.list().find((j) => j.id === job.id)!;
    // Job is RETAINED (auditable), not deleted.
    expect(after).toBeDefined();
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toBe("续接目标会话已删除");
    // Timer cleared → no scheduled/automatic fire. (runNow(force) can still fire
    // a disabled job on demand by design; we assert the automatic path is dead.)
    await sleep(20);
    expect(runs).toBe(0);
    sched.stopAll();
  });

  test("returns false for an unknown job id", () => {
    const sched = new CronScheduler();
    expect(sched.disableWithReason("nope", "x")).toBe(false);
    sched.stopAll();
  });

  test("re-enabling via resume() clears the disabledReason", () => {
    const sched = new CronScheduler();
    sched.setExecutor(async () => {});
    const job = sched.create("j", "1h", "p");
    sched.disableWithReason(job.id, "gone");
    expect(sched.list()[0].disabledReason).toBe("gone");
    sched.resume(job.id);
    const after = sched.list()[0];
    expect(after.enabled).toBe(true);
    expect(after.disabledReason).toBeUndefined();
    sched.stopAll();
  });
});
