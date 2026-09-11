import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import { mutateJsonFile } from "@cjhyy/code-shell-core/internal";
import type {
  SessionCatalogPatch,
  SessionCatalogSnapshot,
  SessionIndex,
  SessionSummary,
} from "../shared/session-catalog.js";

// This bounds corrupt/hostile input, not a browser storage quota. The catalogue
// contains only sidebar metadata; transcript events never belong in this file.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REQUIRED_FIELDS = new Set(["id", "title", "createdAt", "updatedAt"]);
const STRING_FIELDS = new Set([
  "title",
  "engineSessionId",
  "teamId",
  "sessionBrief",
  "workspaceProfile",
  "runId",
  "runStatus",
  "cronJobId",
]);
const BOOLEAN_FIELDS = new Set(["titleManual", "archived", "pinned"]);
const SUMMARY_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  ...STRING_FIELDS,
  ...BOOLEAN_FIELDS,
  "teamRole",
  "source",
]);

interface CatalogFile extends SessionCatalogSnapshot {
  version: 1;
  /** Permanent row tombstones also fence delayed patches from another window. */
  deletedSessionIds: Record<string, string[]>;
  legacyMigration?: { completedAt: number; backupFile: string };
}

export interface SessionCatalogStoreOptions {
  file?: string;
  now?: () => number;
}

/**
 * Main owns the directory. Every operation reloads inside the same file mutex
 * used by ProjectStore, so both renderer windows and separate app processes
 * merge against the last committed state. There is no mutable memory snapshot
 * to accidentally publish when an atomic disk write fails.
 */
export class SessionCatalogStore {
  private readonly file: string;
  private readonly now: () => number;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: SessionCatalogSnapshot) => void>();

  constructor(options: SessionCatalogStoreOptions = {}) {
    this.file = options.file ?? join(codeShellHome(), "desktop", "session-catalog.json");
    this.now = options.now ?? Date.now;
  }

  load(): Promise<SessionCatalogSnapshot> {
    return this.enqueue(() => this.mutate(() => false));
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  /**
   * Called once with ALL legacy project indices, including removed projects.
   * The backup precedes the atomic marker+catalogue commit; a failed commit can
   * be retried, while successful migration permanently ignores stale browsers.
   */
  importLegacy(indices: Record<string, SessionIndex>): Promise<SessionCatalogSnapshot> {
    let legacy: Record<string, SessionIndex>;
    try {
      legacy = checkedIndices(indices);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() =>
      this.mutate((catalog) => {
        if (catalog.legacyMigration) return false;
        for (const [projectKey, index] of Object.entries(legacy)) {
          const existing = catalog.indices[projectKey];
          const deleted = new Set(catalog.deletedSessionIds[projectKey] ?? []);
          if (!existing) {
            catalog.indices[projectKey] = normalizeIndex({
              ...index,
              sessions: index.sessions.filter((row) => !deleted.has(row.id)),
            });
            continue;
          }
          // Existing rows (including absent optional fields) and selection are
          // authoritative. A stale legacy pin/title must not undo a Main edit.
          const seen = new Set(existing.sessions.map((row) => row.id));
          existing.sessions.push(
            ...index.sessions.filter((row) => !seen.has(row.id) && !deleted.has(row.id)),
          );
          normalizeIndex(existing);
        }
        const completedAt = this.now();
        const backupFile = join(
          dirname(this.file),
          `${basename(this.file, ".json")}.legacy-${randomUUID()}.json`,
        );
        const backup = serialize({ version: 1, importedAt: completedAt, indices: legacy });
        // Do not take the directory lock recursively: mutate() already owns it.
        writeBackupAtomic(backupFile, backup);
        catalog.legacyMigration = { completedAt, backupFile };
        return true;
      }),
    );
  }

  apply(patch: SessionCatalogPatch): Promise<SessionCatalogSnapshot> {
    // Detach queued input immediately: callers cannot mutate it while waiting
    // for another window's operation to finish.
    let validated: SessionCatalogPatch;
    try {
      validated = checkedPatch(patch);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() =>
      this.mutate((catalog) => {
        const hadProject = Object.hasOwn(catalog.indices, validated.projectKey);
        const index = catalog.indices[validated.projectKey] ?? {
          sessions: [],
          activeSessionId: null,
        };
        const before = JSON.stringify(index);
        const deleted = new Set(catalog.deletedSessionIds[validated.projectKey] ?? []);
        const previousDeletedSize = deleted.size;
        for (const id of validated.deletedSessionIds ?? []) deleted.add(id);
        const rows = new Map(
          index.sessions.filter((row) => !deleted.has(row.id)).map((row) => [row.id, row]),
        );
        for (const upsert of validated.upserts ?? []) {
          if (deleted.has(upsert.id)) continue;
          const row = { ...rows.get(upsert.id), ...upsert.values, id: upsert.id };
          for (const field of upsert.removeFields ?? []) delete row[field];
          rows.set(upsert.id, checkedSummary(row));
        }
        index.sessions = [...rows.values()];
        if (validated.activeSessionId !== undefined) {
          index.activeSessionId = validated.activeSessionId;
        }
        if (validated.deletedProjectLabel === null) delete index.deletedProjectLabel;
        else if (validated.deletedProjectLabel !== undefined) {
          index.deletedProjectLabel = validated.deletedProjectLabel;
        }
        normalizeIndex(index);
        if (deleted.size) catalog.deletedSessionIds[validated.projectKey] = [...deleted];
        catalog.indices[validated.projectKey] = index;
        return (
          !hadProject || before !== JSON.stringify(index) || deleted.size !== previousDeletedSize
        );
      }),
    );
  }

  onChanged(listener: (snapshot: SessionCatalogSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private mutate(change: (catalog: CatalogFile) => boolean): SessionCatalogSnapshot {
    let changed = false;
    const snapshot = mutateJsonFile<CatalogFile, SessionCatalogSnapshot>(this.file, {
      parse: (raw) => (raw === undefined ? emptyCatalog() : parseCatalog(raw)),
      serialize,
      mutation: (catalog) => {
        changed = change(catalog);
        if (changed) catalog.revision += 1;
        return {
          ...(changed ? { value: catalog } : {}),
          result: cloneSnapshot(catalog),
        };
      },
      mode: 0o600,
      maxBytes: MAX_FILE_BYTES,
    });
    if (!snapshot) throw new Error("session catalog operation did not return a snapshot");
    if (changed) {
      for (const listener of this.listeners) {
        try {
          listener(cloneSnapshot(snapshot));
        } catch {
          // A destroyed window cannot turn a committed disk write into failure
          // or prevent notification of the remaining windows.
        }
      }
    }
    return snapshot;
  }
}

function writeBackupAtomic(file: string, contents: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function emptyCatalog(): CatalogFile {
  return { version: 1, revision: 0, indices: {}, deletedSessionIds: {} };
}

function cloneSnapshot(snapshot: SessionCatalogSnapshot): SessionCatalogSnapshot {
  return structuredClone({ revision: snapshot.revision, indices: snapshot.indices });
}

function serialize(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new Error("session catalog metadata is too large");
  }
  return text;
}

function checkedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`invalid ${label}`);
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`unsafe ${label} key`);
  }
  return value as Record<string, unknown>;
}

