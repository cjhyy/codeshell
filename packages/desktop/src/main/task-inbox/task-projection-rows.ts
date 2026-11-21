import type { StorageDatabase } from "@cjhyy/code-shell-core/internal/storage";
import {
  isTerminalTaskStatus,
  parseTaskInboxRecord,
  type TaskInboxRecordV1,
  type TaskInboxSourceError,
} from "./task-inbox-types.js";

export interface TaskRow {
  record: TaskInboxRecordV1;
  activityAt: number;
  projectionOnly: boolean;
  frozenActivityAt?: number;
}
export interface TaskIntent {
  taskKey: string;
  sessionId?: string;
  hiddenAt?: number;
  hiddenReason?: "user" | "session-archived";
  frozenActivityAt?: number;
  deletedAt?: number;
  deletedRevision?: string;
  deletedActivityAt?: number;
}
export type SessionPolicy = "archived" | "deleted";
export interface TaskMirror {
  schemaVersion: 1;
  version: number;
  intents: TaskIntent[];
  sessions: [string, SessionPolicy][];
}
export interface ProjectionHeader {
  version: number;
  errors: TaskInboxSourceError[];
  intentVersion: number;
}
export interface RowScope {
  key?: string;
  source?: string;
  session?: string;
  orphan?: boolean;
  hidden?: boolean;
}
export const taskSession = (r: TaskInboxRecordV1) =>
  r.sessionId ??
  (r.source === "session" || r.source === "external-runtime" ? r.sourceId : undefined);
export const hotTask = (r: TaskInboxRecordV1) =>
  r.status === "queued" || r.status === "running" || r.status === "waiting";
