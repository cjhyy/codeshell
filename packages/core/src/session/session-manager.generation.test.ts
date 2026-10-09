import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionRunFinalStatePatch } from "./session-manager.js";
import { lockSync } from "../utils/lockfile.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager close generation fencing", () => {
  it("uses state revision CAS between Engines in the same close epoch", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "session-generation-concurrent-"));
    tempDirs.push(storageDir);
    const sid = "concurrent-sid";
    const seed = new SessionManager(storageDir);
    seed.create("/tmp/project", "model", "provider", sid);

    const engineA = new SessionManager(storageDir);
    const engineB = new SessionManager(storageDir);
    const generationA = engineA.registerSessionGeneration(sid);
    const generationB = engineB.registerSessionGeneration(sid);
    const stateA = engineA.resume(sid).state;
    const stateB = engineB.resume(sid).state;
    stateA.turnCount = 1;
    stateB.turnCount = 2;

    expect(generationA).toBe(generationB);
    expect(engineA.saveState(stateA)).toBe(true);
    expect(engineB.saveState(stateB)).toBe(false);
    expect(seed.resume(sid).state.turnCount).toBe(1);
  });

  it("recovers a stale orphaned state lock left by a crashed process", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "session-generation-orphan-lock-"));
    tempDirs.push(storageDir);
    const sid = "orphan-lock-sid";
    const manager = new SessionManager(storageDir);
    const bundle = manager.create("/tmp/project", "model", "provider", sid);
    const lockPath = join(storageDir, sid, "state.json.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, createdAtMs: Date.now() - 60_000 }),
      "utf8",
    );
    const staleAt = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleAt, staleAt);

    bundle.state.turnCount = 1;
    expect(manager.saveState(bundle.state)).toBe(true);
    expect(manager.resume(sid).state.turnCount).toBe(1);
  });

  it("treats a live lock as contention, then saves the same revision after release", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "session-generation-live-lock-"));
    tempDirs.push(storageDir);
    const sid = "live-lock-sid";
    const manager = new SessionManager(storageDir);
    const bundle = manager.create("/tmp/project", "model", "provider", sid);
    const target = join(storageDir, sid, "state.json");
    const release = lockSync(target, { stale: 10_000, retries: 0, realpath: false });

    bundle.state.turnCount = 1;
    expect(manager.saveState(bundle.state)).toBe(false);
    expect(bundle.state.stateRevision).toBe(0);
    release();

    expect(manager.saveState(bundle.state)).toBe(true);
    expect(manager.resume(sid).state.turnCount).toBe(1);
  });
});

