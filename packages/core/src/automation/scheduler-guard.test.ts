import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";

test("scoped mutations check the latest persisted binding inside the write transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "cron-guard-"));
  const file = join(root, "cron.json");
  const a = new CronScheduler(new CronStore(file)),
    b = new CronScheduler(new CronStore(file));
  a.setExecutionEnabled(false);
  b.setExecutionEnabled(false);
  try {
    const job = a.create("scope", "1h", "p", { cwd: "/a", resumeSessionId: "session-a" });
    b.loadJobs();
    b.update(job.id, { cwd: "/b", resumeSessionId: "session-b" });
    const before = readFileSync(file, "utf8");
    const guard = (current: { resumeSessionId?: string }) => {
      if (current.resumeSessionId !== "session-a") throw Error("scope changed");
    };
    expect(a.get(job.id)?.resumeSessionId).toBe("session-a");
    for (const change of [
      () => a.pause(job.id, guard),
      () => a.resume(job.id, guard),
      () => a.delete(job.id, guard),
      () => a.update(job.id, { prompt: "stale" }, guard),
      () => a.runNow(job.id, guard),
    ]) {
      expect(change).toThrow("scope changed");
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(
      b.update(job.id, { prompt: "current" }, (current) => {
        expect(current.resumeSessionId).toBe("session-b");
      })?.prompt,
    ).toBe("current");
  } finally {
    a.stopAll();
    b.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory-only guards reject without changing enabled state or content", () => {
  const s = new CronScheduler();
  s.setExecutionEnabled(false);
  try {
    const job = s.create("scope", "1h", "p");
    const before = structuredClone(job);
    const reject = () => {
      throw Error("denied");
    };
    for (const call of [
      () => s.pause(job.id, reject),
      () => s.resume(job.id, reject),
      () => s.delete(job.id, reject),
      () => s.update(job.id, { prompt: "changed" }, reject),
      () => s.runNow(job.id, reject),
    ])
      expect(call).toThrow("denied");
    expect(s.get(job.id)).toEqual(before);
  } finally {
    s.stopAll();
  }
});
