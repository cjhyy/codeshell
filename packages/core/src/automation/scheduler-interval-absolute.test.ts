import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler, type CronJob } from "./scheduler.js";
import { CronStore } from "./store.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");

let dir: string;
let file: string;
let now = START;
let dateNowSpy: { mockRestore: () => void } | undefined;
let schedulers: CronScheduler[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-interval-absolute-"));
  file = join(dir, "cron.json");
  now = START;
  schedulers = [];
  jest.useFakeTimers({ now: 0 });
  dateNowSpy = spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  for (const scheduler of schedulers) scheduler.stopAll();
  schedulers = [];
  dateNowSpy?.mockRestore();
  dateNowSpy = undefined;
  jest.clearAllTimers();
  jest.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function makeScheduler(store = new CronStore(file)): CronScheduler {
  const scheduler = new CronScheduler(store);
  schedulers.push(scheduler);
  return scheduler;
}

function seedJob(schedule = "100", opts?: Parameters<CronScheduler["create"]>[3]): CronJob {
  const seed = makeScheduler();
  const job = seed.create("job", schedule, "initial prompt", opts);
  seed.stopAll();
  return job;
}

function mutateJob(id: string, patch: Partial<CronJob>): void {
  new CronStore(file).mutate((jobs) => ({
    jobs: jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    result: null,
  }));
}

async function flushTimers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  now += ms;
  jest.advanceTimersByTime(ms);
  await flushTimers();
}

