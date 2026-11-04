import { test, expect } from "bun:test";
import { mkdtempSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("new jobs never reuse a deleted identity or its memory/profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-identity-fixture-"));
  const file = join(dir, "cron.json");
  const first = new CronScheduler(new CronStore(file));
  const second = new CronScheduler(new CronStore(file));
  first.setExecutionEnabled(false);
  second.setExecutionEnabled(false);
  try {
    const original = first.create("project A private report", "1h", "summarize project A", {
      cwd: "/project-A",
      once: true,
    });
    first.setExecutor(async () => {});
    first.runNow(original.id);
    await Promise.resolve();
    expect(first.get(original.id)).toBeUndefined();
    first.stopAll();
    second.loadJobs();
    const replacement = second.create("project B public report", "1h", "summarize project B", {
      cwd: "/project-B",
    });
    expect(replacement.id).not.toBe(original.id);
  } finally {
    first.stopAll();
    second.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one-shot deletion I/O failure still releases public abort waiters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-cleanup-fixture-"));
  const file = join(dir, "cron.json");
  const scheduler = new CronScheduler(new CronStore(file));
  scheduler.setExecutionEnabled(false);
  let executorFinished = false;
  scheduler.setExecutor(async (_job, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    executorFinished = true;
  });
  try {
    const job = scheduler.create("one shot", "1h", "run", { once: true });
    // Capture the same private fire promise that runNow discards to avoid an unhandled rejection in the test process.
    const fire = (scheduler as any)
      .fire(job, () => {}, true)
      .then(
        () => "completed",
        (e: any) => e.code,
      );
    renameSync(file, `${file}.backup`);
    mkdirSync(file); // Real rename/EISDIR error, no mocked persistence code.
    const abort = scheduler.abort(job.id);
    const fireOutcome = await fire;
    const abortOutcome = await Promise.race([
      abort.then(() => "resolved"),
      delay(80).then(() => "still pending"),
    ]);
    expect(executorFinished).toBe(true);
    expect(fireOutcome).toBe("EISDIR");
    expect(abortOutcome).toBe("resolved");
  } finally {
    scheduler.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
