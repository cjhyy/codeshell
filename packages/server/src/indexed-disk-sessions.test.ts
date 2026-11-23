import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDiskSessionState, type DiskSessionListOptions } from "./disk-session-list.js";
import { listIndexedDiskSessions } from "./indexed-disk-sessions.js";
import { listDiskSessions } from "./sessions-service.js";

let db: Database;
let directory: string;
let root: string;
let project: string;
const reads: { sql: string; rows: number }[] = [];
const storage = {
  read<T>(sql: string, args: readonly (string | number)[] = []) {
    const result = db.query(sql).all(...args);
    reads.push({ sql, rows: result.length });
    return result as T[];
  },
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,dir_mtime REAL NOT NULL,metadata_json TEXT,origin TEXT,parent_session_id TEXT,archived_at REAL);
     CREATE INDEX sessions_directory_order ON sessions(dir_mtime DESC,id);
     CREATE INDEX sessions_parent ON sessions(parent_session_id,dir_mtime DESC,id);
     CREATE INDEX sessions_archived ON sessions(archived_at);`);
  directory = mkdtempSync(join(tmpdir(), "indexed-disk-list-"));
  root = join(directory, "sessions");
  project = join(directory, "project");
  mkdirSync(root);
  mkdirSync(project);
  reads.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function persist(id: string, mtime: number, state: Record<string, unknown> | null, sink = true) {
  const row = projectDiskSessionState(id, mtime, state);
  if (sink) {
    const dir = join(root, id);
    mkdirSync(dir);
    if (state) writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    const time = new Date(mtime);
    utimesSync(dir, time, time);
    mtime = statSync(dir).mtimeMs;
    if (row) row.updatedAt = mtime;
  }
  db.query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    mtime,
    row && JSON.stringify(row),
    row?.origin ?? null,
    row?.parentSessionId ?? null,
    row?.archivedAt ?? null,
  );
}

test("file and SQLite pages preserve all fields, scope and raw offset semantics across locale ties", async () => {
  const base = { origin: "desktop", parentSessionId: null, cwd: project, title: "展示" };
  const t = 100_000;
  persist("panel-task-hidden", t + 3000, base);
  persist("qchat-hidden", t + 3000, base);
  persist("missing-state", t + 2000, null);
  persist("legacy", t + 1000, { origin: "desktop", cwd: project });
  const hiddenCwd = join(directory, "vanished");
  for (let i = 0; i < 42; i++) {
    const id = (i % 2 ? "B-" : "a_") + i;
    const state =
      i % 6 === 0
        ? { ...base, ephemeral: true }
        : i % 6 === 1
          ? { ...base, archivedAt: 400 }
          : i % 6 === 2
            ? { ...base, origin: "subagent", parentSessionId: "A-child-owner", cwd: hiddenCwd }
            : i % 6 === 3
              ? { ...base, cwd: hiddenCwd }
              : base;
    persist(id, t, state);
  }
  persist("last", t - 500, {
    ...base,
    origin: "automation",
    cwd: "",
    runId: "r",
    clientMessageId: "c",
    model: "m",
    provider: "p",
    modelConnectionId: "mc",
    workspaceProfile: "w",
    startedAt: 4000,
    status: "completed",
    lastCompletionKind: "goal_control_stop",
  });
  persist("z-hidden", t - 1000, { ...base, kind: "pet" });
  const queries: DiskSessionListOptions[] = [
    { limit: 7 },
    { limit: 7, includeSubagents: true, includeArchived: true },
    { limit: 1, cwds: [project] },
    { limit: 4, parentSessionId: "A-child-owner" },
    { limit: 4, cwds: [] },
    { limit: 1, sessionId: "last" },
    { limit: 0 },
    { limit: 1, sessionId: "qchat-hidden" },
  ];
  for (const opts of queries) {
    for (const cursor of [
      undefined,
      "0",
      "1",
      "3",
      "19",
      "43",
      "9999",
      "bogus",
      `v1:${t}:B-5`,
      `v1:${t}:gone`,
    ]) {
      const params = { ...opts, cursor };
      expect(await listIndexedDiskSessions(storage, params)).toStrictEqual(
        await listDiskSessions(params, root),
      );
    }
    let cursor: string | undefined;
    do {
      const page = await listDiskSessions({ ...opts, cursor }, root);
      expect(await listIndexedDiskSessions(storage, { ...opts, cursor })).toStrictEqual(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
});

test("filesystem visibility stays live after indexing and corrupt/unavailable projections fall back", async () => {
  const state = { parentSessionId: null, cwd: project, origin: "desktop", title: "first" };
  persist("s", 120_000, state);
  expect((await listIndexedDiskSessions(storage, { limit: 1 }))?.sessions).toHaveLength(1);
  rmSync(project, { recursive: true });
  expect((await listIndexedDiskSessions(storage, { limit: 1 }))?.sessions).toHaveLength(0);
  mkdirSync(project);
  db.query("UPDATE sessions SET metadata_json = ?").run('{"id":"another"}');
  expect(await listIndexedDiskSessions(storage, { limit: 1 })).toBeNull();
  expect(await listIndexedDiskSessions({ read: () => null }, { limit: 1 })).toBeNull();
  expect(projectDiskSessionState("../s", 1, state)).toBeNull();
  expect(projectDiskSessionState("s", 1, { ...state, parentSessionId: "../unsafe" })).toBeNull();
  await expect(listIndexedDiskSessions(storage, { limit: 1, sessionId: "../s" })).rejects.toThrow(
    "invalid session id",
  );
});

test("a page seeks the ordered index without fetching metadata from unrelated directories", async () => {
  const state = { parentSessionId: null, cwd: "", origin: "desktop" };
  const last = 1_001_000;
  for (let i = 0; i < 600; i++) persist("id-" + i, last - i, state, false);
  persist(
    "s-child",
    last - 700,
    { ...state, parentSessionId: "parent", origin: "subagent" },
    false,
  );
  const result = await listIndexedDiskSessions(storage, { limit: 2, cursor: "v1:1000800:id-200" });
  expect(result?.sessions.map((s) => s.id)).toEqual(["id-201", "id-202"]);
  expect(Math.max(...reads.map((r) => r.rows))).toBeLessThan(50);
  const page = reads.find((r) => r.sql.includes("ORDER BY dir_mtime DESC, id LIMIT"))!;
  const plan = db
    .query("EXPLAIN QUERY PLAN " + page.sql)
    .all(1000800, 33)
    .map((row) => JSON.stringify(row))
    .join(" ");
  expect(plan).not.toContain("TEMP B-TREE");
  expect(plan).toContain("sessions_directory_order");
  reads.length = 0;
  expect(
    (await listIndexedDiskSessions(storage, { limit: 2, parentSessionId: "parent" }))?.sessions.map(
      (s) => s.id,
    ),
  ).toEqual(["s-child"]);
  expect(reads.find((r) => r.sql.includes("metadata_json AS metadata"))?.rows).toBe(1);
});
