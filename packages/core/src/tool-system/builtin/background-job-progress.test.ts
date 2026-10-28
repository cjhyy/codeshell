import { afterEach, expect, test } from "bun:test";
import { backgroundJobRegistry } from "./background-jobs.js";
import { backgroundJobHistory } from "./background-job-history.js";
import { listBackgroundWorkForUI } from "./background-work.js";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundJobHistory } from "./background-job-history.js";

afterEach(() => {
  backgroundJobRegistry.reset();
  backgroundJobHistory.dropForSession("progress-history-test");
  backgroundJobHistory.dropForSession("progress-other-test");
});

test("activity is bounded and detached, does not wake lifecycle waiters, and freezes on exit", () => {
  backgroundJobRegistry.start("progress-job", "progress-history-test");
  let calls = 0;
  const off = backgroundJobRegistry.subscribe(() => calls++);
  const time = Date.now();
  const progress = {
    lastActivityAt: time,
    eventCount: 12,
    phase: "tool" as const,
    summary: "a".repeat(300),
    recentEvents: Array.from({ length: 12 }, (_, n) => ({ at: time, summary: `tool ${n}` })),
  };
  backgroundJobRegistry.updateProgress("progress-job", progress);
  progress.recentEvents[11].summary = "mutated";
  const current = backgroundJobRegistry.get("progress-job")!.progress!;
  expect(current.summary).toHaveLength(240);
  expect(current.recentEvents).toHaveLength(8);
  expect(current.recentEvents?.at(-1)?.summary).toBe("tool 11");
  expect(calls).toBe(0);
  backgroundJobRegistry.updateProgress("progress-job", { lastActivityAt: time - 1, eventCount: 1 });
  expect(backgroundJobRegistry.get("progress-job")!.progress?.eventCount).toBe(12);
  backgroundJobRegistry.finish("progress-job");
  backgroundJobRegistry.updateProgress("progress-job", {
    lastActivityAt: time + 10,
    eventCount: 99,
  });
  expect(backgroundJobRegistry.get("progress-job")!.progress?.eventCount).toBe(12);
  expect(calls).toBe(1);
  off();
});

test("cold history keeps exact external identity but never asserts a process is running", () => {
  backgroundJobHistory.write({
    jobId: "cold-job",
    sessionId: "progress-history-test",
    description: "delegate",
    kind: "drive-agent",
    cli: "codex",
    ccSessionId: "thread-cold",
    launchCwd: "/tmp/worktree-cold",
    status: "running",
    startedAt: 100,
    abort() {
      throw new Error("must not serialize");
    },
    progress: { lastActivityAt: 200, eventCount: 4, summary: "Read a.ts" },
  });
  backgroundJobHistory.write({
    jobId: "cold-other",
    sessionId: "progress-other-test",
    description: "other",
    status: "running",
    startedAt: 100,
  });
  const jobs = listBackgroundWorkForUI("progress-history-test");
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    jobId: "cold-job",
    externalSessionId: "thread-cold",
    cwd: "/tmp/worktree-cold",
    status: "unknown",
    canCancel: false,
    progress: { eventCount: 4 },
  });
  expect(backgroundJobRegistry.hasRunningForSession("progress-history-test")).toBe(false);
  expect("abort" in jobs[0]).toBe(false);
  backgroundJobRegistry.dropForSession("progress-history-test");
  expect(listBackgroundWorkForUI("progress-history-test")).toEqual([]);
});

test("persisted terminal outcome and linkage survive independently of live registry", () => {
  backgroundJobRegistry.start("persist-job", "progress-history-test", "task", {
    persist: true,
    cli: "claude",
  });
  backgroundJobRegistry.recordArtifacts("persist-job", { ccSessionId: "claude-thread" });
  backgroundJobRegistry.updateProgress("persist-job", {
    lastActivityAt: Date.now(),
    eventCount: 7,
  });
  backgroundJobRegistry.finish("persist-job", { status: "failed", finalText: "CLI exited" });
  const saved = backgroundJobHistory.list("progress-history-test");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    status: "failed",
    ccSessionId: "claude-thread",
    finalText: "CLI exited",
    progress: { eventCount: 7 },
  });
  expect(listBackgroundWorkForUI("progress-history-test")).toHaveLength(1);
});

test("a long-running job saves its final status before terminal retention evicts it", () => {
  backgroundJobRegistry.start("old-running", "progress-history-test", "old", { persist: true });
  for (let index = 0; index < 50; index++) {
    backgroundJobRegistry.start(`newer-${index}`, "progress-history-test");
    backgroundJobRegistry.finish(`newer-${index}`);
  }
  backgroundJobRegistry.finish("old-running", { status: "completed", finalText: "finished last" });
  expect(backgroundJobRegistry.get("old-running")).toBeUndefined();
  expect(backgroundJobHistory.list("progress-history-test")).toMatchObject([
    { jobId: "old-running", status: "completed", finalText: "finished last" },
  ]);
});

test("malformed optional history fields cannot become renderer objects or unbounded events", () => {
  const root = mkdtempSync(join(tmpdir(), "job-history-test-"));
  try {
    const store = new BackgroundJobHistory(root);
    store.write({
      jobId: "malformed",
      sessionId: "owner",
      status: "completed",
      startedAt: 1,
      description: "task",
    });
    const file = join(root, readdirSync(root)[0]);
    const value = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      JSON.stringify({
        ...value,
        finalText: {},
        cwd: [],
        cli: "invalid",
        abort: {},
        progress: { lastActivityAt: 2, eventCount: 3, summary: {}, recentEvents: "oops" },
      }),
    );
    expect(store.list()).toEqual([{ ...value, progress: { lastActivityAt: 2, eventCount: 3 } }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
