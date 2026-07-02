import { describe, test, expect } from "bun:test";
import { bindCronToEngine } from "./runner.js";
import { CronScheduler } from "./scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("bindCronToEngine — stop outcome disables the job", () => {
  test("a runner result with `stop` auto-disables the job and records the reason", async () => {
    const scheduler = new CronScheduler();
    bindCronToEngine(scheduler, async () => ({
      text: "",
      reason: "resume-target-missing",
      stop: { reason: "续接目标会话已删除,已停止该定时" },
    }));
    const job = scheduler.create("resume-job", "1h", "p", {
      resumeSessionId: "dead-sid",
    });

    scheduler.runNow(job.id);
    await sleep(20);

    const after = scheduler.list().find((j) => j.id === job.id)!;
    expect(after).toBeDefined(); // retained, not deleted
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toBe("续接目标会话已删除,已停止该定时");
    scheduler.stopAll();
  });

  test("a normal result (no stop) leaves a recurring job enabled", async () => {
    const scheduler = new CronScheduler();
    bindCronToEngine(scheduler, async () => ({ text: "ok", reason: "completed" }));
    const job = scheduler.create("normal", "1h", "p");

    scheduler.runNow(job.id);
    await sleep(20);

    const after = scheduler.list().find((j) => j.id === job.id)!;
    expect(after.enabled).toBe(true);
    expect(after.disabledReason).toBeUndefined();
    scheduler.stopAll();
  });
});
