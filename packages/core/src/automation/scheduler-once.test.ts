import { describe, test, expect } from "bun:test";
import { CronScheduler } from "./scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("CronScheduler one-shot (once) jobs", () => {
  test("一次性 interval job:fire 一次后从 list 消失", async () => {
    const sched = new CronScheduler();
    let runs = 0;
    sched.setExecutor(async () => {
      runs++;
    });
    const job = sched.create("oneshot", "1h", "do it", { once: true });
    expect(sched.list()).toHaveLength(1);

    sched.runNow(job.id);
    await sleep(20);

    expect(runs).toBe(1);
    expect(sched.list()).toHaveLength(0); // 一次性:跑完即删
    sched.stopAll();
  });

  test("循环 interval job:runNow 后仍在 list", async () => {
    const sched = new CronScheduler();
    sched.setExecutor(async () => {});
    const job = sched.create("loop", "1h", "do it"); // once 默认 false
    sched.runNow(job.id);
    await sleep(20);
    expect(sched.list()).toHaveLength(1); // 循环:不删
    sched.stopAll();
  });

  test("一次性 cron job:fire 一次后从 list 消失,不 re-arm", async () => {
    const sched = new CronScheduler();
    let runs = 0;
    sched.setExecutor(async () => {
      runs++;
    });
    const job = sched.create("oneshot-cron", "0 9 * * *", "morning", {
      once: true,
      timezone: "UTC",
    });
    expect(sched.list()).toHaveLength(1);
    sched.runNow(job.id);
    await sleep(20);
    expect(runs).toBe(1);
    expect(sched.list()).toHaveLength(0);
    sched.stopAll();
  });
});
