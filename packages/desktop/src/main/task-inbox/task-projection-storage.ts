import { isAbsolute, join } from "node:path";
import type {
  StorageWorkerContext,
  StorageWorkerHandlers,
} from "@cjhyy/code-shell-core/internal/storage";
import {
  checkedTaskObject,
  checkedTaskText,
  isTaskSource,
  parseTaskInboxRecord,
  type TaskInboxRecordV1,
  type TaskInboxSourceError,
} from "./task-inbox-types.js";
import {
  checkedBatches,
  checkedIntent,
  changeTaskIntent,
  displayTask,
  reconcileTasks,
  taskSnapshot,
  upsertTask,
} from "./task-projection.js";
import {
  JsonTaskRows,
  SqlTaskRows,
  type ProjectionHeader,
  type TaskMirror,
  type TaskRow,
  type TaskRows,
} from "./task-projection-rows.js";

const MAX_BYTES = 64 * 1024 * 1024;
interface Mirror extends TaskMirror {
  fallback?: { rows: TaskRow[]; header: ProjectionHeader };
}
const emptyMirror = (): Mirror => ({ schemaVersion: 1, version: 0, intents: [], sessions: [] });
const serialize = (v: unknown) => JSON.stringify(v) + "\n";
const checkedTime = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
function checkedErrors(input: unknown): TaskInboxSourceError[] {
  if (!Array.isArray(input)) throw new Error("Invalid task source errors");
  return input.map((e) => {
    if (!isTaskSource(e?.source)) throw new Error("Invalid task source");
    return { source: e.source, message: checkedTaskText(e.message, "source error", 2048, true) };
  });
}
function parseMirror(raw: string | undefined): Mirror {
  if (raw === undefined) return emptyMirror();
  const m = JSON.parse(raw) as Mirror;
  if (
    m?.schemaVersion !== 1 ||
    !checkedTime(m.version) ||
    !Array.isArray(m.intents) ||
    !Array.isArray(m.sessions)
  )
    throw new Error("Invalid task intent mirror");
  for (const i of m.intents) {
    checkedTaskText(i.taskKey, "task key", 1100);
    if (i.sessionId !== undefined) checkedTaskText(i.sessionId, "session", 512);
    for (const key of ["hiddenAt", "frozenActivityAt", "deletedAt", "deletedActivityAt"] as const)
      if (i[key] !== undefined && !checkedTime(i[key])) throw new Error("Invalid task intent time");
    if (
      i.deletedAt === undefined &&
      (i.hiddenAt === undefined ||
        (i.hiddenReason !== "user" && i.hiddenReason !== "session-archived"))
    )
      throw new Error("Invalid task intent");
    if (i.deletedAt !== undefined) checkedTaskText(i.deletedRevision, "revision", 1024);
  }
  for (const [session, state] of m.sessions) {
    checkedTaskText(session, "session", 512);
    if (state !== "archived" && state !== "deleted") throw new Error("Invalid task session intent");
  }
  if (m.fallback) {
    if (!Array.isArray(m.fallback.rows) || !checkedTime(m.fallback.header?.version))
      throw new Error("Invalid JSON task projection");
    m.fallback.header.errors = checkedErrors(m.fallback.header.errors);
    for (const row of m.fallback.rows) {
      row.record = parseTaskInboxRecord(row.record);
      if (
        typeof row.activityAt !== "number" ||
        !Number.isFinite(row.activityAt) ||
        typeof row.projectionOnly !== "boolean"
      )
        throw new Error("Invalid JSON task row");
    }
  }
  return m;
}

function applyMirror(rows: TaskRows, m: TaskMirror) {
  const existing = rows.mirror(0);
  for (const i of existing.intents) rows.setIntent(i.taskKey, undefined);
  for (const [id] of existing.sessions) rows.setPolicy(id, undefined);
  for (const [id, state] of m.sessions) rows.setPolicy(id, state);
  for (const i of m.intents) {
    rows.setIntent(i.taskKey, i);
    if (i.deletedAt !== undefined) rows.remove(i.taskKey);
  }
  for (const [id, state] of m.sessions)
    if (state === "deleted")
      for (const row of rows.rows({ session: id })) rows.remove(row.record.taskKey);
}
function fallbackRows(m: Mirror): JsonTaskRows {
  const rows = new JsonTaskRows();
  if (m.fallback) {
    for (const row of m.fallback.rows) rows.put(row);
    rows.setHeader({ ...m.fallback.header, intentVersion: m.version });
  }
  rows.setHeader({ ...rows.header(), intentVersion: m.version });
  applyMirror(rows, m);
  return rows;
}

