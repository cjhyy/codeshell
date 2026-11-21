import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  assertSessionFileId,
  readSessionFileSync,
  readSessionListStateSync,
  scanSessionDirectoriesSync,
} from "@cjhyy/code-shell-host/session-files";
import type { SqlValue, StorageDatabase } from "@cjhyy/code-shell-core/internal/storage";
import { projectDiskSessionState } from "./disk-session-list.js";

interface Fingerprint {
  id: string;
  dir_mtime: number;
  state_mtime_ns: string | null;
  state_size: number | null;
  external_mtime_ns: string | null;
  external_size: number | null;
}

const fields = "id, dir_mtime, state_mtime_ns, state_size, external_mtime_ns, external_size";
const metadataColumns = [
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
  "indexed_at",
  "metadata_json",
];
const columns = [...fields.split(", "), ...metadataColumns];
const upsert = `INSERT INTO sessions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
  ON CONFLICT(id) DO UPDATE SET ${columns
    .slice(1)
    .map((key) => `${key}=excluded.${key}`)
    .join(",")}`;

function missing(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException)?.code === "ENOENT" ||
    (error as NodeJS.ErrnoException)?.code === "ENOTDIR"
  );
}

function directory(root: string, id?: string) {
  try {
    const info = lstatSync(id ? join(root, id) : root);
    return info.isDirectory() && !info.isSymbolicLink() ? info : undefined;
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

function stamp(file: string) {
  try {
    const info = lstatSync(file, { bigint: true });
    if (info.isFile()) return { ns: info.mtimeNs.toString(), size: Number(info.size) };
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return { ns: null, size: null };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readJson(read: () => string): Record<string, unknown> {
  try {
    return record(JSON.parse(read()));
  } catch {
    // Missing, unreadable and malformed state is also hidden by the original catalog.
    return {};
  }
}
const stringField = (value: unknown) => (typeof value === "string" ? value : null);
const timeField = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function fingerprint(root: string, id: string, mtime: number): Fingerprint {
  const state = stamp(join(root, id, "state.json"));
  const external = stamp(join(root, id, "external-runtime.json"));
  return {
    id,
    dir_mtime: mtime,
    state_mtime_ns: state.ns,
    state_size: state.size,
    external_mtime_ns: external.ns,
    external_size: external.size,
  };
}

const equal = (a: Fingerprint | undefined, b: Fingerprint) =>
  !!a &&
  a.dir_mtime === b.dir_mtime &&
  a.state_mtime_ns === b.state_mtime_ns &&
  a.state_size === b.state_size &&
  a.external_mtime_ns === b.external_mtime_ns &&
  a.external_size === b.external_size;

function prepare(root: string, next: Fingerprint): SqlValue[] {
  const { id, dir_mtime: mtime } = next;
  const state =
    next.state_mtime_ns === null
      ? {}
      : readJson(() => readSessionListStateSync(root, id, 2 * 1024 * 1024));
  const binding =
    next.external_mtime_ns === null
      ? {}
      : readJson(() => readSessionFileSync(root, id, "external-runtime.json", 64 * 1024));
  const metadata = projectDiskSessionState(id, mtime, state);
  const externalKind =
    binding.version === 1 && (binding.kind === "codex" || binding.kind === "claude-code")
      ? binding.kind
      : null;
  // Persist a display projection only. Credentials, prompts and the external
  // runtime's session handle are never copied into the index.
  return [
    id,
    mtime,
    next.state_mtime_ns,
    next.state_size,
    next.external_mtime_ns,
    next.external_size,
    stringField(state.cwd),
    stringField(record(state.project).projectId),
    metadata?.title ?? stringField(state.title),
    stringField(state.origin),
    stringField(state.kind),
    metadata?.parentSessionId ?? stringField(state.parentSessionId),
    metadata?.status ?? stringField(state.status),
    metadata?.completionKind ?? null,
    timeField(state.archivedAt),
    timeField(state.startedAt),
    mtime,
    timeField(state.runActivityAt) ?? timeField(state.startedAt),
    externalKind,
    Date.now(),
    metadata ? JSON.stringify(metadata) : null,
  ];
}

/** Runs on the storage thread. ID membership detects deletion even when no
 * surviving state has a newer timestamp. Only changed files are opened. */
export function reconcileSessionIndex(
  db: StorageDatabase,
  root: string,
  ids?: readonly string[],
): void {
  const previous = ids
    ? undefined
    : new Map(db.all<Fingerprint>(`SELECT ${fields} FROM sessions`).map((row) => [row.id, row]));
  const rootInfo = directory(root);
  const candidates = ids ?? (rootInfo ? scanSessionDirectoriesSync(root).map(({ id }) => id) : []);
  const pending: Array<{ id: string; values?: SqlValue[] }> = [];
  const flush = () => {
    if (!pending.length) return;
    db.transaction(() => {
      for (const row of pending) {
        if (row.values) db.run(upsert, row.values);
        else db.run("DELETE FROM sessions WHERE id=?", [row.id]);
      }
    });
    pending.length = 0;
  };
  for (const id of candidates) {
    assertSessionFileId(id);
    if (id.startsWith("qchat-") || id.startsWith("panel-task-")) continue;
    const old = previous
      ? previous.get(id)
      : db.get<Fingerprint>(`SELECT ${fields} FROM sessions WHERE id=?`, [id]);
    previous?.delete(id);
    const dir = rootInfo && directory(root, id);
    if (!dir) {
      if (old) pending.push({ id });
    } else {
      const next = fingerprint(root, id, dir.mtimeMs);
      if (!equal(old, next)) {
        const values = prepare(root, next);
        // A write or rename during the read must not be marked reconciled
        // with a stamp belonging to different bytes.
        const after = directory(root, id);
        if (
          after &&
          dir.dev === after.dev &&
          dir.ino === after.ino &&
          equal(next, fingerprint(root, id, after.mtimeMs))
        ) {
          pending.push({ id, values });
        } else if (!after && old) pending.push({ id });
      }
    }
    if (pending.length >= 128) flush();
  }
  for (const id of previous?.keys() ?? []) {
    if (!rootInfo || !directory(root, id)) pending.push({ id });
    if (pending.length >= 128) flush();
  }
  flush();
}
