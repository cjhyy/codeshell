import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskInboxStore } from "./task-inbox-store.js";
import { createTaskInboxProjector } from "./task-inbox-projector.js";
import { mapTaskInboxRecord } from "./task-inbox-mappers.js";

const dirs: string[] = [];
const task = (overrides = {}) =>
  mapTaskInboxRecord({
    source: "session",
    sourceId: "s1",
    title: "Task",
    status: "running",
    sourceRevision: "1",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
const store = () => {
  const directory = mkdtempSync(join(tmpdir(), "task-projector-"));
  dirs.push(directory);
  return createTaskInboxStore({ filePath: join(directory, "v1.json") });
};
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("task inbox authoritative reconciliation", () => {
  test("startup terminal authority corrects old running; replay and identical reconcile broadcast once", async () => {
    const data = store();
    data.upsert(task());
    const terminal = task({ status: "done", updatedAt: 10, sourceRevision: "2" });
    const projector = createTaskInboxProjector({
      store: data,
      readers: [{ source: "session", read: () => [terminal] }],
    });
    let events = 0;
    projector.subscribe(() => {
      events++;
    });
    await projector.reconcile();
    for (let i = 0; i < 10; i++) {
      projector.ingest(terminal);
      await projector.reconcile();
    }
    expect(projector.get("session:s1")?.status).toBe("done");
    expect(events).toBe(1);
    const version = projector.snapshot().version;
    await projector.reconcile();
    expect(projector.snapshot().version).toBe(version);
  });
  test("one failed source preserves stale rows while other sources progress", async () => {
    const data = store();
    data.upsert(task({ source: "mimi-delegation", sourceId: "m1" }));
    const projector = createTaskInboxProjector({
      store: data,
      readers: [
        {
          source: "mimi-delegation",
          read: () => {
            throw new Error("Ledger unavailable");
          },
        },
        { source: "session", read: () => [task({ status: "done", updatedAt: 12 })] },
      ],
    });
    const snapshot = await projector.reconcile();
    expect(snapshot.errors).toEqual([{ source: "mimi-delegation", message: "Ledger unavailable" }]);
    expect(projector.get("mimi-delegation:m1")).toMatchObject({ status: "running", stale: true });
    expect(projector.get("session:s1")?.status).toBe("done");
  });
  test("missing volatile tasks become interrupted and lose live write capabilities", async () => {
    const data = store();
    data.upsert(task({ source: "background-shell", capabilities: ["open", "cancel"] }));
    const projector = createTaskInboxProjector({
      store: data,
      readers: [{ source: "background-shell", read: () => [] }],
    });
    await projector.reconcile();
    expect(projector.get("background-shell:s1")).toMatchObject({
      status: "interrupted",
      stale: true,
      capabilities: ["open"],
    });
    const version = projector.snapshot().version;
    await projector.reconcile();
    expect(projector.snapshot().version).toBe(version);
    projector.ingest(
      task({ source: "background-shell", status: "done", updatedAt: 20, sourceRevision: "2" }),
    );
    await projector.reconcile();
    expect(projector.get("background-shell:s1")?.status).toBe("done");
  });
  test("concurrent scans coalesce and a delayed old snapshot cannot undo newer live completion", async () => {
    let release!: (value: ReturnType<typeof task>[]) => void;
    let reads = 0;
    const projector = createTaskInboxProjector({
      store: store(),
      readers: [
        {
          source: "session",
          read: () => {
            reads++;
            return new Promise((resolve) => {
              release = resolve;
            });
          },
        },
      ],
    });
    const first = projector.reconcile();
    const second = projector.reconcile();
    projector.ingest(task({ status: "done", sourceRevision: "2", updatedAt: 20 }));
    release([task()]);
    await Promise.all([first, second]);
    expect(reads).toBe(1);
    expect(projector.get("session:s1")?.status).toBe("done");
  });
  test("malformed source output stays local and a recovered source clears stale/error", async () => {
    const data = store();
    data.upsert(task());
    let bad = true;
    const projector = createTaskInboxProjector({
      store: data,
      readers: [
        { source: "session", read: () => (bad ? [task({ source: "legacy-run" })] : [task()]) },
      ],
    });
    expect((await projector.reconcile()).errors).toHaveLength(1);
    bad = false;
    expect((await projector.reconcile()).errors).toHaveLength(0);
    expect(projector.get("session:s1")?.stale).toBeUndefined();
  });
});
