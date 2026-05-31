import { describe, test, expect } from "bun:test";
import { CronScheduler } from "./scheduler.js";

describe("CronScheduler.update", () => {
  test("changes the prompt without touching the schedule", () => {
    const s = new CronScheduler();
    const job = s.create("j", "1h", "old prompt");
    const updated = s.update(job.id, { prompt: "new prompt" });
    expect(updated?.prompt).toBe("new prompt");
    expect(updated?.schedule).toBe("1h");
    s.stopAll();
  });

  test("changes the schedule (interval → cron expr) and recomputes nextRun", () => {
    const s = new CronScheduler();
    const job = s.create("j", "1h", "p");
    const before = job.nextRun;
    const updated = s.update(job.id, { schedule: "0 9 * * 1-5", timezone: "UTC" });
    expect(updated?.schedule).toBe("0 9 * * 1-5");
    expect(updated?.timezone).toBe("UTC");
    expect(updated?.nextRun).toBeGreaterThan(Date.now());
    expect(updated?.nextRun).not.toBe(before);
    s.stopAll();
  });

  test("rejects an invalid schedule and leaves the job unchanged", () => {
    const s = new CronScheduler();
    const job = s.create("j", "1h", "p");
    expect(() => s.update(job.id, { schedule: "99 9 * * *" })).toThrow();
    expect(s.get(job.id)?.schedule).toBe("1h"); // unchanged
    s.stopAll();
  });

  test("returns null for an unknown id", () => {
    const s = new CronScheduler();
    expect(s.update("nope", { prompt: "x" })).toBeNull();
    s.stopAll();
  });

  test("re-arms the timer so the new schedule actually drives execution", async () => {
    const s = new CronScheduler();
    let fired = 0;
    s.setExecutor(async () => {
      fired++;
    });
    const job = s.create("j", "1h", "p"); // won't fire during test
    s.update(job.id, { schedule: "20" }); // 20ms — should now fire
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBeGreaterThanOrEqual(1);
    s.stopAll();
  });

  test("persists the update through the store", () => {
    const s = new CronScheduler();
    const job = s.create("j", "1h", "p");
    s.update(job.id, { name: "renamed", prompt: "p2" });
    expect(s.get(job.id)?.name).toBe("renamed");
    s.stopAll();
  });

  test("updating a paused job keeps it paused (no timer armed)", async () => {
    const s = new CronScheduler();
    let fired = 0;
    s.setExecutor(async () => { fired++; });
    const job = s.create("j", "1h", "p");
    s.pause(job.id);
    s.update(job.id, { schedule: "20" });
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(0); // still paused, even though schedule is now fast
    expect(s.get(job.id)?.enabled).toBe(false);
    s.stopAll();
  });
});
