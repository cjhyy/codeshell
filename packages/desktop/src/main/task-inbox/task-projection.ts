import {
  checkedTaskObject,
  checkedTaskText,
  isTaskSource,
  isTerminalTaskStatus,
  parseTaskInboxRecord,
  type TaskInboxRecordV1,
  type TaskInboxSnapshot,
  type TaskInboxSourceError,
  type TaskSource,
} from "./task-inbox-types.js";
import { shouldReplaceTaskRecord } from "./task-inbox-mappers.js";
import { taskSession, type TaskRows, type TaskRow } from "./task-projection-rows.js";

export interface ProjectionBatch {
  source: TaskSource;
  records?: TaskInboxRecordV1[];
  error?: string;
  /** Full source scans also account for previously present keys that disappeared. */
  complete?: boolean;
  removedKeys?: string[];
}
export type TaskChangeIntent =
  | { type: "hide" | "unhide" | "delete"; taskKey: string; expectedRevision: string }
  | { type: "clear"; before?: number }
  | { type: "sessionArchived" | "sessionUnarchived" | "sessionDeleted"; sessionId: string }
  | { type: "userContinued"; sessionId: string; taskKey?: string };

export function checkedIntent(input: unknown): TaskChangeIntent {
  const i = checkedTaskObject(
    input,
    new Set(["type", "taskKey", "sessionId", "expectedRevision", "before"]),
  );
  if (i.type === "hide" || i.type === "unhide" || i.type === "delete")
    return {
      type: i.type,
      taskKey: checkedTaskText(i.taskKey, "task key", 1100),
      expectedRevision: checkedTaskText(i.expectedRevision, "revision", 2048),
    };
  if (i.type === "clear") {
    if (
      i.before !== undefined &&
      (typeof i.before !== "number" || !Number.isFinite(i.before) || i.before < 0)
    )
      throw new Error("Invalid cleanup cutoff");
    return { type: "clear", before: i.before };
  }
  if (
    i.type === "sessionArchived" ||
    i.type === "sessionUnarchived" ||
    i.type === "sessionDeleted" ||
    i.type === "userContinued"
  ) {
    const sessionId = checkedTaskText(i.sessionId, "session", 512);
    return i.type === "userContinued"
      ? {
          type: i.type,
          sessionId,
          ...(i.taskKey !== undefined
            ? { taskKey: checkedTaskText(i.taskKey, "task key", 1100) }
            : {}),
        }
      : { type: i.type, sessionId };
  }
  throw new Error("Unknown task intent");
}

export function checkedBatches(input: unknown): ProjectionBatch[] {
  const payload = checkedTaskObject(input, new Set(["sources"]));
  if (!Array.isArray(payload.sources)) throw new Error("Invalid task source batches");
  return payload.sources.map((value) => {
    const b = checkedTaskObject(
      value,
      new Set(["source", "records", "error", "removedKeys", "complete"]),
    );
    if (
      !isTaskSource(b.source) ||
      (b.complete !== undefined && typeof b.complete !== "boolean") ||
      (b.records !== undefined && !Array.isArray(b.records)) ||
      (b.removedKeys !== undefined && !Array.isArray(b.removedKeys))
    )
      throw new Error("Invalid task source batch");
    const source = b.source;
    const records = b.records?.map((raw: unknown) => {
      const record = parseTaskInboxRecord(raw);
      if (record.source !== source) throw new Error("Task source mismatch");
      delete record.stale;
      delete record.hidden;
      return record;
    });
    return {
      source,
      records,
      error:
        b.error === undefined ? undefined : checkedTaskText(b.error, "source error", 2048, true),
      complete: b.complete,
      removedKeys: b.removedKeys?.map((k: unknown) => checkedTaskText(k, "task key", 1100)),
    };
  });
}

export function displayTask(row: TaskRow): TaskInboxRecordV1 {
  const activity = row.frozenActivityAt ?? row.activityAt;
  return {
    ...row.record,
    updatedAt: activity,
    ...(row.frozenActivityAt !== undefined ? { hidden: true } : {}),
  };
}
export function taskSnapshot(
  rows: TaskRows,
  visibility: "visible" | "hidden" | "all" = "visible",
): TaskInboxSnapshot {
  const { version, errors } = rows.header();
  return {
    version,
    errors,
    records: rows
      .rows(visibility === "all" ? {} : { hidden: visibility === "hidden" })
      .map((row) => displayTask(row)),
  };
}

