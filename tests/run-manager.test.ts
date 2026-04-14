import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileRunStore } from "../src/run/FileRunStore.js";
import { RunQueue } from "../src/run/RunQueue.js";
import { VALID_TRANSITIONS } from "../src/run/types.js";
import type { RunSnapshot, RunStatus } from "../src/run/types.js";

// ─── State Machine ───────────────────────────────────────────────

describe("VALID_TRANSITIONS", () => {
  it("queued can go to running or cancelled", () => {
    expect(VALID_TRANSITIONS.queued).toContain("running");
    expect(VALID_TRANSITIONS.queued).toContain("cancelled");
    expect(VALID_TRANSITIONS.queued).not.toContain("completed");
  });

  it("running can go to multiple states", () => {
    const expected = [
      "waiting_input",
      "waiting_approval",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const s of expected) {
      expect(VALID_TRANSITIONS.running).toContain(s);
    }
  });

  it("waiting states can go back to queued or cancelled", () => {
    expect(VALID_TRANSITIONS.waiting_input).toContain("queued");
    expect(VALID_TRANSITIONS.waiting_input).toContain("cancelled");
    expect(VALID_TRANSITIONS.waiting_approval).toContain("queued");
    expect(VALID_TRANSITIONS.waiting_approval).toContain("cancelled");
  });

  it("terminal states have no transitions", () => {
    expect(VALID_TRANSITIONS.completed).toHaveLength(0);
    expect(VALID_TRANSITIONS.failed).toHaveLength(0);
    expect(VALID_TRANSITIONS.cancelled).toHaveLength(0);
  });

  it("blocked can go to queued or cancelled", () => {
    expect(VALID_TRANSITIONS.blocked).toContain("queued");
    expect(VALID_TRANSITIONS.blocked).toContain("cancelled");
  });
});

// ─── RunQueue ────────────────────────────────────────────────────

describe("RunQueue", () => {
  it("enqueues and dequeues in FIFO order", async () => {
    const queue = new RunQueue({ concurrency: 1 });
    const executed: string[] = [];

    queue.setExecutor(async (runId) => {
      executed.push(runId);
    });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");

    // Wait for microtasks to drain
    await new Promise((r) => setTimeout(r, 50));

    expect(executed).toEqual(["a", "b", "c"]);
  });

  it("respects concurrency limit", async () => {
    const queue = new RunQueue({ concurrency: 2 });
    let concurrent = 0;
    let maxConcurrent = 0;

    queue.setExecutor(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
    });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    queue.enqueue("d");

    await new Promise((r) => setTimeout(r, 200));

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("deduplicates enqueues", () => {
    const queue = new RunQueue();
    queue.setExecutor(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    queue.enqueue("a");
    queue.enqueue("a");
    expect(queue.pendingCount + queue.activeCount).toBeLessThanOrEqual(1);
  });

  it("cancels pending items", () => {
    const queue = new RunQueue();
    // Don't set executor so items stay pending
    queue.enqueue("a");
    queue.enqueue("b");

    const cancelled = queue.cancel("a");
    expect(cancelled).toBe(true);
    expect(queue.isPending("a")).toBe(false);
  });
});

// ─── FileRunStore + Recover scenario ─────────────────────────────

describe("FileRunStore recover scenario", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "run-recover-test-"));
    store = new FileRunStore(tmpDir);
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function makeSnapshot(overrides?: Partial<RunSnapshot>): RunSnapshot {
    return {
      runId: "test-run",
      objective: "Test",
      preset: "terminal-coding",
      cwd: "/tmp",
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      parentRunId: null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 0,
      latestCheckpointId: null,
      latestApprovalId: null,
      summary: null,
      error: null,
      tags: [],
      metadata: {},
      ...overrides,
    };
  }

  it("finds running runs for recovery", async () => {
    await store.create(makeSnapshot({ runId: "r1", status: "running" }));
    await store.create(makeSnapshot({ runId: "r2", status: "completed" }));
    await store.create(makeSnapshot({ runId: "r3", status: "running" }));

    const running = await store.list({ status: "running" });
    expect(running).toHaveLength(2);
    expect(running.map((r) => r.runId).sort()).toEqual(["r1", "r3"]);
  });

  it("can transition a run back to queued for recovery", async () => {
    const snap = makeSnapshot({ runId: "r1", status: "running", attemptCount: 1 });
    await store.create(snap);

    // Simulate recovery: reset to queued
    snap.status = "queued";
    snap.updatedAt = Date.now();
    await store.update(snap);

    const got = await store.get("r1");
    expect(got!.status).toBe("queued");
  });

  it("can mark a run as blocked after too many attempts", async () => {
    const snap = makeSnapshot({ runId: "r1", status: "running", attemptCount: 3 });
    await store.create(snap);

    snap.status = "blocked";
    snap.error = "Exceeded max recovery attempts";
    await store.update(snap);

    const got = await store.get("r1");
    expect(got!.status).toBe("blocked");
    expect(got!.error).toContain("max recovery");
  });
});
