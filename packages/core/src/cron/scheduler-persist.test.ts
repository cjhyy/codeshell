import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./cron-store.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-persist-"));
  file = join(dir, "cron.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CronScheduler persistence", () => {
  test("create persists the job to disk", () => {
    const sched = new CronScheduler(new CronStore(file));
    const job = sched.create("nightly", "1h", "do work");
    sched.stopAll();

    expect(existsSync(file)).toBe(true);
    const reloaded = new CronStore(file).load();
    expect(reloaded.find((j) => j.id === job.id)?.name).toBe("nightly");
  });

  test("loadJobs restores jobs and rebuilds timers across a restart", () => {
    const a = new CronScheduler(new CronStore(file));
    const j1 = a.create("nightly", "1h", "work");
    a.pause(j1.id);
    const j2 = a.create("hourly", "30m", "other");
    a.stopAll();

    // New process: fresh scheduler from the same store.
    const b = new CronScheduler(new CronStore(file));
    b.loadJobs();
    const jobs = b.list();
    expect(jobs.map((j) => j.id).sort()).toEqual([j1.id, j2.id].sort());
    // Paused job stays paused; active job keeps a live timer.
    expect(b.get(j1.id)?.enabled).toBe(false);
    expect(b.get(j2.id)?.enabled).toBe(true);
    b.stopAll();
  });

  test("loadJobs recomputes nextRun (no catch-up) and advances id allocation", () => {
    const a = new CronScheduler(new CronStore(file));
    const j = a.create("nightly", "1h", "work");
    a.stopAll();

    const b = new CronScheduler(new CronStore(file));
    b.loadJobs();
    // nextRun is recomputed forward from now, not the stale persisted value.
    const restored = b.get(j.id)!;
    expect(restored.nextRun!).toBeGreaterThan(Date.now() - 1000);
    // A newly created job must not collide with the restored id.
    const fresh = b.create("new", "1h", "p");
    expect(fresh.id).not.toBe(j.id);
    b.stopAll();
  });

  test("delete persists removal", () => {
    const a = new CronScheduler(new CronStore(file));
    const j = a.create("nightly", "1h", "work");
    a.delete(j.id);
    a.stopAll();

    const reloaded = new CronStore(file).load();
    expect(reloaded.find((x) => x.id === j.id)).toBeUndefined();
  });

  test("scheduler with no store works exactly as before (no persistence)", () => {
    const sched = new CronScheduler();
    const j = sched.create("x", "1h", "p");
    expect(sched.get(j.id)?.name).toBe("x");
    sched.stopAll();
    expect(existsSync(file)).toBe(false);
  });
});
