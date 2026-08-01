// Crash-recovery boundaries. Both cases here were live bugs:
//
//  1. A run whose owning process is STILL ALIVE but whose heartbeat happened to
//     be stale was force-unlocked and re-queued, so the same run could execute
//     twice. The documented contract is "stale AND dead → recover"; the code
//     said `if (processAlive && !stale) continue`, which only skips when BOTH
//     look healthy.
//  2. `recover()` used `store.list({ status })`, whose default page size is 50
//     (it backs a UI list). With 55 stale runs, 5 stayed pinned in "running"
//     forever — recovery only runs at startup, so nothing revisited them.
//
// Heartbeats are written as REAL files with a chosen pid/timestamp rather than
// stubbing Heartbeat, so these exercise the same disk reads production uses.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager } from "./RunManager.js";
import { FileRunStore } from "./FileRunStore.js";
import type { RunExecutor } from "./EngineRunner.js";
import type { RunSnapshot } from "./types.js";

const dirs: string[] = [];
const managers: RunManager[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rm-recover-"));
  dirs.push(d);
  return d;
}

/** Track every manager so teardown can stop its heartbeats and release locks. */
function manager(config: { store: FileRunStore; runsDir: string }): RunManager {
  const created = new RunManager({ ...config, executor: parkedExecutor });
  managers.push(created);
  return created;
}

afterEach(async () => {
  // Shut down BEFORE deleting the dir. recover() re-queues runs and RunQueue
  // drains immediately, so the parked executor leaves runs mid-flight with live
  // heartbeat timers and lock files. Removing the tmpdir underneath them raised
  // an unhandled ENOENT on `<run>/run.json.lock` — reported as `1 error`, which
  // fails `bun test` even with 0 failed assertions.
  for (const m of managers.splice(0)) {
    try {
      await m.shutdown();
    } catch {
      // Teardown is best-effort; a failed release must not mask the real result.
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// recover() re-queues runs, and RunQueue drains immediately, so an executor here
// WILL be invoked after recovery. Park forever instead of throwing: these tests
// assert on the recovery decision, and a throwing executor would spin retries
// (and keep touching the tmpdir) after the test body finished.
const parkedExecutor: RunExecutor = {
  execute() {
    return new Promise(() => undefined);
  },
};

function runningSnapshot(runId: string): RunSnapshot {
  const now = Date.now();
  return {
    runId,
    objective: "x",
    cwd: "/tmp/proj",
    status: "running",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  } as RunSnapshot;
}

/** Write a heartbeat file directly, choosing pid and age. */
function writeHeartbeat(
  runsDir: string,
  runId: string,
  opts: { pid: number; ageMs: number },
): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "heartbeat"),
    JSON.stringify({ pid: opts.pid, timestamp: Date.now() - opts.ageMs, runId }),
    "utf-8",
  );
}

// A pid that is essentially certainly not running, so isProcessAlive() is false.
const DEAD_PID = 0x7ffffff0;

describe("RunManager.recover() liveness rules", () => {
  test("does NOT recover a run whose process is alive but heartbeat is stale", async () => {
    const dir = tmp();
    const store = new FileRunStore(dir);
    const mgr = manager({ store, runsDir: dir });

    await store.create(runningSnapshot("run-alive-stale"));
    // Current process owns it (alive), but the heartbeat is well past the
    // staleness threshold. Liveness must veto recovery.
    writeHeartbeat(dir, "run-alive-stale", { pid: process.pid, ageMs: 60_000 });

    const recovered = await mgr.recover();

    expect(recovered).not.toContain("run-alive-stale");
    expect((await store.get("run-alive-stale"))?.status).toBe("running");
  });

  test("recovers a run that is both stale and dead", async () => {
    const dir = tmp();
    const store = new FileRunStore(dir);
    const mgr = manager({ store, runsDir: dir });

    await store.create(runningSnapshot("run-dead"));
    writeHeartbeat(dir, "run-dead", { pid: DEAD_PID, ageMs: 60_000 });

    const recovered = await mgr.recover();

    expect(recovered).toContain("run-dead");
    expect((await store.get("run-dead"))?.status).toBe("queued");
  });

  test("does NOT recover a dead process whose heartbeat is still recent", async () => {
    // Heartbeat recent → the owner may just have been restarted mid-write;
    // wait for it to actually go stale rather than racing it.
    const dir = tmp();
    const store = new FileRunStore(dir);
    const mgr = manager({ store, runsDir: dir });

    await store.create(runningSnapshot("run-fresh-dead"));
    writeHeartbeat(dir, "run-fresh-dead", { pid: DEAD_PID, ageMs: 0 });

    const recovered = await mgr.recover();

    expect(recovered).not.toContain("run-fresh-dead");
    expect((await store.get("run-fresh-dead"))?.status).toBe("running");
  });
});

describe("RunManager.recover() pagination", () => {
  test("recovers every stale run past the store's default 50-row page", async () => {
    const dir = tmp();
    const store = new FileRunStore(dir);
    const mgr = manager({ store, runsDir: dir });

    const total = 55;
    const ids: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const runId = `run-stale-${String(i).padStart(3, "0")}`;
      ids.push(runId);
      await store.create(runningSnapshot(runId));
      writeHeartbeat(dir, runId, { pid: DEAD_PID, ageMs: 60_000 });
    }

    const recovered = await mgr.recover();

    // The bug recovered exactly 50 and silently abandoned the rest.
    expect(recovered).toHaveLength(total);
    expect(new Set(recovered).size).toBe(total);
    expect(new Set(recovered)).toEqual(new Set(ids));
    // Assert on the recovery DECISION (the returned id set above), not on a
    // post-recovery status: recover() re-queues and RunQueue drains immediately,
    // so a re-queued run is legitimately back in "running" under this parked
    // executor. Every stale run being reported as recovered is exactly the
    // property the dropped 50-row page violated.
    //
    // Also confirm the pager really did see past one page, so this test cannot
    // pass just because the default page size changed.
    expect(total).toBeGreaterThan((await store.list({ status: "running" })).length);
  });
});