function checkedId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    UNSAFE_KEYS.has(value) ||
    value === "." ||
    value === ".." ||
    /[\\/\x00-\x1f]/.test(value)
  ) {
    throw new Error("invalid session catalog id");
  }
  return value;
}

function checkedText(value: unknown, label: string): string {
  // A standing session brief may be long; it is still bounded metadata, unlike
  // tool output/images. Do not trim titles or alter the user's stored text.
  const max = label === "sessionBrief" ? 1024 * 1024 : 32_768;
  if (typeof value !== "string" || value.length > max) throw new Error(`invalid ${label}`);
  return value;
}

function checkedFields(value: unknown): Partial<SessionSummary> {
  const fields = checkedRecord(value, "session fields");
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!SUMMARY_FIELDS.has(key)) throw new Error(`unknown session field: ${key}`);
    // Electron can preserve an undefined optional property; omitted fields are
    // unchanged. Explicit deletion travels through removeFields instead.
    if (field === undefined) continue;
    if (key === "id") result[key] = checkedId(field);
    else if (STRING_FIELDS.has(key)) result[key] = checkedText(field, key);
    else if (BOOLEAN_FIELDS.has(key)) {
      if (typeof field !== "boolean") throw new Error(`invalid ${key}`);
      result[key] = field;
    } else if (key === "createdAt" || key === "updatedAt") {
      if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
        throw new Error(`invalid ${key}`);
      }
      result[key] = field;
    } else if (key === "teamRole") {
      if (field !== "lead" && field !== "member") throw new Error("invalid teamRole");
      result[key] = field;
    } else if (key === "source") {
      if (field !== "automation") throw new Error("invalid source");
      result[key] = field;
    }
  }
  return result as Partial<SessionSummary>;
}

