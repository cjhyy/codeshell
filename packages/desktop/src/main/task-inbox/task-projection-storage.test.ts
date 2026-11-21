import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStateStorage, type StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { createTaskInboxStore } from "./task-inbox-store.js";
import { mapTaskInboxRecord } from "./task-inbox-mappers.js";
import type { TaskInboxSnapshot } from "./task-inbox-types.js";

const stores: StateStorage[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const task = (id: string, overrides: Partial<ReturnType<typeof mapTaskInboxRecord>> = {}) =>
  mapTaskInboxRecord({
    source: "session",
    sourceId: id,
    sessionId: id,
    status: "done",
    title: id,
    createdAt: 1,
    updatedAt: 2,
    sourceRevision: "1",
    ...overrides,
  });
async function fixture() {
  const d = await mkdtemp(join(tmpdir(), "codeshell-task-projection-"));
  roots.push(d);
  const dir = join(d, "data", "task-inbox"),
    root = join(d, "worker", "sessions");
  await mkdir(dir, { recursive: true });
  const entry = join(d, "worker.mjs");
  const core = import.meta.resolve("@cjhyy/code-shell-core/internal/storage");
  const handler = new URL("./task-projection-storage.ts", import.meta.url).href;
  await writeFile(
    entry,
    `import {serveStorageWorker} from ${JSON.stringify(core)};
    import {createTaskInboxStorageHandlers} from ${JSON.stringify(handler)};
    await serveStorageWorker(createTaskInboxStorageHandlers());`,
  );
  const open = async () => {
    const s = await openStateStorage(root, {
      workerUrl: pathToFileURL(entry),
      workerConfig: { taskInboxDirectory: dir },
    });
    stores.push(s);
    return s;
  };
  return { open, dir, root, d };
}
async function snapshot(s: StateStorage, visibility = "visible") {
  const r = await s.request<TaskInboxSnapshot>("tasks/snapshot", { visibility });
  if (!r) throw new Error("Task storage unavailable");
  return r;
}
const ingest = (s: StateStorage, records: ReturnType<typeof task>[], complete = false) =>
  s.request("tasks/reconcile", { sources: [{ source: "session", records, complete }] });
const intent = (s: StateStorage, p: unknown) => s.request("tasks/intent", p);

test("dirty merges freeze hidden rows, limit deletion to eligible states and only revive on an explicit foreground run", async () => {
  const f = await fixture(),
    s = await f.open();
  expect(s.mode).toBe("sqlite");
  await ingest(
    s,
    [
      task("one"),
      task("paused", { status: "paused" }),
      task("interrupted", { status: "interrupted" }),
    ],
    true,
  );
  await intent(s, { type: "hide", taskKey: "session:one", expectedRevision: "1" });
  await ingest(s, [task("one", { title: "renamed", updatedAt: 20, sourceRevision: "2" })]);
  expect((await snapshot(s, "hidden")).records).toMatchObject([{ title: "renamed", updatedAt: 2 }]);
  await expect(
    intent(s, { type: "delete", taskKey: "session:paused", expectedRevision: "1" }),
  ).rejects.toThrow("ended or interrupted");
  await intent(s, { type: "delete", taskKey: "session:interrupted", expectedRevision: "1" });
  await ingest(s, [task("interrupted", { status: "running", updatedAt: 30, sourceRevision: "2" })]);
  expect((await snapshot(s, "all")).records.map((r) => r.sessionId)).not.toContain("interrupted");
  await intent(s, { type: "userContinued", sessionId: "interrupted" });
  await ingest(s, [task("interrupted", { status: "running", updatedAt: 40, sourceRevision: "3" })]);
  expect((await snapshot(s)).records.map((r) => r.sessionId)).toContain("interrupted");
  await intent(s, { type: "sessionArchived", sessionId: "one" });
  await intent(s, { type: "sessionUnarchived", sessionId: "one" });
  expect((await snapshot(s, "hidden")).records).toHaveLength(1);
  await intent(s, { type: "sessionDeleted", sessionId: "one" });
  await ingest(s, [task("one", { updatedAt: 99, sourceRevision: "3" })]);
  expect((await snapshot(s, "all")).records.map((r) => r.sessionId)).not.toContain("one");
});

test("0.11 external task navigation survives migration, owner disappearance, downgrade and SQLite quarantine", async () => {
  const f = await fixture(),
    legacy = join(f.dir, "v1.json");
  const retained = task("cli", {
    source: "external-runtime",
    externalCli: "codex",
    workspacePath: "/fixture",
    status: "running",
    capabilities: ["open", "cancel"],
  });
  await writeFile(
    legacy,
    JSON.stringify({ schemaVersion: 1, version: 3, errors: [], records: [retained] }),
  );
  const s = await f.open();
  await s.request("tasks/reconcile", {
    sources: [{ source: "external-runtime", complete: true, records: [] }],
  });
  await ingest(s, [task("current")]);
  await intent(s, { type: "hide", taskKey: "external-runtime:cli", expectedRevision: "1" });
  await s.request("tasks/flush");
  const old = createTaskInboxStore({ filePath: legacy }).load();
  expect(old.records).toMatchObject([
    {
      taskKey: "external-runtime:cli",
      externalCli: "codex",
      workspacePath: "/fixture",
      capabilities: ["open"],
      status: "interrupted",
    },
  ]);
  const file = s.read<{ file: string }>("PRAGMA database_list")![0].file;
  await s.close();
  await writeFile(file, "damaged test sqlite");
  const restored = await f.open();
  expect(restored.mode).toBe("sqlite");
  expect((await snapshot(restored, "hidden")).records.map((r) => r.taskKey)).toEqual([
    "external-runtime:cli",
  ]);
  expect((await snapshot(restored)).records).toEqual([]);
});

test("JSON fallback persists intent atomically and imports the degraded projection after recovery", async () => {
  const f = await fixture();
  await mkdir(dirname(f.root), { recursive: true });
  await writeFile(f.root, "fixture blocks SQLite");
  const s = await f.open();
  expect(s.mode).toBe("json");
  await ingest(s, [task("one"), task("two")]);
  await intent(s, { type: "delete", taskKey: "session:one", expectedRevision: "1" });
  await s.close();
  const image = JSON.parse(await readFile(join(f.dir, "user-state.json"), "utf8"));
  expect(image.intents).toMatchObject([
    { taskKey: "session:one", deletedRevision: "1", deletedActivityAt: 2 },
  ]);
  await rm(f.root);
  const t = await f.open();
  expect(t.mode).toBe("sqlite");
  await ingest(t, [task("one"), task("two")]);
  expect((await snapshot(t)).records.map((r) => r.sessionId)).toEqual(["two"]);
  expect(
    JSON.parse(await readFile(join(f.dir, "user-state.json"), "utf8")).fallback,
  ).toBeUndefined();
});

test("full and per-key input converge, timestamp-only streaming does not rewrite, and cold resumable tasks survive the terminal cap", async () => {
  const fullFixture = await fixture(),
    deltaFixture = await fixture();
  const a = await fullFixture.open(),
    b = await deltaFixture.open();
  const seed = Array.from({ length: 32 }, (_, i) =>
    task(String(i), { status: "running", runId: "run-" + i }),
  );
  await ingest(a, seed, true);
  for (const r of seed) await ingest(b, [r]);
  const changed = seed.map((r, i) =>
    i % 3 === 0 ? { ...r, status: "done" as const, updatedAt: 10, sourceRevision: "2" } : r,
  );
  await ingest(a, changed, true);
  for (const r of changed.filter((_, i) => i % 3 === 0).reverse()) await ingest(b, [r]);
  const ordered = async (s: StateStorage) =>
    (await snapshot(s)).records.sort((l, r) => l.taskKey.localeCompare(r.taskKey));
  expect(await ordered(a)).toEqual(await ordered(b));
  const stable = (await snapshot(b)).version;
  await ingest(b, [{ ...seed[1], updatedAt: 250 }]);
  expect((await snapshot(b)).version).toBe(stable);
  await ingest(a, [
    ...Array.from({ length: 2020 }, (_, i) => task("ended-" + i, { updatedAt: 100 + i })),
    task("paused", { status: "paused" }),
    task("interrupted", { status: "interrupted" }),
  ]);
  expect(a.read("SELECT count(*) AS n FROM tasks WHERE status='done'")).toEqual([{ n: 2000 }]);
  await intent(a, { type: "clear", before: 130 });
  const left = await ordered(a);
  expect(left.filter((r) => r.status === "done").every((r) => r.updatedAt >= 130)).toBe(true);
  expect(left.map((r) => r.status)).toContain("paused");
  expect(left.map((r) => r.status)).toContain("interrupted");
});
