import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRunStore } from "./FileRunStore.js";
import { RunManager } from "./RunManager.js";
import { RunLock } from "./RunLock.js";
import type { RunEvent, RunSnapshot } from "./types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const directories: string[] = [];
const managers: RunManager[] = [];
const handle = {
  resolveApproval: () => false,
  resolveInput: () => false,
  hasPendingApproval: () => false,
  hasPendingInput: () => false,
};
const outcome = {
  result: { text: "done", reason: "completed" as const, sessionId: "session", turnCount: 1 },
  handle,
};

function directory() {
  const dir = mkdtempSync(join(tmpdir(), "run-execution-race-"));
  directories.push(dir);
  return dir;
}

async function idle(manager: RunManager) {
  const queue = (manager as unknown as { queue: { activeCount: number; pendingCount: number } })
    .queue;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (queue.activeCount === 0 && queue.pendingCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run queue did not settle");
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RunManager execution boundaries", () => {
  test("an async subscriber rejection is isolated and unsubscribes the broken listener", async () => {
    const dir = directory();
    const manager = new RunManager({
      store: new FileRunStore(dir),
      runsDir: dir,
      concurrency: 0,
      executor: {
        async execute() {
          return outcome;
        },
      },
    });
    managers.push(manager);
    const { runId } = await manager.submit({ objective: "isolate subscribers" });
    let failedCalls = 0;
    let healthyCalls = 0;
    manager.attach(runId, async () => {
      failedCalls += 1;
      throw new Error("subscriber disconnected");
    });
    manager.attach(runId, () => {
      healthyCalls += 1;
    });

    await manager.cancel(runId);
    expect(failedCalls).toBe(1);
    expect(healthyCalls).toBe(2);
    expect((await manager.get(runId))?.status).toBe("cancelled");
  });

  test("cancel queues behind a pending snapshot write and cannot be overwritten by it", async () => {
    const dir = directory();
    const writing = deferred();
    const releaseWrite = deferred();
    class DelayedSnapshotStore extends FileRunStore {
      override async update(run: RunSnapshot) {
        if (run.status === "running") {
          writing.resolve();
          await releaseWrite.promise;
        }
        await super.update(run);
      }
    }
    let executions = 0;
    const manager = new RunManager({
      store: new DelayedSnapshotStore(dir),
      runsDir: dir,
      executor: {
        async execute() {
          executions += 1;
          return outcome;
        },
      },
    });
    managers.push(manager);
    const { runId } = await manager.submit({ objective: "cancel while writing" });
    await writing.promise;
    const cancelled = manager.cancel(runId);
    releaseWrite.resolve();
    await cancelled;
    await idle(manager);

    expect(executions).toBe(0);
    expect((await manager.get(runId))?.status).toBe("cancelled");
  });

  test("cancel while the start event is being saved prevents executor invocation", async () => {
    const dir = directory();
    const reachedStart = deferred();
    const releaseStart = deferred();
    class DelayedStartStore extends FileRunStore {
      override async appendEvent(event: RunEvent) {
        if (event.type === "run_started") {
          reachedStart.resolve();
          await releaseStart.promise;
        }
        await super.appendEvent(event);
      }
    }
    const store = new DelayedStartStore(dir);
    let executions = 0;
    const manager = new RunManager({
      store,
      runsDir: dir,
      executor: {
        async execute() {
          executions += 1;
          return outcome;
        },
      },
    });
    managers.push(manager);
    const { runId } = await manager.submit({ objective: "cancel before execution" });
    await reachedStart.promise;
    try {
      await manager.cancel(runId);
    } finally {
      releaseStart.resolve();
    }
    await idle(manager);
    expect(executions).toBe(0);
    expect((await manager.get(runId))?.status).toBe("cancelled");
  });

  test("cancel during evaluation remains terminal after the evaluator returns", async () => {
    const dir = directory();
    const evaluating = deferred();
    const releaseEvaluation = deferred();
    const manager = new RunManager({
      store: new FileRunStore(dir),
      runsDir: dir,
      executor: {
        async execute() {
          return outcome;
        },
      },
      evaluator: {
        name: "delayed",
        async evaluate() {
          evaluating.resolve();
          await releaseEvaluation.promise;
          return { verdict: "passed", findings: [] };
        },
      },
    });
    managers.push(manager);
    const { runId } = await manager.submit({ objective: "cancel during evaluation" });
    await evaluating.promise;
    try {
      await manager.cancel(runId);
    } finally {
      releaseEvaluation.resolve();
    }
    await idle(manager);
    expect((await manager.get(runId))?.status).toBe("cancelled");
    const events = await manager.getEvents(runId);
    expect(events.filter((event) => event.type === "run_cancelled")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run_completed")).toHaveLength(0);
  });

  test("a failed startup write releases the heartbeat and run lock", async () => {
    const dir = directory();
    class FailingStartStore extends FileRunStore {
      private fail = true;
      override async update(run: RunSnapshot) {
        if (this.fail && run.status === "running") {
          this.fail = false;
          throw new Error("startup write unavailable");
        }
        await super.update(run);
      }
    }
    const manager = new RunManager({
      store: new FailingStartStore(dir),
      runsDir: dir,
      executor: {
        async execute() {
          return outcome;
        },
      },
    });
    managers.push(manager);
    const { runId } = await manager.submit({ objective: "recover failed startup" });
    await idle(manager);

    expect((await manager.get(runId))?.status).toBe("blocked");
    expect(existsSync(join(dir, runId, "heartbeat"))).toBe(false);
    expect(await new RunLock({ runsDir: dir }).isLocked(runId)).toBe(false);
  });
});