export interface TaskRows {
  rows(scope?: RowScope): TaskRow[];
  put(row: TaskRow): void;
  remove(key: string): void;
  intent(key: string): TaskIntent | undefined;
  setIntent(key: string, intent: TaskIntent | undefined): void;
  policy(id: string): SessionPolicy | undefined;
  setPolicy(id: string, policy: SessionPolicy | undefined): void;
  mirror(version: number): TaskMirror;
  header(): ProjectionHeader;
  setHeader(header: ProjectionHeader): void;
  prune(limit: number): boolean;
}
interface SqlIntent {
  task_key: string;
  session_id: string | null;
  hidden_at: number | null;
  hidden_reason: TaskIntent["hiddenReason"] | null;
  frozen_activity_at: number | null;
  deleted_at: number | null;
  deleted_revision: string | null;
  deleted_activity_at: number | null;
}
function decode(i: SqlIntent): TaskIntent {
  return {
    taskKey: i.task_key,
    sessionId: i.session_id ?? undefined,
    hiddenAt: i.hidden_at ?? undefined,
    hiddenReason: i.hidden_reason ?? undefined,
    frozenActivityAt: i.frozen_activity_at ?? undefined,
    deletedAt: i.deleted_at ?? undefined,
    deletedRevision: i.deleted_revision ?? undefined,
    deletedActivityAt: i.deleted_activity_at ?? undefined,
  };
}
export class SqlTaskRows implements TaskRows {
  constructor(private db: StorageDatabase) {}
  rows(scope: RowScope = {}): TaskRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["task_key", scope.key],
      ["source", scope.source],
      ["session_id", scope.session],
    ] as const) {
      if (value !== undefined) {
        where.push(`t.${column}=?`);
        params.push(value);
      }
    }
    if (scope.orphan) {
      where.push("t.projection_only=1");
    }
    if (scope.hidden !== undefined) where.push(`i.hidden_at IS ${scope.hidden ? "NOT " : ""}NULL`);
    const join = "LEFT JOIN task_user_state i USING(task_key)";
    return this.db
      .all<{
        record_json: string;
        activity_at: number;
        projection_only: number;
        frozen_activity_at: number | null;
      }>(
        `SELECT t.record_json,t.activity_at,t.projection_only,i.frozen_activity_at FROM tasks t ${join} ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
        params,
      )
      .map((r) => ({
        record: parseTaskInboxRecord(JSON.parse(r.record_json)),
        activityAt: r.activity_at,
        projectionOnly: !!r.projection_only,
        frozenActivityAt: r.frozen_activity_at ?? undefined,
      }));
  }
  put({ record: r, activityAt, projectionOnly }: TaskRow) {
    this.db.run(
      "INSERT OR REPLACE INTO tasks(task_key,source,source_id,attempt,session_id,project_id,status,tier,activity_at,terminal_at,stale,source_revision,record_json,projection_only) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        r.taskKey,
        r.source,
        r.sourceId,
        r.attempt ?? null,
        taskSession(r) ?? null,
        r.projectId ?? null,
        r.status,
        hotTask(r) ? "hot" : "cold",
        activityAt,
        r.terminalAt ?? null,
        Number(!!r.stale),
        r.sourceRevision,
        JSON.stringify(r),
        Number(projectionOnly),
      ],
    );
  }
  remove(key: string) {
    this.db.run("DELETE FROM tasks WHERE task_key=?", [key]);
  }
  intent(key: string) {
    const row = this.db.get<SqlIntent>("SELECT * FROM task_user_state WHERE task_key=?", [key]);
    return row && decode(row);
  }
  setIntent(key: string, i: TaskIntent | undefined) {
    if (!i) {
      this.db.run("DELETE FROM task_user_state WHERE task_key=?", [key]);
      return;
    }
    this.db.run("INSERT OR REPLACE INTO task_user_state VALUES(?,?,?,?,?,?,?,?)", [
      key,
      i.sessionId ?? null,
      i.hiddenAt ?? null,
      i.hiddenReason ?? null,
      i.frozenActivityAt ?? null,
      i.deletedAt ?? null,
      i.deletedRevision ?? null,
      i.deletedActivityAt ?? null,
    ]);
  }
  policy(id: string) {
    return this.db.get<{ state: SessionPolicy }>(
      "SELECT state FROM task_session_state WHERE session_id=?",
      [id],
    )?.state;
  }
  setPolicy(id: string, policy: SessionPolicy | undefined) {
    if (policy) this.db.run("INSERT OR REPLACE INTO task_session_state VALUES(?,?)", [id, policy]);
    else this.db.run("DELETE FROM task_session_state WHERE session_id=?", [id]);
  }
  mirror(version: number): TaskMirror {
    return {
      schemaVersion: 1,
      version,
      intents: this.db
        .all<SqlIntent>("SELECT * FROM task_user_state ORDER BY task_key")
        .map(decode),
      sessions: this.db
        .all<{
          session_id: string;
          state: SessionPolicy;
        }>("SELECT * FROM task_session_state ORDER BY session_id")
        .map((r) => [r.session_id, r.state]),
    };
  }
  header(): ProjectionHeader {
    const row = this.db.get<{ version: number; errors_json: string; intent_version: number }>(
      "SELECT * FROM task_projection_state WHERE id=1",
    );
    return row
      ? {
          version: row.version,
          errors: JSON.parse(row.errors_json),
          intentVersion: row.intent_version,
        }
      : { version: 0, errors: [], intentVersion: 0 };
  }
  setHeader(h: ProjectionHeader) {
    this.db.run("INSERT OR REPLACE INTO task_projection_state VALUES(1,?,?,?)", [
      h.version,
      JSON.stringify(h.errors),
      h.intentVersion,
    ]);
  }
  prune(limit: number) {
    this.db.run(
      "DELETE FROM tasks WHERE task_key IN (SELECT task_key FROM tasks WHERE status IN ('done','failed','cancelled') ORDER BY coalesce(terminal_at,activity_at) DESC,task_key LIMIT -1 OFFSET ?)",
      [limit],
    );
    return Number(this.db.get<{ n: number }>("SELECT changes() n")?.n) > 0;
  }
}

export class JsonTaskRows implements TaskRows {
  private records = new Map<string, TaskRow>();
  private intents = new Map<string, TaskIntent>();
  private sessions = new Map<string, SessionPolicy>();
  private meta: ProjectionHeader = { version: 0, errors: [], intentVersion: 0 };
  rows(scope: RowScope = {}): TaskRow[] {
    if (scope.key !== undefined) {
      const row = this.records.get(scope.key);
      return row
        ? [{ ...row, frozenActivityAt: this.intents.get(row.record.taskKey)?.frozenActivityAt }]
        : [];
    }
    return [...this.records.values()]
      .filter(
        (r) =>
          (scope.source === undefined || scope.source === r.record.source) &&
          (scope.session === undefined || scope.session === taskSession(r.record)) &&
          (!scope.orphan || r.projectionOnly) &&
          (scope.hidden === undefined ||
            scope.hidden === (this.intents.get(r.record.taskKey)?.hiddenAt !== undefined)),
      )
      .map((row) => ({
        ...row,
        frozenActivityAt: this.intents.get(row.record.taskKey)?.frozenActivityAt,
      }));
  }
  put(r: TaskRow) {
    this.records.set(r.record.taskKey, r);
  }
  remove(key: string) {
    this.records.delete(key);
  }
  intent(key: string) {
    return this.intents.get(key);
  }
  setIntent(key: string, i: TaskIntent | undefined) {
    if (i) this.intents.set(key, i);
    else this.intents.delete(key);
  }
  policy(id: string) {
    return this.sessions.get(id);
  }
  setPolicy(id: string, p: SessionPolicy | undefined) {
    if (p) this.sessions.set(id, p);
    else this.sessions.delete(id);
  }
  mirror(version: number): TaskMirror {
    return {
      schemaVersion: 1,
      version,
      intents: [...this.intents.values()],
      sessions: [...this.sessions],
    };
  }
  header() {
    return this.meta;
  }
  setHeader(h: ProjectionHeader) {
    this.meta = h;
  }
  prune(limit: number) {
    const expired = this.rows()
      .filter((r) => isTerminalTaskStatus(r.record.status))
      .sort(
        (a, b) =>
          (b.record.terminalAt ?? b.activityAt) - (a.record.terminalAt ?? a.activityAt) ||
          a.record.taskKey.localeCompare(b.record.taskKey),
      )
      .slice(limit);
    for (const row of expired) this.remove(row.record.taskKey);
    return !!expired.length;
  }
}