const legacyLimit = 2000;
export function createTaskInboxStorageHandlers(): StorageWorkerHandlers {
  let dir: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: StorageWorkerContext | undefined;
  let mirrorDirty = false;
  let initialized = false;
  function withMirror<T>(
    ctx: StorageWorkerContext,
    fn: (m: Mirror) => { value?: Mirror; result: T },
  ): T {
    if (!dir) throw new Error("Desktop task directory unavailable");
    return ctx.mutateJsonFile<Mirror, T>(join(dir, "user-state.json"), {
      parse: parseMirror,
      serialize,
      mode: 0o600,
      maxBytes: MAX_BYTES,
      mutation: fn,
    }) as T;
  }
  function importLegacy(ctx: StorageWorkerContext) {
    if (!dir) throw new Error("Desktop task directory unavailable");
    return ctx.mutateJsonFile(join(dir, "v1.json"), {
      maxBytes: MAX_BYTES,
      mode: 0o600,
      serialize,
      parse: (raw) => {
        if (raw === undefined) return { schemaVersion: 1, version: 0, records: [], errors: [] };
        const v = JSON.parse(raw);
        if (v?.schemaVersion !== 1 || !checkedTime(v.version) || !Array.isArray(v.records))
          throw new Error("Invalid 0.11 task projection");
        return {
          schemaVersion: 1,
          version: v.version,
          records: v.records.map(parseTaskInboxRecord) as TaskInboxRecordV1[],
          errors: checkedErrors(v.errors),
        };
      },
      mutation: (value) => ({ result: value }),
    })!;
  }
  function flush(ctx: StorageWorkerContext) {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!dir || !mirrorDirty) return;
    // Read SQL after acquiring the mirror mutex. A delayed flush from a second
    // host cannot replace a newer revision with an older snapshot.
    const degraded = ctx.db ? undefined : withMirror(ctx, (m) => ({ result: fallbackRows(m) }));
    ctx.mutateJsonFile(join(dir, "v1.json"), {
      mode: 0o600,
      maxBytes: MAX_BYTES,
      parse: (raw) => raw,
      serialize: (raw) => raw!,
      mutation: (current) => {
        const rows = ctx.db ? new SqlTaskRows(ctx.db) : degraded!;
        const h = rows.header();
        if (current && JSON.parse(current).version > h.version) return {};
        // 0.11 rejects unknown record properties. Keep UI-only visibility
        // in the intent mirror, never in the backward-compatible payload.
        const records = rows
          .rows({ orphan: true })
          .map((row) => ({ ...row.record, updatedAt: row.frozenActivityAt ?? row.activityAt }));
        const bytes = serialize({
          schemaVersion: 1,
          version: h.version,
          records,
          errors: h.errors,
        });
        return bytes === current ? {} : { value: bytes };
      },
    });
    mirrorDirty = false;
  }
  function schedule(ctx: StorageWorkerContext) {
    latest = ctx;
    mirrorDirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        try {
          if (latest) flush(latest);
        } catch {
          if (latest) schedule(latest);
        }
      }, 30_000);
      timer.unref?.();
    }
  }
  function initialize(ctx: StorageWorkerContext) {
    const config = ctx.config as { taskInboxDirectory?: string } | undefined;
    if (!config?.taskInboxDirectory || !isAbsolute(config.taskInboxDirectory))
      throw new Error("Desktop task directory must be configured");
    dir = config.taskInboxDirectory;
    const legacy = importLegacy(ctx);
    withMirror(ctx, (m) => {
      const sql = ctx.db;
      const rows = sql ? new SqlTaskRows(sql) : fallbackRows(m);
      const initial = sql
        ? !sql.get("SELECT id FROM task_projection_state WHERE id=1")
        : !m.fallback;
      const ingest = () => {
        const header = rows.header();
        if (initial && m.fallback) for (const row of m.fallback.rows) rows.put(row);
        let imported = false;
        for (const record of legacy.records) {
          const existing = rows.rows({ key: record.taskKey })[0];
          if ((!existing || existing.projectionOnly) && upsertTask(rows, record, true, Date.now()))
            imported = true;
        }
        if (initial || m.version > header.intentVersion) applyMirror(rows, m);
        for (const record of legacy.records)
          if (rows.intent(record.taskKey)?.deletedAt !== undefined) rows.remove(record.taskKey);
        if (initial || imported || m.version > header.intentVersion)
          rows.setHeader({
            version: Math.max(
              header.version + Number(!initial && imported),
              legacy.version,
              m.fallback?.header.version ?? 0,
            ),
            errors: initial ? (m.fallback?.header.errors ?? legacy.errors) : header.errors,
            intentVersion: Math.max(m.version, header.intentVersion),
          });
      };
      if (sql) sql.transaction(ingest);
      else ingest();
      const h = rows.header();
      if (!sql)
        return {
          result: true,
          value: { ...rows.mirror(h.intentVersion), fallback: { rows: rows.rows(), header: h } },
        };
      return m.fallback || h.intentVersion > m.version
        ? { result: true, value: rows.mirror(h.intentVersion) }
        : { result: true };
    });
    initialized = true;
  }
  function perform(rows: TaskRows, command: string, payload: unknown) {
    switch (command) {
      case "tasks/snapshot": {
        const p = checkedTaskObject(payload ?? {}, new Set(["visibility"]));
        if (
          p.visibility !== undefined &&
          p.visibility !== "visible" &&
          p.visibility !== "hidden" &&
          p.visibility !== "all"
        )
          throw new Error("Invalid task visibility");
        return { value: taskSnapshot(rows, p.visibility), changed: false };
      }
      case "tasks/get": {
        const p = checkedTaskObject(payload, new Set(["taskKey"]));
        const row = rows.rows({ key: checkedTaskText(p.taskKey, "task key", 1100) })[0];
        return { value: row ? displayTask(row) : null, changed: false };
      }
      case "tasks/reconcile": {
        const changed = reconcileTasks(rows, checkedBatches(payload), Date.now(), legacyLimit);
        return { value: { version: rows.header().version, changed }, changed };
      }
      case "tasks/intent": {
        const changed = changeTaskIntent(rows, checkedIntent(payload), Date.now());
        if (changed) {
          const h = rows.header();
          rows.setHeader({ ...h, version: h.version + 1, intentVersion: h.intentVersion + 1 });
        }
        return { value: { version: rows.header().version, changed }, changed };
      }
      default:
        throw new Error("Unknown task storage command");
    }
  }
  return {
    initialize(ctx) {
      try {
        initialize(ctx);
      } catch {
        initialized = false;
      } // Keep unrelated session index commands available if the task mirror needs repair.
    },
    handle(ctx, command, payload) {
      if (!initialized || !dir) throw new Error("Desktop task storage is uninitialized");
      if (command === "tasks/flush") {
        flush(ctx);
        return true;
      }
      const db = ctx.db;
      if (db && command !== "tasks/intent") {
        const rows = new SqlTaskRows(db);
        const result =
          command === "tasks/reconcile"
            ? db.transaction(() => perform(rows, command, payload))
            : perform(rows, command, payload);
        if (result.changed) schedule(ctx);
        return result.value;
      }
      const reply = withMirror(ctx, (m) => {
        const rows = db ? new SqlTaskRows(db) : fallbackRows(m);
        const mutate = () => {
          const h = rows.header();
          if (db && m.version > h.intentVersion) {
            applyMirror(rows, m);
            rows.setHeader({ ...h, intentVersion: m.version });
          }
          return perform(rows, command, payload);
        };
        const result = db ? db.transaction(mutate) : mutate();
        const h = rows.header();
        const write = result.changed || Boolean(db && m.version < h.intentVersion);
        const value: Mirror | undefined = write ? rows.mirror(h.intentVersion) : undefined;
        if (value && !db) value.fallback = { rows: rows.rows(), header: h };
        return { value, result };
      });
      if (reply.changed) schedule(ctx);
      return reply.value;
    },
    close(ctx) {
      flush(ctx);
    },
  };
}