/** A replay and a single source-key notification both take this exact merge path. */
export function upsertTask(
  rows: TaskRows,
  r: TaskInboxRecordV1,
  only: boolean,
  now: number,
): boolean {
  const key = r.taskKey,
    session = taskSession(r),
    intent = rows.intent(key);
  const policy = session ? rows.policy(session) : undefined;
  if (intent?.deletedAt !== undefined || policy === "deleted") return false;
  const previous = rows.rows({ key })[0];
  if (previous && previous.record.createdAt < r.createdAt)
    r = { ...r, createdAt: previous.record.createdAt };
  if (
    previous &&
    previous.projectionOnly === only &&
    previous.record.sourceRevision === r.sourceRevision &&
    JSON.stringify({ ...previous.record, updatedAt: r.updatedAt }) === JSON.stringify(r)
  )
    return false;
  if (previous && !shouldReplaceTaskRecord(previous.record, r)) {
    if (previous.projectionOnly === only || JSON.stringify(previous.record) !== JSON.stringify(r))
      return false;
    rows.put({ ...previous, projectionOnly: only });
    return true;
  }
  const sameExecution =
    previous && r.runId === previous.record.runId && r.status === previous.record.status;
  const activityAt = sameExecution ? previous.activityAt : (r.terminalAt ?? r.updatedAt ?? now);
  rows.put({ record: r, activityAt, projectionOnly: only });
  if (policy === "archived" && intent?.hiddenAt === undefined) {
    rows.setIntent(key, {
      taskKey: key,
      sessionId: session,
      hiddenAt: now,
      hiddenReason: "session-archived",
      frozenActivityAt: activityAt,
    });
  }
  return true;
}

function absent(rows: TaskRows, row: TaskRow, now: number): boolean {
  const record = { ...row.record };
  if (!isTerminalTaskStatus(record.status)) {
    record.stale = true;
    record.capabilities = record.capabilities.filter((c) => c === "open");
    if (record.status === "running" || record.status === "queued") record.status = "interrupted";
  }
  if (row.projectionOnly && JSON.stringify(row.record) === JSON.stringify(record)) return false;
  rows.put({
    ...row,
    record,
    projectionOnly: true,
    activityAt: record.status !== row.record.status ? now : row.activityAt,
  });
  return true;
}

export function reconcileTasks(
  rows: TaskRows,
  batches: ProjectionBatch[],
  now: number,
  limit: number,
): boolean {
  const header = rows.header(),
    errors = new Map(header.errors.map((e) => [e.source, e.message]));
  let changed = false;
  for (const batch of batches) errors.delete(batch.source);
  for (const b of batches) {
    if (b.error !== undefined) {
      errors.set(b.source, b.error);
      const affected =
        b.complete || b.removedKeys === undefined
          ? rows.rows({ source: b.source })
          : b.removedKeys
              .flatMap((key) => rows.rows({ key }))
              .filter((row) => row.record.source === b.source);
      for (const row of affected) {
        if (!row.record.stale) {
          rows.put({ ...row, record: { ...row.record, stale: true } });
          changed = true;
        }
      }
      continue;
    }
    const present = new Set(b.records?.map((r) => r.taskKey));
    const missing = b.complete
      ? rows.rows({ source: b.source }).filter((r) => !present.has(r.record.taskKey))
      : (b.removedKeys ?? [])
          .flatMap((key) => rows.rows({ key }))
          .filter((r) => r.record.source === b.source && !present.has(r.record.taskKey));
    for (const row of missing) if (absent(rows, row, now)) changed = true;
    for (const r of b.records ?? []) if (upsertTask(rows, r, false, now)) changed = true;
  }
  const nextErrors: TaskInboxSourceError[] = [...errors]
    .map(([source, message]) => ({ source, message }))
    .sort((a, b) => a.source.localeCompare(b.source));
  if (JSON.stringify(nextErrors) !== JSON.stringify(header.errors)) changed = true;
  if (changed) {
    rows.prune(limit);
    rows.setHeader({ ...header, version: header.version + 1, errors: nextErrors });
  }
  return changed;
}