describe("closing run finalization lease", () => {
  function activeRun(sid: string, beforeClose?: (host: SessionManager) => void, initialTokens = 0) {
    const storageDir = mkdtempSync(join(tmpdir(), "session-close-finalizer-"));
    tempDirs.push(storageDir);
    const writer = new SessionManager(storageDir);
    const { state } = writer.create("/tmp/project", "model", "provider", sid);
    state.activeGoal = { objective: "current goal", goalId: "goal-1", revision: 1, setAtMs: 1 };
    expect(writer.saveState(state)).toBe(true);
    writer.registerSessionGeneration(sid);
    writer.startSessionRun(state, "old-run");
    state.tokenUsage = {
      promptTokens: initialTokens,
      completionTokens: 0,
      totalTokens: initialTokens,
    };
    state.cumulativePromptTokens = initialTokens;
    expect(writer.saveState(state)).toBe(true);
    const stale = writer.readSessionState(sid)!;
    const host = new SessionManager(storageDir);
    beforeClose?.(host);
    const closingEpoch = writer.incrementSessionGeneration(sid);
    const lease = writer.createClosingRunFinalizer(sid, closingEpoch, "old-run")!;
    expect(lease?.runId).toBe("old-run");
    const commit = (fields: SessionRunFinalStatePatch) =>
      lease.commit(() => ({
        fields,
        usageDelta: {
          promptTokens: fields.tokenUsage.promptTokens - stale.tokenUsage.promptTokens,
          completionTokens: fields.tokenUsage.completionTokens - stale.tokenUsage.completionTokens,
          totalTokens: fields.tokenUsage.totalTokens - stale.tokenUsage.totalTokens,
          cacheReadTokens:
            (fields.tokenUsage.cacheReadTokens ?? 0) - (stale.tokenUsage.cacheReadTokens ?? 0),
          cacheCreationTokens:
            (fields.tokenUsage.cacheCreationTokens ?? 0) -
            (stale.tokenUsage.cacheCreationTokens ?? 0),
        },
        previousContextUsageAnchor: stale.contextUsageAnchor,
      }));
    return { writer, stale, closingEpoch, lease, commit, host, sid };
  }

  const finalFields: SessionRunFinalStatePatch = {
    status: "aborted_streaming",
    turnCount: 1,
    turnSeq: 1,
    tokenUsage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, cacheReadTokens: 4 },
    cumulativePromptTokens: 11,
    cumulativeCacheReadTokens: 4,
    cumulativeCacheCreationTokens: 0,
  };

  it("commits only run fields once without restoring the revoked writer's authority", () => {
    const f = activeRun("close-run-fields");
    f.host.updateSessionState(f.sid, {
      title: "new title",
      cwd: "/tmp/new-project",
      workspaceProfile: "new-profile",
    });
    f.host.updateActiveGoal(f.sid, { objective: "new goal", expectedRevision: 1 });
    const domain = f.host.readSessionState(f.sid)!;

    expect(f.writer.saveState(f.stale)).toBe(false);
    expect(() => f.writer.updateSessionState(f.sid, { title: "late title" })).toThrow(
      "generation conflict",
    );
    expect(
      f.commit({
        ...finalFields,
        title: "smuggled title",
        cwd: "/tmp/stale-project",
        workspaceProfile: "stale-profile",
        goalLifecycle: undefined,
        runId: "smuggled-run",
        model: "smuggled-model",
        sessionId: "smuggled-session",
      } as SessionRunFinalStatePatch),
    ).toBe(true);
    const after = f.host.readSessionState(f.sid)!;
    expect(after).toMatchObject(finalFields);
    expect(after.title).toBe(domain.title);
    expect(after.cwd).toBe(domain.cwd);
    expect(after.workspaceProfile).toBe(domain.workspaceProfile);
    expect(after.goalLifecycle).toEqual(domain.goalLifecycle);
    expect(after.runId).toBe("old-run");
    expect(after.model).toBe("model");
    expect(after.sessionId).toBe(f.sid);
    expect(f.commit({ ...finalFields, status: "model_error" })).toBe(false);
    expect(f.writer.saveStateOrUpdateFields(f.stale, { status: "model_error" }, "old-run")).toBe(
      false,
    );
  });

  it("rejects a later close epoch without changing the current state", () => {
    const f = activeRun("close-run-epoch");
    f.host.incrementSessionGeneration(f.sid);
    const before = f.host.readSessionState(f.sid);
    expect(f.commit(finalFields)).toBe(false);
    expect(f.host.readSessionState(f.sid)).toEqual(before);
    expect(f.writer.createClosingRunFinalizer(f.sid, f.closingEpoch, "old-run")).toBeUndefined();
  });

  it("rejects a durable successor run even when the close epoch is unchanged", () => {
    const f = activeRun("close-run-successor");
    f.host.startSessionRun(f.host.resume(f.sid).state, "new-run");
    const successor = f.host.readSessionState(f.sid);
    expect(f.commit(finalFields)).toBe(false);
    expect(f.host.readSessionState(f.sid)).toEqual(successor);
  });

  it("retries a revision conflict and preserves the domain writer that won", () => {
    const f = activeRun("close-run-revision");
    const internal = f.writer as any;
    const save = internal.saveStateAttempt.bind(f.writer);
    let attempts = 0;
    const probe = spyOn(internal, "saveStateAttempt").mockImplementation((...args) => {
      if (++attempts === 1) f.host.updateSessionState(f.sid, { title: "concurrent title" });
      return save(...args);
    });
    try {
      expect(f.commit(finalFields)).toBe(true);
      expect(attempts).toBe(2);
      expect(f.host.readSessionState(f.sid)).toMatchObject({
        ...finalFields,
        title: "concurrent title",
      });
    } finally {
      probe.mockRestore();
    }
  });

  it("rechecks run identity after a revision conflict before publishing anything", () => {
    const f = activeRun("close-run-revision-successor");
    const internal = f.writer as any;
    const save = internal.saveStateAttempt.bind(f.writer);
    let attempts = 0;
    const probe = spyOn(internal, "saveStateAttempt").mockImplementation((...args) => {
      if (++attempts === 1) f.host.startSessionRun(f.host.resume(f.sid).state, "new-run");
      return save(...args);
    });
    try {
      expect(f.commit(finalFields)).toBe(false);
      expect(f.host.readSessionState(f.sid)).toMatchObject({
        status: "active",
        runId: "new-run",
        turnCount: 0,
        tokenUsage: { totalTokens: 0 },
      });
    } finally {
      probe.mockRestore();
    }
  });

  it("binds the actual run identity and authorizes only one lease per close epoch", () => {
    const f = activeRun("close-run-terminal");
    expect(f.writer.createClosingRunFinalizer(f.sid, f.closingEpoch, "other-run")).toBeUndefined();
    expect(f.writer.createClosingRunFinalizer(f.sid, f.closingEpoch, "old-run")).toBeUndefined();
    expect(f.commit({ ...finalFields, status: "active" })).toBe(false);
    expect(f.commit(finalFields)).toBe(false);
    expect(f.writer.createClosingRunFinalizer(f.sid, f.closingEpoch, "old-run")).toBeUndefined();
  });

  for (const phase of ["before", "after", "both"] as const) {
    it(`preserves independent auxiliary counters and anchor written ${phase} close capture`, () => {
      const sid = `close-run-aux-${phase}`;
      const newestAnchor = {
        promptTokens: 999,
        messageCount: 9,
        estimateAtAnchor: 9,
        recordedAt: 9,
      };
      const addAux = (host: SessionManager, tokens: number) => {
        host.recordAuxiliaryUsage(sid, {
          promptTokens: tokens,
          completionTokens: 0,
          totalTokens: tokens,
        });
        host.updateSessionState(sid, { contextUsageAnchor: newestAnchor });
      };
      const f = activeRun(
        sid,
        (host) => {
          if (phase !== "after") addAux(host, 30);
        },
        100,
      );
      if (phase !== "before") addAux(f.host, 40);
      expect(
        f.commit({
          ...finalFields,
          tokenUsage: { promptTokens: 120, completionTokens: 0, totalTokens: 120 },
          cumulativePromptTokens: 120,
          contextUsageAnchor: { ...newestAnchor, recordedAt: 1, promptTokens: 120 },
        }),
      ).toBe(true);
      const total = 120 + (phase !== "after" ? 30 : 0) + (phase !== "before" ? 40 : 0);
      expect(f.host.readSessionState(sid)).toMatchObject({
        tokenUsage: { promptTokens: total, totalTokens: total },
        cumulativePromptTokens: total,
        contextUsageAnchor: newestAnchor,
      });
    });
  }
});
