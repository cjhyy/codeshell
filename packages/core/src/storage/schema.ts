import type { StorageDatabase } from "./driver.js";

/** Released migrations are immutable. New versions append another entry. */
const migrations = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY NOT NULL,
     cwd TEXT, project_id TEXT, title TEXT, origin TEXT, kind TEXT, parent_session_id TEXT,
     status TEXT, completion_kind TEXT, archived_at REAL, created_at REAL, updated_at REAL,
     last_activity_at REAL, external_kind TEXT,
     state_mtime_ns TEXT, state_size INTEGER, external_mtime_ns TEXT, external_size INTEGER,
     indexed_at REAL NOT NULL DEFAULT 0, dir_mtime REAL NOT NULL DEFAULT 0, metadata_json TEXT
   );
   CREATE INDEX sessions_updated ON sessions(updated_at DESC);
   CREATE INDEX sessions_parent ON sessions(parent_session_id, dir_mtime DESC, id);
   CREATE INDEX sessions_project_updated ON sessions(project_id, updated_at DESC);
   CREATE INDEX sessions_archived ON sessions(archived_at);
   CREATE INDEX sessions_directory_order ON sessions(dir_mtime DESC, id);`,
  `CREATE TABLE tasks (
     task_key TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, attempt INTEGER,
     session_id TEXT, project_id TEXT, status TEXT NOT NULL, tier TEXT NOT NULL, activity_at REAL NOT NULL,
     terminal_at REAL, stale INTEGER NOT NULL, source_revision TEXT NOT NULL, record_json TEXT NOT NULL,
     projection_only INTEGER NOT NULL
   );
   CREATE INDEX tasks_tier ON tasks(tier);
   CREATE INDEX tasks_status_activity ON tasks(status,activity_at DESC);
   CREATE INDEX tasks_session ON tasks(session_id);
   CREATE INDEX tasks_project_activity ON tasks(project_id,activity_at DESC);
   CREATE INDEX tasks_source ON tasks(source);
   CREATE TABLE task_user_state (
     task_key TEXT PRIMARY KEY, session_id TEXT, hidden_at REAL, hidden_reason TEXT, frozen_activity_at REAL,
     deleted_at REAL, deleted_revision TEXT, deleted_activity_at REAL
   );
   CREATE INDEX task_intent_session ON task_user_state(session_id);
   CREATE TABLE task_session_state (session_id TEXT PRIMARY KEY, state TEXT NOT NULL);
   CREATE TABLE task_projection_state (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL,
     errors_json TEXT NOT NULL, intent_version INTEGER NOT NULL);`,
];

export class UnrecognizedStorageSchema extends Error {}

export function migrate(db: StorageDatabase): void {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  if (tables.length && !tables.some(({ name }) => name === "schema_migrations"))
    throw new UnrecognizedStorageSchema("Missing storage migration history");
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    const history = db.all<{ name: string }>("PRAGMA table_info(schema_migrations)");
    if (
      !history.some((col) => col.name === "version") ||
      !history.some((col) => col.name === "applied_at")
    )
      throw new UnrecognizedStorageSchema("Invalid storage migration history");
    const applied = db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    if (applied.length > migrations.length || applied.some(({ version }, i) => version !== i + 1))
      throw new UnrecognizedStorageSchema("Unknown storage schema version");
    for (let i = applied.length; i < migrations.length; i++) {
      db.exec(migrations[i]);
      db.run("INSERT INTO schema_migrations VALUES (?,?)", [i + 1, Date.now()]);
    }
    const sessionColumns = db.all<{ name: string }>("PRAGMA table_info(sessions)");
    const required = [
      "id",
      "cwd",
      "project_id",
      "title",
      "origin",
      "kind",
      "parent_session_id",
      "status",
      "completion_kind",
      "archived_at",
      "created_at",
      "updated_at",
      "last_activity_at",
      "external_kind",
      "state_mtime_ns",
      "state_size",
      "external_mtime_ns",
      "external_size",
      "indexed_at",
      "dir_mtime",
      "metadata_json",
    ];
    if (required.some((name) => !sessionColumns.some((column) => column.name === name)))
      throw new UnrecognizedStorageSchema("Invalid sessions index");
  });
}
