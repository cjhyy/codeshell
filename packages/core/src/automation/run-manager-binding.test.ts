import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";
import { bindCronToRunManager, type RunSubmitter } from "./runner.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-run-manager-"));
  file = join(dir, "cron.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("bindCronToRunManager", () => {
  test("a fired job submits to the RunManager with prompt + cwd + metadata", async () => {
    const submissions: Array<{ objective: string; cwd?: string; metadata?: Record<string, unknown> }> = [];
    const fake: RunSubmitter = {
      async submit(input) {
        submissions.push(input);
        return { runId: `run-${submissions.length}` };
      },
    };
    const sched = new CronScheduler();
    bindCronToRunManager(sched, fake);
    const job = sched.create("nightly", "20", "summarize repo", { cwd: "/tmp/proj" });
    await sleep(50);
    sched.delete(job.id);
    await sleep(10);

    expect(submissions.length).toBeGreaterThanOrEqual(1);
    expect(submissions[0].objective).toBe("summarize repo");
    expect(submissions[0].cwd).toBe("/tmp/proj");
    expect(submissions[0].metadata?.source).toBe("automation");
    expect(submissions[0].metadata?.cronJobId).toBe(job.id);
  });

  test("records lastRunId back on the job", async () => {
    const fake: RunSubmitter = {
      async submit() {
        return { runId: "run-xyz" };
      },
    };
    const sched = new CronScheduler();
    bindCronToRunManager(sched, fake);
    const job = sched.create("x", "20", "p");
    await sleep(50);
    sched.delete(job.id);
    await sleep(10);
    expect(job.lastRunId).toBe("run-xyz");
  });

  test("persists lastRunId after RunManager submit completes", async () => {
    const fake: RunSubmitter = {
      async submit() {
        return { runId: "run-persisted" };
      },
    };
    const store = new CronStore(file);
    const sched = new CronScheduler(store);
    bindCronToRunManager(sched, fake);
    const job = sched.create("x", "20", "p");
    await sleep(50);

    expect(store.load().find((j) => j.id === job.id)?.lastRunId).toBe("run-persisted");
    sched.stopAll();
  });

  test("run metadata persistence preserves edits made while a run is in flight", async () => {
    const store = new CronStore(file);
    const sched = new CronScheduler(store);
    let jobId = "";
    const fake: RunSubmitter = {
      async submit() {
        const worker = new CronScheduler(new CronStore(file));
        worker.setExecutionEnabled(false);
        worker.loadJobs();
        worker.update(jobId, { prompt: "new prompt" });
        worker.stopAll();
        return { runId: "run-after-edit" };
      },
    };
    bindCronToRunManager(sched, fake);
    const job = sched.create("x", "1h", "old prompt");
    jobId = job.id;
    sched.runNow(job.id);
    await sleep(30);

    const persisted = store.load().find((j) => j.id === job.id);
    expect(persisted?.prompt).toBe("new prompt");
    expect(persisted?.lastRunId).toBe("run-after-edit");
    sched.stopAll();
  });

  test("a submit that throws does not break the scheduler tick loop", async () => {
    let calls = 0;
    const fake: RunSubmitter = {
      async submit() {
        calls++;
        throw new Error("submit failed");
      },
    };
    const sched = new CronScheduler();
    bindCronToRunManager(sched, fake);
    const job = sched.create("flaky", "20", "p");
    await sleep(80);
    sched.delete(job.id);
    await sleep(10);
    expect(calls).toBeGreaterThanOrEqual(2); // kept ticking despite throwing
  });
});
