import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { FileRunStore } from "../src/run/FileRunStore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  RunSnapshot,
  RunEvent,
  RunCheckpoint,
  RunApproval,
  RunArtifactRef,
} from "../src/run/types.js";

describe("FileRunStore", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "run-store-test-"));
    store = new FileRunStore(tmpDir);
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function makeSnapshot(overrides?: Partial<RunSnapshot>): RunSnapshot {
    return {
      runId: "test-run-001",
      objective: "Test objective",
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

  // ─── Snapshot CRUD ─────────────────────────────────────────────

  it("creates and retrieves a snapshot", async () => {
    const snap = makeSnapshot();
    await store.create(snap);
    const got = await store.get("test-run-001");
    expect(got).not.toBeNull();
    expect(got!.runId).toBe("test-run-001");
    expect(got!.objective).toBe("Test objective");
  });

  it("updates a snapshot", async () => {
    const snap = makeSnapshot();
    await store.create(snap);
    snap.status = "running";
    snap.startedAt = Date.now();
    await store.update(snap);
    const got = await store.get("test-run-001");
    expect(got!.status).toBe("running");
    expect(got!.startedAt).not.toBeNull();
  });

  it("returns null for nonexistent run", async () => {
    const got = await store.get("nonexistent");
    expect(got).toBeNull();
  });

  it("deletes a run", async () => {
    await store.create(makeSnapshot());
    await store.delete("test-run-001");
    const got = await store.get("test-run-001");
    expect(got).toBeNull();
  });

  // ─── List ──────────────────────────────────────────────────────

  it("lists runs sorted by createdAt descending", async () => {
    await store.create(makeSnapshot({ runId: "run-a", createdAt: 1000 }));
    await store.create(makeSnapshot({ runId: "run-b", createdAt: 3000 }));
    await store.create(makeSnapshot({ runId: "run-c", createdAt: 2000 }));
    const list = await store.list();
    expect(list).toHaveLength(3);
    expect(list[0].runId).toBe("run-b");
    expect(list[1].runId).toBe("run-c");
    expect(list[2].runId).toBe("run-a");
  });

  it("filters by status", async () => {
    await store.create(makeSnapshot({ runId: "r1", status: "queued" }));
    await store.create(makeSnapshot({ runId: "r2", status: "running" }));
    await store.create(makeSnapshot({ runId: "r3", status: "completed" }));
    const list = await store.list({ status: "running" });
    expect(list).toHaveLength(1);
    expect(list[0].runId).toBe("r2");
  });

  it("filters by multiple statuses", async () => {
    await store.create(makeSnapshot({ runId: "r1", status: "queued" }));
    await store.create(makeSnapshot({ runId: "r2", status: "running" }));
    await store.create(makeSnapshot({ runId: "r3", status: "completed" }));
    const list = await store.list({ status: ["queued", "running"] });
    expect(list).toHaveLength(2);
  });

  it("filters by tag", async () => {
    await store.create(makeSnapshot({ runId: "r1", tags: ["deploy"] }));
    await store.create(makeSnapshot({ runId: "r2", tags: ["test"] }));
    const list = await store.list({ tag: "deploy" });
    expect(list).toHaveLength(1);
    expect(list[0].runId).toBe("r1");
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await store.create(makeSnapshot({ runId: `r${i}`, createdAt: i * 1000 }));
    }
    const page = await store.list({ limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
    expect(page[0].runId).toBe("r3"); // sorted desc: r4,r3,r2,r1,r0 → offset 1 = r3
  });

  // ─── Events ────────────────────────────────────────────────────

  it("appends and lists events", async () => {
    await store.create(makeSnapshot());
    const event: RunEvent = {
      eventId: "evt-1",
      runId: "test-run-001",
      type: "run_created",
      timestamp: Date.now(),
      data: { objective: "test" },
    };
    await store.appendEvent(event);
    await store.appendEvent({ ...event, eventId: "evt-2", type: "run_started" });

    const events = await store.listEvents("test-run-001");
    expect(events).toHaveLength(2);
    expect(events[0].eventId).toBe("evt-1");
    expect(events[1].type).toBe("run_started");
  });

  // ─── Checkpoints ───────────────────────────────────────────────

  it("saves and retrieves latest checkpoint", async () => {
    await store.create(makeSnapshot());
    const cp1: RunCheckpoint = {
      checkpointId: "cp-1",
      runId: "test-run-001",
      createdAt: 1000,
      phase: "plan_ready",
      objective: "test",
      summary: "Plan complete",
      nextAction: null,
      linkedSessionId: null,
      touchedTools: ["Read"],
      touchedArtifacts: [],
      waitingFor: null,
      evaluator: null,
      metadata: {},
    };
    const cp2: RunCheckpoint = {
      ...cp1,
      checkpointId: "cp-2",
      createdAt: 2000,
      phase: "final",
      summary: "All done",
    };
    await store.saveCheckpoint(cp1);
    await store.saveCheckpoint(cp2);

    const latest = await store.getLatestCheckpoint("test-run-001");
    expect(latest).not.toBeNull();
    expect(latest!.checkpointId).toBe("cp-2");
    expect(latest!.phase).toBe("final");
  });

  // ─── Approvals ─────────────────────────────────────────────────

  it("saves and retrieves pending approval", async () => {
    await store.create(makeSnapshot());
    const approval: RunApproval = {
      approvalId: "appr-1",
      runId: "test-run-001",
      createdAt: Date.now(),
      resolvedAt: null,
      status: "pending",
      category: "tool",
      title: "Approve: Bash",
      description: "Run: rm -rf /tmp/test",
      payload: {},
    };
    await store.saveApproval(approval);

    const pending = await store.getPendingApproval("test-run-001");
    expect(pending).not.toBeNull();
    expect(pending!.approvalId).toBe("appr-1");
    expect(pending!.status).toBe("pending");
  });

  it("returns null when no pending approval", async () => {
    await store.create(makeSnapshot());
    const approval: RunApproval = {
      approvalId: "appr-1",
      runId: "test-run-001",
      createdAt: Date.now(),
      resolvedAt: Date.now(),
      status: "approved",
      category: "tool",
      title: "Approve: Bash",
      description: "test",
      payload: {},
    };
    await store.saveApproval(approval);
    const pending = await store.getPendingApproval("test-run-001");
    expect(pending).toBeNull();
  });

  // ─── Artifact Refs ─────────────────────────────────────────────

  it("appends and lists artifact refs", async () => {
    await store.create(makeSnapshot());
    const ref: RunArtifactRef = {
      artifactRefId: "art-1",
      runId: "test-run-001",
      kind: "file",
      title: "main.ts",
      locator: "/src/main.ts",
      role: "output",
      version: null,
      metadata: {},
    };
    await store.appendArtifactRef(ref);
    await store.appendArtifactRef({ ...ref, artifactRefId: "art-2", title: "test.ts" });

    const refs = await store.listArtifactRefs("test-run-001");
    expect(refs).toHaveLength(2);
    expect(refs[0].title).toBe("main.ts");
    expect(refs[1].title).toBe("test.ts");
  });
});
