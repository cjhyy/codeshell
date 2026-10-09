import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler, type CronJob, type CronJobLifecycleEvent } from "./scheduler.js";
import { CronStore } from "./store.js";

const START = Date.parse("2026-10-10T00:00:00Z");
let now = START;
let root: string;
let file: string;
let clock: ReturnType<typeof spyOn>;
const schedulers: CronScheduler[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cron-absolute-once-"));
  file = join(root, "cron.json");
  now = START;
  jest.useFakeTimers({ now: 0 });
  clock = spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stopAll();
  clock.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function scheduler(persistent = true): CronScheduler {
  const value = new CronScheduler(persistent ? new CronStore(file) : undefined);
  schedulers.push(value);
  return value;
}

async function advance(ms: number): Promise<void> {
  now += ms;
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

function seed(options: Parameters<CronScheduler["create"]>[3] = {}): CronJob {
  const worker = scheduler();
  worker.setExecutionEnabled(false);
  return worker.create("wake", "once", "check work", {
    once: true,
    runAt: START + 100,
    ...options,
  });
}

describe("absolute one-shot scheduling", () => {
  test("restart/reload keeps the absolute target, executes once, and deletes the record", async () => {
    const job = seed();
    await advance(40);
    const host = scheduler();
    let calls = 0;
    host.setExecutor(async () => {
      calls++;
    });
    host.loadJobs();
    expect(host.get(job.id)?.nextRun).toBe(START + 100);
    await advance(20);
    host.loadJobs();
    expect(host.get(job.id)?.nextRun).toBe(START + 100);
    await advance(39);
    expect(calls).toBe(0);
    await advance(1);
    expect(calls).toBe(1);
    expect(host.get(job.id)).toBeUndefined();
    expect(new CronStore(file).load()).toEqual([]);
    await advance(1000);
    expect(calls).toBe(1);
  });

  test("skip disables a missed restart occurrence once, even within live timer grace", async () => {
    const job = seed();
    await advance(101);
    const host = scheduler();
    const events: CronJobLifecycleEvent[] = [];
    let calls = 0;
    host.setExecutor(async () => {
      calls++;
    });
    host.setJobEventListener((event) => events.push(event));
    host.loadJobs();
    await advance(0);
    host.loadJobs();
    await advance(0);
    expect(calls).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["job_missed"]);
    expect(events[0]).toMatchObject({ scheduledFor: START + 100, observedAt: START + 101 });
    expect(host.get(job.id)).toMatchObject({ enabled: false, runCount: 0 });
    expect(host.get(job.id)?.nextRun).toBeUndefined();
    expect(new CronStore(file).load()[0].enabled).toBe(false);
  });

  test("fire-once catches up through the inclusive deadline without overlapping on reload", async () => {
    const job = seed({ missedPolicy: "fire-once", catchUpUntil: START + 1000 });
    await advance(1000);
    const host = scheduler();
    let calls = 0;
    let finish!: () => void;
    host.setExecutor(async () => {
      calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    host.loadJobs();
    await advance(0);
    host.loadJobs();
    await advance(0);
    expect(calls).toBe(1);
    expect(host.get(job.id)?.runCount).toBe(1);
    finish();
    await advance(0);
    expect(host.get(job.id)).toBeUndefined();
    expect(new CronStore(file).load()).toEqual([]);
  });

  test("expired catch-up never executes after restart and does not move the target", async () => {
    const job = seed({ missedPolicy: "fire-once", catchUpUntil: START + 1000 });
    await advance(1001);
    const host = scheduler();
    let calls = 0;
    host.setExecutor(async () => {
      calls++;
    });
    host.loadJobs();
    await advance(0);
    expect(calls).toBe(0);
    expect(host.get(job.id)).toMatchObject({
      runAt: START + 100,
      enabled: false,
      disabledReason: "absolute occurrence expired",
    });
  });

  test("live sleep/wake applies skip or one bounded catch-up instead of recurring", async () => {
    for (const missedPolicy of ["skip", "fire-once"] as const) {
      const host = scheduler(false);
      let calls = 0;
      host.setExecutor(async () => {
        calls++;
      });
      const runAt = now + 100;
      const job = host.create("wake", "once", "check", {
        once: true,
        runAt,
        missedPolicy,
        catchUpUntil: runAt + 200_000,
      });
      // Wall time jumps while the queued timer remains at its original slot.
      now += 100_000;
      await advance(100);
      expect(calls).toBe(missedPolicy === "fire-once" ? 1 : 0);
      if (missedPolicy === "skip") expect(host.get(job.id)?.enabled).toBe(false);
      else expect(host.get(job.id)).toBeUndefined();
    }
  });

  test("updates re-arm the new absolute instant; pause/resume and no-arm never shift it", async () => {
    const job = seed();
    const host = scheduler();
    let calls = 0;
    host.setExecutor(async () => {
      calls++;
    });
    host.loadJobs();
    await advance(40);
    host.update(job.id, { runAt: START + 200, prompt: "updated" });
    host.pause(job.id);
    await advance(70);
    host.loadJobs({ arm: false });
    expect(host.get(job.id)?.runAt).toBe(START + 200);
    host.resume(job.id);
    expect(host.get(job.id)?.nextRun).toBe(START + 200);
    await advance(89);
    expect(calls).toBe(0);
    await advance(1);
    expect(calls).toBe(1);
  });

  test("worker/no-arm loads preserve overdue jobs for the execution host", async () => {
    const job = seed({ missedPolicy: "fire-once", catchUpUntil: START + 1000 });
    await advance(500);
    const worker = scheduler();
    worker.setExecutionEnabled(false);
    worker.loadJobs();
    worker.loadJobs({ arm: false });
    await advance(0);
    expect(worker.get(job.id)).toMatchObject({ enabled: true, nextRun: START + 100, runCount: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("far-future targets use safe timer chunks without early execution", async () => {
    const host = scheduler(false);
    let calls = 0;
    host.setExecutor(async () => {
      calls++;
    });
    const runAt = START + 2_147_483_647 + 100;
    const job = host.create("future", "once", "check", { once: true, runAt });
    await advance(2_147_483_647);
    expect(calls).toBe(0);
    expect(host.get(job.id)?.nextRun).toBe(runAt);
    await advance(99);
    expect(calls).toBe(0);
    await advance(1);
    expect(calls).toBe(1);
  });

  test("creation identity includes the absolute time and recovery definition", () => {
    const host = scheduler();
    host.setExecutionEnabled(false);
    const options = { once: true, runAt: START + 100, creationKey: "wake:test" };
    const job = host.create("wake", "once", "check", options);
    expect(host.create("wake", "once", "check", { ...options, missedPolicy: "skip" }).id).toBe(
      job.id,
    );
    expect(() => host.create("wake", "once", "check", { ...options, runAt: START + 200 })).toThrow(
      /different definition/,
    );
    expect(() =>
      host.create("wake", "once", "check", {
        ...options,
        missedPolicy: "fire-once",
        catchUpUntil: START + 1000,
      }),
    ).toThrow(/different definition/);
  });

  test("undefined update fields leave both absolute and recurring definitions intact", () => {
    for (const persistent of [false, true]) {
      const host = scheduler(persistent);
      host.setExecutionEnabled(false);
      const job = host.create("wake", "once", "check", { once: true, runAt: START + 100 });
      expect(
        host.update(job.id, { name: "renamed", runAt: undefined, schedule: undefined }),
      ).toMatchObject({ name: "renamed", schedule: "once", runAt: START + 100 });
      const recurring = host.create("repeat", "1h", "check");
      expect(host.update(recurring.id, { prompt: "updated", schedule: undefined })).toMatchObject({
        schedule: "1h",
        prompt: "updated",
      });
    }
  });

  test("interrupted effects may replay inside the explicit window for Host idempotency", async () => {
    const job = seed({ missedPolicy: "fire-once", catchUpUntil: START + 1000 });
    // A prior process persisted admission stats, then exited before its finally
    // could remove the job. Effect receipts belong to the composing Host.
    new CronStore(file).save([{ ...job, runCount: 1, lastRun: START + 100 }]);
    await advance(500);
    const host = scheduler();
    let calls = 0;
    host.setExecutor(async () => {
      calls++;
    });
    host.loadJobs();
    await advance(0);
    expect(calls).toBe(1);
    expect(new CronStore(file).load()).toEqual([]);
  });

  test("create/update/store reject invalid absolute definitions without partial changes", () => {
    const host = scheduler();
    host.setExecutionEnabled(false);
    const valid = { once: true, runAt: START + 100 };
    const job = host.create("wake", "once", "check", valid);
    const invalid = [
      { runAt: NaN },
      { runAt: Infinity },
      { runAt: -1 },
      { runAt: START + 0.5 },
      { runAt: 8_640_000_000_000_001 },
      { once: false },
      { missedPolicy: "retry" },
      { missedPolicy: "fire-once" },
      { catchUpUntil: START + 99 },
    ];
    for (const patch of invalid) {
      expect(() =>
        host.create("invalid", "once", "check", { ...valid, ...patch } as any),
      ).toThrow();
      expect(() => new CronStore(file).save([{ ...job, ...patch } as CronJob])).toThrow();
    }
    for (const patch of [{ runAt: -1 }, { missedPolicy: "fire-once" }, { catchUpUntil: 1 }]) {
      const before = readFileSync(file, "utf8");
      expect(() => host.update(job.id, { prompt: "must not change", ...patch } as any)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(host.get(job.id)?.prompt).toBe("check");
    }
    expect(() => host.create("invalid", "1h", "check", valid)).toThrow(/schedule/);
    expect(() => host.create("invalid", "1h", "check", { missedPolicy: "skip" })).toThrow(/runAt/);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, jobs: [job, { ...job, id: "bad", runAt: -1 }] }),
    );
    expect(new CronStore(file).load().map((entry) => entry.id)).toEqual([job.id]);
  });
});