function retire(rows: TaskRows, row: TaskRow, now: number) {
  const { record: r, activityAt } = row;
  rows.setIntent(r.taskKey, {
    taskKey: r.taskKey,
    sessionId: taskSession(r),
    deletedAt: now,
    deletedRevision: r.sourceRevision,
    deletedActivityAt: activityAt,
  });
  rows.remove(r.taskKey);
}

export function changeTaskIntent(
  rows: TaskRows,
  i: TaskChangeIntent,
  now: number,
): boolean | number {
  if (i.type === "clear") {
    let changed = 0;
    for (const row of rows.rows()) {
      if (
        isTerminalTaskStatus(row.record.status) &&
        (i.before === undefined || (row.record.terminalAt ?? row.activityAt) < i.before)
      ) {
        retire(rows, row, now);
        changed++;
      }
    }
    return changed;
  }
  if (i.type === "hide" || i.type === "unhide" || i.type === "delete") {
    const row = rows.rows({ key: i.taskKey })[0];
    if (
      !row &&
      i.type === "delete" &&
      rows.intent(i.taskKey)?.deletedRevision === i.expectedRevision
    )
      return false;
    if (!row || row.record.sourceRevision !== i.expectedRevision)
      throw new Error("Task changed; refresh before acting");
    const sessionId = taskSession(row.record),
      prev = rows.intent(i.taskKey);
    if (i.type === "delete") {
      if (!isTerminalTaskStatus(row.record.status) && row.record.status !== "interrupted")
        throw new Error("Task must be ended or interrupted before deletion");
      retire(rows, row, now);
      return true;
    }
    if (i.type === "hide") {
      if (prev?.hiddenReason === "user") return false;
      rows.setIntent(i.taskKey, {
        taskKey: i.taskKey,
        sessionId,
        hiddenAt: now,
        hiddenReason: "user",
        frozenActivityAt: prev?.frozenActivityAt ?? row.activityAt,
      });
    } else {
      if (!prev?.hiddenReason) return false;
      if (sessionId && rows.policy(sessionId) === "archived") {
        if (prev.hiddenReason === "session-archived") return false;
        rows.setIntent(i.taskKey, { ...prev, hiddenReason: "session-archived" });
      } else rows.setIntent(i.taskKey, undefined);
    }
    return true;
  }
  if (i.type === "userContinued") {
    // A new foreground Run can revive its own card. Unrelated historical
    // attempts, automation jobs and background observers retain their intent.
    const keys = i.taskKey
      ? [i.taskKey]
      : rows
          .mirror(0)
          .intents.filter(
            (intent) =>
              intent.sessionId === i.sessionId &&
              (intent.taskKey.startsWith("session:") ||
                intent.taskKey.startsWith("external-runtime:") ||
                intent.taskKey.startsWith("subagent:")),
          )
          .map((intent) => intent.taskKey);
    let changed = false;
    for (const key of keys)
      if (rows.intent(key)?.sessionId === i.sessionId) {
        rows.setIntent(key, undefined);
        changed = true;
      }
    return changed;
  }
  if (!("sessionId" in i)) throw new Error("Unknown task session intent");
  const previous = rows.policy(i.sessionId);
  const next =
    i.type === "sessionDeleted" ? "deleted" : i.type === "sessionArchived" ? "archived" : undefined;
  if (previous === next || previous === "deleted") return false;
  rows.setPolicy(i.sessionId, next);
  if (i.type === "sessionDeleted") {
    for (const row of rows.rows({ session: i.sessionId })) rows.remove(row.record.taskKey);
    for (const intent of rows.mirror(0).intents)
      if (intent.sessionId === i.sessionId) rows.setIntent(intent.taskKey, undefined);
  } else
    for (const row of rows.rows({ session: i.sessionId })) {
      const key = row.record.taskKey,
        prev = rows.intent(key);
      if (i.type === "sessionArchived" && !prev) {
        rows.setIntent(key, {
          taskKey: key,
          sessionId: i.sessionId,
          hiddenAt: now,
          hiddenReason: "session-archived",
          frozenActivityAt: row.activityAt,
        });
      } else if (i.type === "sessionUnarchived" && prev?.hiddenReason === "session-archived")
        rows.setIntent(key, undefined);
    }
  return true;
}
