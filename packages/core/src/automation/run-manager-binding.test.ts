import { describe, test, expect } from "bun:test";
import { CronScheduler } from "./scheduler.js";
import { bindCronToRunManager, type RunSubmitter } from "./runner.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