describe("CronScheduler interval absolute scheduling", () => {
  test("in-memory update with unchanged schedule/timezone preserves interval nextRun", async () => {
    const scheduler = new CronScheduler();
    schedulers.push(scheduler);
    let fired = 0;
    scheduler.setExecutor(async () => {
      fired++;
    });

    const job = scheduler.create("job", "10m", "prompt", { timezone: "UTC" });
    const firstNextRun = job.nextRun;
    expect(firstNextRun).toBe(START + 10 * 60 * 1000);
    expect(jest.getTimerCount()).toBe(1);

    await advance(2 * 60 * 1000);
    const updated = scheduler.update(job.id, {
      name: "renamed",
      schedule: job.schedule,
      timezone: job.timezone,
    });

    expect(updated?.name).toBe("renamed");
    expect(updated?.nextRun).toBe(firstNextRun);
    expect(jest.getTimerCount()).toBe(1);

    await advance(8 * 60 * 1000 - 1);
    expect(fired).toBe(0);
    await advance(1);
    expect(fired).toBe(1);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 20 * 60 * 1000);

    const changed = scheduler.update(job.id, { schedule: "20m", timezone: "UTC" });
    expect(changed?.nextRun).toBe(START + 30 * 60 * 1000);
  });

  test("store-backed update with unchanged schedule/timezone preserves interval nextRun", async () => {
    const scheduler = makeScheduler();
    let fired = 0;
    scheduler.setExecutor(async () => {
      fired++;
    });

    const job = scheduler.create("job", "10m", "prompt", { timezone: "UTC" });
    const firstNextRun = scheduler.get(job.id)?.nextRun;
    expect(firstNextRun).toBe(START + 10 * 60 * 1000);
    expect(jest.getTimerCount()).toBe(1);

    await advance(2 * 60 * 1000);
    const updated = scheduler.update(job.id, {
      name: "renamed",
      schedule: job.schedule,
      timezone: job.timezone,
    });

    expect(updated?.name).toBe("renamed");
    expect(updated?.nextRun).toBe(firstNextRun);
    expect(jest.getTimerCount()).toBe(1);

    await advance(8 * 60 * 1000 - 1);
    expect(fired).toBe(0);
    await advance(1);
    expect(fired).toBe(1);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 20 * 60 * 1000);

    const changed = scheduler.update(job.id, { schedule: "20m", timezone: "UTC" });
    expect(changed?.nextRun).toBe(START + 30 * 60 * 1000);
  });

  test("repeated loadJobs keeps nextRun stable and does not delay the first fire", async () => {
    const job = seedJob("100");
    const scheduler = makeScheduler();
    let fired = 0;
    scheduler.setExecutor(async () => {
      fired++;
    });

    scheduler.loadJobs();
    const firstNextRun = scheduler.get(job.id)?.nextRun;
    expect(firstNextRun).toBe(START + 100);

    await advance(25);
    scheduler.loadJobs();
    await advance(25);
    scheduler.loadJobs();

    expect(scheduler.get(job.id)?.nextRun).toBe(firstNextRun);
    expect(jest.getTimerCount()).toBe(1);

    await advance(49);
    expect(fired).toBe(0);
    await advance(1);

    expect(fired).toBe(1);
    expect(scheduler.get(job.id)?.lastRun).toBe(START + 100);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 200);
  });

  test("unchanged reload keeps the live object that the timer will update", async () => {
    const job = seedJob("100");
    const scheduler = makeScheduler();
    scheduler.setExecutor(async () => {});

    scheduler.loadJobs();
    const live = scheduler.get(job.id)!;
    scheduler.loadJobs();

    expect(scheduler.get(job.id)).toBe(live);

    await advance(100);

    expect(live.runCount).toBe(1);
    expect(live.lastRun).toBe(START + 100);
    expect(live.nextRun).toBe(START + 200);
    expect(scheduler.get(job.id)).toBe(live);
  });

  test("external non-schedule edits do not re-arm and the next fire uses new fields", async () => {
    const job = seedJob("100", { cwd: "/tmp/old", permissionLevel: "read-only" });
    const scheduler = makeScheduler();
    const seen: Array<Pick<CronJob, "name" | "prompt" | "cwd" | "permissionLevel">> = [];
    scheduler.setExecutor(async (firedJob) => {
      seen.push({
        name: firedJob.name,
        prompt: firedJob.prompt,
        cwd: firedJob.cwd,
        permissionLevel: firedJob.permissionLevel,
      });
    });

    scheduler.loadJobs();
    const live = scheduler.get(job.id)!;
    const firstNextRun = live.nextRun;

    await advance(40);
    mutateJob(job.id, {
      name: "renamed",
      prompt: "new prompt",
      cwd: "/tmp/new",
      permissionLevel: "workspace-write",
    });
    scheduler.loadJobs();

    expect(scheduler.get(job.id)).toBe(live);
    expect(live.nextRun).toBe(firstNextRun);

    await advance(60);

    expect(seen).toEqual([
      {
        name: "renamed",
        prompt: "new prompt",
        cwd: "/tmp/new",
        permissionLevel: "workspace-write",
      },
    ]);
  });

  test("unchanged once interval jobs still fire once and delete after repeated loadJobs", async () => {
    const job = seedJob("100", { once: true });
    const scheduler = makeScheduler();
    let fired = 0;
    scheduler.setExecutor(async () => {
      fired++;
    });

    scheduler.loadJobs();
    await advance(40);
    scheduler.loadJobs();
    await advance(60);

    expect(fired).toBe(1);
    expect(scheduler.get(job.id)).toBeUndefined();
    expect(scheduler.list()).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("external schedule and enabled changes clear and re-arm interval timers", async () => {
    const job = seedJob("100");
    const scheduler = makeScheduler();
    let fired = 0;
    scheduler.setExecutor(async () => {
      fired++;
    });

    scheduler.loadJobs();
    await advance(40);
    mutateJob(job.id, { schedule: "200" });
    scheduler.loadJobs();

    expect(scheduler.get(job.id)?.schedule).toBe("200");
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 240);

    await advance(199);
    expect(fired).toBe(0);
    await advance(1);
    expect(fired).toBe(1);

    mutateJob(job.id, { enabled: false });
    scheduler.loadJobs();
    expect(scheduler.get(job.id)?.enabled).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    await advance(500);
    expect(fired).toBe(1);

    mutateJob(job.id, { enabled: true });
    scheduler.loadJobs();
    expect(scheduler.get(job.id)?.enabled).toBe(true);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 940);

    await advance(200);
    expect(fired).toBe(2);
  });

  test("external cron timezone changes re-arm and recompute nextRun", () => {
    now = Date.parse("2026-01-01T00:30:00.000Z");
    const job = seedJob("0 9 * * *", { timezone: "UTC" });
    const scheduler = makeScheduler();

    scheduler.loadJobs();
    const utcNextRun = scheduler.get(job.id)?.nextRun;

    mutateJob(job.id, { timezone: "Asia/Shanghai" });
    scheduler.loadJobs();

    expect(scheduler.get(job.id)?.timezone).toBe("Asia/Shanghai");
    expect(scheduler.get(job.id)?.nextRun).not.toBe(utcNextRun);
  });

  test("unchanged enabled job with a missing timer is armed on loadJobs", async () => {
    const job = seedJob("100");
    const scheduler = makeScheduler();
    let fired = 0;
    scheduler.setExecutor(async () => {
      fired++;
    });

    scheduler.loadJobs();
    const live = scheduler.get(job.id)!;
    await advance(40);
    scheduler.stopAll();
    expect(jest.getTimerCount()).toBe(0);

    scheduler.loadJobs();
    expect(scheduler.get(job.id)).toBe(live);
    expect(live.nextRun).toBe(START + 140);

    await advance(99);
    expect(fired).toBe(0);
    await advance(1);
    expect(fired).toBe(1);
  });

  test("interval re-arm keeps fixed phase and skips missed slots without catch-up", async () => {
    const job = seedJob("100");
    const scheduler = makeScheduler();
    const firedAt: number[] = [];
    scheduler.setExecutor(async () => {
      firedAt.push(Date.now());
    });

    scheduler.loadJobs();

    await advance(100);
    expect(firedAt).toEqual([START + 100]);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 200);

    await advance(100);
    expect(firedAt).toEqual([START + 100, START + 200]);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 300);

    now = START + 650;
    jest.advanceTimersByTime(100);
    await flushTimers();

    expect(firedAt).toEqual([START + 100, START + 200, START + 650]);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 700);

    now = START + 700;
    jest.advanceTimersByTime(50);
    await flushTimers();

    expect(firedAt).toEqual([START + 100, START + 200, START + 650, START + 700]);
    expect(scheduler.get(job.id)?.nextRun).toBe(START + 800);
  });

  test("cron jobs keep a stable nextRun across repeated loadJobs", async () => {
    const job = seedJob("* * * * *", { timezone: "UTC" });
    const scheduler = makeScheduler();

    scheduler.loadJobs();
    const live = scheduler.get(job.id)!;
    const firstNextRun = live.nextRun;

    await advance(10_000);
    scheduler.loadJobs();
    await advance(10_000);
    scheduler.loadJobs();

    expect(scheduler.get(job.id)).toBe(live);
    expect(live.nextRun).toBe(firstNextRun);
  });

  test("worker and no-arm reload paths do not start timers or fire", async () => {
    const worker = makeScheduler();
    worker.setExecutionEnabled(false);
    let workerFires = 0;
    worker.setExecutor(async () => {
      workerFires++;
    });

    const job = worker.create("worker", "100", "prompt");
    expect(jest.getTimerCount()).toBe(0);

    worker.update(job.id, { prompt: "updated", schedule: "50" });
    worker.loadJobs();
    expect(jest.getTimerCount()).toBe(0);

    await advance(500);
    expect(workerFires).toBe(0);

    const reader = makeScheduler();
    let readerFires = 0;
    reader.setExecutor(async () => {
      readerFires++;
    });

    reader.loadJobs({ arm: false });
    reader.loadJobs({ arm: false });
    mutateJob(job.id, { schedule: "25" });
    reader.loadJobs({ arm: false });

    expect(jest.getTimerCount()).toBe(0);
    await advance(500);
    expect(readerFires).toBe(0);
  });
});