function checkedSummary(value: unknown): SessionSummary {
  const row = checkedFields(value);
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(row, field)) throw new Error(`missing session field: ${field}`);
  }
  return row as SessionSummary;
}

function normalizeIndex(index: SessionIndex): SessionIndex {
  index.sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  if (!index.sessions.some((row) => row.id === index.activeSessionId && !row.archived)) {
    index.activeSessionId = null;
  }
  return index;
}

function checkedIndices(value: unknown): Record<string, SessionIndex> {
  const source = checkedRecord(value, "session indices");
  const indices: Record<string, SessionIndex> = {};
  for (const [projectKey, raw] of Object.entries(source)) {
    checkedId(projectKey);
    const index = checkedRecord(raw, "session index");
    if (!Array.isArray(index.sessions)) throw new Error("invalid session list");
    const sessions = index.sessions.map(checkedSummary);
    if (new Set(sessions.map((row) => row.id)).size !== sessions.length) {
      throw new Error("duplicate session catalog id");
    }
    indices[projectKey] = normalizeIndex({
      sessions,
      activeSessionId:
        index.activeSessionId === null || index.activeSessionId === undefined
          ? null
          : checkedId(index.activeSessionId),
      ...(index.deletedProjectLabel === undefined
        ? {}
        : { deletedProjectLabel: checkedText(index.deletedProjectLabel, "deletedProjectLabel") }),
    });
  }
  return indices;
}

function checkedPatch(value: unknown): SessionCatalogPatch {
  const patch = checkedRecord(value, "session catalog patch");
  const result: SessionCatalogPatch = { projectKey: checkedId(patch.projectKey) };
  if (patch.upserts !== undefined) {
    if (!Array.isArray(patch.upserts)) throw new Error("invalid session upserts");
    result.upserts = patch.upserts.map((raw) => {
      const upsert = checkedRecord(raw, "session upsert");
      const id = checkedId(upsert.id);
      const values = checkedFields(upsert.values);
      if (values.id !== undefined && values.id !== id) throw new Error("session id is immutable");
      let removeFields: Array<keyof SessionSummary> | undefined;
      if (upsert.removeFields !== undefined) {
        if (!Array.isArray(upsert.removeFields)) throw new Error("invalid removed session fields");
        removeFields = upsert.removeFields.map((field) => {
          if (
            typeof field !== "string" ||
            !SUMMARY_FIELDS.has(field) ||
            REQUIRED_FIELDS.has(field)
          ) {
            throw new Error("invalid removed session field");
          }
          return field as keyof SessionSummary;
        });
      }
      return { id, values, ...(removeFields ? { removeFields } : {}) };
    });
  }
  if (patch.deletedSessionIds !== undefined) {
    if (!Array.isArray(patch.deletedSessionIds)) throw new Error("invalid deleted sessions");
    result.deletedSessionIds = patch.deletedSessionIds.map(checkedId);
  }
  if (patch.activeSessionId !== undefined) {
    result.activeSessionId =
      patch.activeSessionId === null ? null : checkedId(patch.activeSessionId);
  }
  if (patch.deletedProjectLabel !== undefined) {
    result.deletedProjectLabel =
      patch.deletedProjectLabel === null
        ? null
        : checkedText(patch.deletedProjectLabel, "deletedProjectLabel");
  }
  return result;
}

function parseCatalog(text: string): CatalogFile {
  const file = checkedRecord(JSON.parse(text), "session catalog file");
  if (file.version !== 1 || !Number.isSafeInteger(file.revision) || Number(file.revision) < 0) {
    throw new Error("unsupported session catalog version or revision");
  }
  const deletedSessionIds: Record<string, string[]> = {};
  for (const [projectKey, ids] of Object.entries(
    checkedRecord(file.deletedSessionIds ?? {}, "deleted sessions"),
  )) {
    checkedId(projectKey);
    if (!Array.isArray(ids)) throw new Error("invalid deleted sessions");
    deletedSessionIds[projectKey] = ids.map(checkedId);
  }
  const result: CatalogFile = {
    version: 1,
    revision: file.revision as number,
    indices: checkedIndices(file.indices),
    deletedSessionIds,
  };
  if (file.legacyMigration !== undefined) {
    const migration = checkedRecord(file.legacyMigration, "legacy migration marker");
    if (typeof migration.completedAt !== "number" || !Number.isFinite(migration.completedAt)) {
      throw new Error("invalid legacy migration marker");
    }
    result.legacyMigration = {
      completedAt: migration.completedAt,
      backupFile: checkedText(migration.backupFile, "backupFile"),
    };
  }
  return result;
}
