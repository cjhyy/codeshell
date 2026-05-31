import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-reload-"));
  file = join(dir, "cron.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CronScheduler.loadJobs — cross-process reload", () => {
  test("picks up a job another process wrote to the same store", () => {
    // Process A (e.g. a worker) creates a job and persists it.
    const a = new CronScheduler(new CronStore(file));
    const job = a.create("from-worker", "1h", "p");
    a.stopAll();

    // Process B (e.g. main) was already running with an empty scheduler...
    const b = new CronScheduler(new CronStore(file));
    expect(b.list()).toHaveLength(0);
    // ...and reloads to see what A wrote.
    b.loadJobs();
    expect(b.list().map((j) => j.id)).toContain(job.id);
    expect(b.get(job.id)?.name).toBe("from-worker");
    b.stopAll();
  });

  test("reload is idempotent — calling twice does not duplicate jobs or timers", () => {
    const a = new CronScheduler(new CronStore(file));
    a.create("x", "1h", "p");
    a.stopAll();

    const b = new CronScheduler(new CronStore(file));
    b.loadJobs();
    b.loadJobs(); // second reload
    expect(b.list()).toHaveLength(1); // not duplicated
    b.stopAll();
  });

  test("execution-disabled scheduler persists + computes nextRun but never fires", async () => {
    const sched = new CronScheduler(new CronStore(file));
    sched.setExecutionEnabled(false);
    let fired = 0;
    sched.setExecutor(async () => {
      fired++;
    });
    const job = sched.create("worker-job", "20", "p"); // 20ms interval
    // nextRun is computed for display even with execution off.
    expect(job.nextRun).toBeGreaterThan(Date.now());
    // Persisted to the shared store...
    expect(new CronStore(file).load().some((j) => j.id === job.id)).toBe(true);
    // ...but no timer ever fires in this process.
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(0);
    sched.stopAll();
  });

  test("a main-style scheduler reload arms a worker-written job (takes over execution)", async () => {
    // Worker process: execution disabled, creates + persists, never fires.
    const worker = new CronScheduler(new CronStore(file));
    worker.setExecutionEnabled(false);
    worker.create("from-worker", "20", "p");
    worker.stopAll();

    // Main process: execution enabled; reload picks it up AND arms it.
    const main = new CronScheduler(new CronStore(file));
    let fired = 0;
    main.setExecutor(async () => {
      fired++;
    });
    main.loadJobs();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBeGreaterThanOrEqual(1); // main runs it
    main.stopAll();
  });

  test("reload removes a job another process deleted from the store", () => {
    // Main loads two jobs.
    const seed = new CronScheduler(new CronStore(file));
    const a = seed.create("keep", "1h", "p");
    const b = seed.create("remove-me", "1h", "p");
    seed.stopAll();

    const main = new CronScheduler(new CronStore(file));
    main.loadJobs();
    expect(main.list()).toHaveLength(2);

    // Worker process deletes one job from the shared store.
    const worker = new CronScheduler(new CronStore(file));
    worker.setExecutionEnabled(false);
    worker.loadJobs();
    worker.delete(b.id);
    worker.stopAll();

    // Main reloads → the deleted job is gone from memory too.
    main.loadJobs();
    expect(main.list().map((j) => j.id)).toEqual([a.id]);
    expect(main.get(b.id)).toBeUndefined();
    main.stopAll();
  });

  test("reload stops the timer of a job deleted elsewhere (no orphan fires)", async () => {
    const seed = new CronScheduler(new CronStore(file));
    const job = seed.create("doomed", "20", "p"); // 20ms interval
    seed.stopAll();

    const main = new CronScheduler(new CronStore(file));
    let fired = 0;
    main.setExecutor(async () => {
      fired++;
    });
    main.loadJobs(); // arms the 20ms timer

    // Delete it from the store via another process and reload.
    const worker = new CronScheduler(new CronStore(file));
    worker.setExecutionEnabled(false);
    worker.loadJobs();
    worker.delete(job.id);
    worker.stopAll();

    main.loadJobs(); // should clear the timer
    const firedAtReload = fired;
    await new Promise((r) => setTimeout(r, 80));
    // No further fires after the deleted job's timer was cleared.
    expect(fired).toBe(firedAtReload);
    main.stopAll();
  });

  test("reload picks up an enabled→paused change made by another process", () => {
    const seed = new CronScheduler(new CronStore(file));
    const job = seed.create("toggle", "1h", "p");
    seed.stopAll();

    const main = new CronScheduler(new CronStore(file));
    main.loadJobs();
    expect(main.get(job.id)?.enabled).toBe(true);

    const worker = new CronScheduler(new CronStore(file));
    worker.setExecutionEnabled(false);
    worker.loadJobs();
    worker.pause(job.id);
    worker.stopAll();

    main.loadJobs();
    expect(main.get(job.id)?.enabled).toBe(false);
    main.stopAll();
  });

  test("reload after the file changes reflects new jobs added since", () => {
    const store = new CronStore(file);
    const b = new CronScheduler(store);
    b.loadJobs();
    expect(b.list()).toHaveLength(0);

    // Another process adds a job.
    const a = new CronScheduler(new CronStore(file));
    a.create("late", "1h", "p");
    a.stopAll();

    b.loadJobs();
    expect(b.list().some((j) => j.name === "late")).toBe(true);
    b.stopAll();
  });
});
