import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskInboxStore } from "./task-inbox-store.js";
import { mapTaskInboxRecord } from "./task-inbox-mappers.js";

const task = (sourceId: string, overrides = {}) =>
  mapTaskInboxRecord({
    source: "session",
    sourceId,
    title: `Task ${sourceId}`,
    status: "running",
    sourceRevision: "1",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
const dirs: string[] = [];
function setup(terminalLimit = 2000) {
  const directory = mkdtempSync(join(tmpdir(), "task-inbox-"));
  dirs.push(directory);
  const filePath = join(directory, "v1.json");
  return { directory, filePath, store: createTaskInboxStore({ filePath, terminalLimit }) };
}
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("task inbox persistent projection", () => {
  test("persists 0600 across instances without dropping another writer's changes", () => {
    const { filePath, store } = setup();
    const other = createTaskInboxStore({ filePath });
    store.upsert(task("one"));
    other.upsert(task("two"));
    store.upsert(task("three"));
    expect(other.snapshot().records.map((row) => row.sourceId)).toEqual(["one", "three", "two"]);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(filePath, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  test("replay and reads do not rewrite the file or increment version", () => {
    const { filePath, store } = setup();
    const record = task("one");
    store.upsert(record);
    const initial = statSync(filePath).mtimeMs;
    const version = store.snapshot().version;
    for (let i = 0; i < 10; i++) store.upsert(record);
    store.list();
    store.get(record.taskKey);
    store.load();
    expect(store.snapshot().version).toBe(version);
    expect(store.snapshot().records).toHaveLength(1);
    expect(statSync(filePath).mtimeMs).toBe(initial);
  });
  test("all active and waiting tasks survive the 2000-terminal bound", () => {
    const { store } = setup();
    store.upsertMany([
      ...Array.from({ length: 2050 }, (_, i) =>
        task(`terminal-${i}`, { status: "done", updatedAt: i + 2 }),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        task(`active-${i}`, { status: i % 2 ? "waiting" : "running" }),
      ),
    ]);
    const records = store.snapshot().records;
    expect(records).toHaveLength(2050);
    expect(records.filter((row) => row.sourceId.startsWith("active-"))).toHaveLength(50);
    expect(records.some((row) => row.sourceId === "terminal-0")).toBe(false);
    expect(records.some((row) => row.sourceId === "terminal-2049")).toBe(true);
  });
  test("truncated JSON is quarantined byte-for-byte before rebuild", () => {
    const { filePath, directory, store } = setup();
    const raw = '{"schemaVersion":1,"records":[';
    writeFileSync(filePath, raw, { mode: 0o600 });
    expect(store.load().records).toEqual([]);
    const quarantined = readdirSync(directory).find((name) => name.endsWith(".corrupt"))!;
    expect(readFileSync(join(directory, quarantined), "utf8")).toBe(raw);
    store.upsert(task("recovered"));
    expect(store.load().records[0].sourceId).toBe("recovered");
  });
  test("bad and unknown-field entries are quarantined individually while valid records survive", () => {
    const { filePath, directory, store } = setup();
    const raw = JSON.stringify({
      schemaVersion: 1,
      version: 8,
      records: [task("valid"), { ...task("unknown"), extra: 1 }, { broken: true }],
      errors: [],
    });
    writeFileSync(filePath, raw);
    expect(store.load().records.map((row) => row.sourceId)).toEqual(["valid"]);
    expect(store.load().version).toBe(9);
    const quarantines = readdirSync(directory).filter((name) => name.endsWith(".corrupt"));
    expect(quarantines).toHaveLength(1);
    expect(readFileSync(join(directory, quarantines[0]), "utf8")).toBe(raw);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
  test("terminal fences reject out-of-order snapshots and preserve attempts", () => {
    const { store } = setup();
    store.upsert(task("one", { attempt: 0, status: "done", updatedAt: 20 }));
    store.upsert(task("one", { attempt: 0, updatedAt: 10 }));
    store.upsert(task("one", { attempt: 1, updatedAt: 21 }));
    expect(store.get("session:one:0")?.status).toBe("done");
    expect(store.get("session:one:1")?.status).toBe("running");
  });
  test("list filters and paginates a stable version; changed cursor restarts safely", () => {
    const { store } = setup();
    store.upsertMany([
      task("a", { status: "waiting", projectId: "p", title: "Review" }),
      task("b", { projectId: "p", title: "Build" }),
      task("c", { projectId: "other" }),
    ]);
    const first = store.list({ limit: 1, projectId: "p" });
    expect(first.records[0].sourceId).toBe("a");
    expect(
      store.list({ limit: 1, projectId: "p", cursor: first.nextCursor }).records[0].sourceId,
    ).toBe("b");
    expect(store.list({ search: "REVIEW" }).records.map((row) => row.sourceId)).toEqual(["a"]);
    store.upsert(task("d", { status: "waiting", updatedAt: 50 }));
    expect(store.list({ cursor: first.nextCursor, limit: 1 }).records[0].sourceId).toBe("d");
  });
});
