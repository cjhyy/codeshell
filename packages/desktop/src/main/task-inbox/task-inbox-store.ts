import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { mutateJsonFile } from "@cjhyy/code-shell-core/internal";
import {
  compareTaskInboxRecords,
  deduplicateTaskInboxRecords,
  shouldReplaceTaskRecord,
} from "./task-inbox-mappers.js";
import {
  checkedTaskObject,
  checkedTaskText,
  isTaskSource,
  isTerminalTaskStatus,
  parseTaskInboxListQuery,
  parseTaskInboxRecord,
  type TaskInboxListQuery,
  type TaskInboxListResult,
  type TaskInboxRecordV1,
  type TaskInboxSnapshot,
  type TaskInboxSourceError,
  type TaskSource,
} from "./task-inbox-types.js";

interface ProjectionFile extends TaskInboxSnapshot {
  schemaVersion: 1;
}
export interface TaskInboxStoreOptions {
  filePath: string;
  terminalLimit?: number;
}
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const empty = (): ProjectionFile => ({ schemaVersion: 1, version: 0, records: [], errors: [] });

/** Rebuildable read model, guarded by the same atomic directory mutex as other host stores. */
export class TaskInboxStore {
  private readonly listeners = new Set<(snapshot: TaskInboxSnapshot) => void>();
  private readonly terminalLimit: number;
  constructor(private readonly options: TaskInboxStoreOptions) {
    this.terminalLimit = options.terminalLimit ?? 2000;
    if (!Number.isSafeInteger(this.terminalLimit) || this.terminalLimit < 0)
      throw new Error("Invalid terminal task limit");
  }
  load(): TaskInboxSnapshot {
    return this.mutate(() => undefined);
  }
  snapshot(): TaskInboxSnapshot {
    return this.load();
  }
  get(taskKey: string): TaskInboxRecordV1 | undefined {
    checkedTaskText(taskKey, "key", 1100);
    return this.load().records.find((record) => record.taskKey === taskKey);
  }
  list(query: TaskInboxListQuery = {}): TaskInboxListResult {
    const checked = parseTaskInboxListQuery(query);
    const snapshot = this.load();
    const search = checked.search?.trim().toLocaleLowerCase();
    const records = deduplicateTaskInboxRecords(snapshot.records)
      .filter(
        (record) =>
          (!checked.status || record.status === checked.status) &&
          (!checked.source || record.source === checked.source) &&
          (!checked.projectId || record.projectId === checked.projectId) &&
          (!search || record.title.toLocaleLowerCase().includes(search)),
      )
      .sort(compareTaskInboxRecords);
    let offset = 0;
    if (checked.cursor) {
      const match = /^(\d+):(\d+)$/.exec(checked.cursor);
      if (
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        !Number.isSafeInteger(Number(match[2]))
      )
        throw new Error("Invalid task cursor");
      // A concurrent update invalidates offsets; restart rather than silently omit rows.
      if (Number(match[1]) === snapshot.version) offset = Number(match[2]);
    }
    const limit = checked.limit ?? 200;
    const page = records.slice(offset, offset + limit);
    return {
      ...snapshot,
      records: page,
      ...(offset + limit < records.length
        ? { nextCursor: `${snapshot.version}:${offset + limit}` }
        : {}),
    };
  }
  upsert(record: TaskInboxRecordV1): TaskInboxSnapshot {
    return this.upsertMany([record]);
  }
  upsertMany(records: TaskInboxRecordV1[]): TaskInboxSnapshot {
    const parsed = records.map(parseTaskInboxRecord);
    return this.mutate((file) => this.merge(file, parsed));
  }
  /** One reconciliation produces at most one version and one broadcast. */
  reconcile(
    results: Array<{ source: TaskSource; records?: TaskInboxRecordV1[]; error?: string }>,
  ): TaskInboxSnapshot {
    const parsed = results.map((result) => ({
      ...result,
      records: result.records?.map((record) => {
        const value = parseTaskInboxRecord(record);
        if (value.source !== result.source)
          throw new Error("Task reader returned a different source");
        delete value.stale;
        return value;
      }),
    }));
    return this.mutate((file) => {
      const errors = new Map(file.errors.map((error) => [error.source, error]));
      for (const result of parsed) {
        if (result.error !== undefined) {
          errors.set(result.source, {
            source: result.source,
            message: checkedTaskText(result.error, "source error", 2048, true),
          });
          for (const record of file.records)
            if (record.source === result.source) record.stale = true;
        } else {
          errors.delete(result.source);
          const present = new Set(result.records?.map((record) => record.taskKey));
          // In-memory registries can disappear on a crash. A missing active row is
          // retained conservatively, without advertising a now absent controller.
          for (const record of file.records) {
            if (
              record.source === result.source &&
              !present.has(record.taskKey) &&
              !isTerminalTaskStatus(record.status)
            ) {
              record.stale = true;
              record.capabilities = record.capabilities.filter(
                (capability) => capability === "open",
              );
              if (record.status === "running" || record.status === "queued")
                record.status = "interrupted";
            }
          }
          this.merge(file, result.records ?? []);
        }
      }
      file.errors = [...errors.values()].sort((a, b) => a.source.localeCompare(b.source));
    });
  }
  markSourceStale(source: TaskSource, message: string): TaskInboxSnapshot {
    return this.reconcile([{ source, error: message }]);
  }
  setErrors(errors: TaskInboxSourceError[]): TaskInboxSnapshot {
    const checked = errors.map(parseError);
    return this.mutate((file) => {
      file.errors = checked.sort((a, b) => a.source.localeCompare(b.source));
    });
  }
  subscribe(listener: (snapshot: TaskInboxSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private merge(file: ProjectionFile, records: TaskInboxRecordV1[]): void {
    const index = new Map(file.records.map((record) => [record.taskKey, record]));
    for (const record of records) {
      const previous = index.get(record.taskKey);
      if (!previous || shouldReplaceTaskRecord(previous, record)) index.set(record.taskKey, record);
    }
    file.records = [...index.values()];
  }
  private mutate(change: (file: ProjectionFile) => void): TaskInboxSnapshot {
    let changed = false;
    let repaired = false;
    const snapshot = mutateJsonFile<ProjectionFile, TaskInboxSnapshot>(this.options.filePath, {
      parse: (raw) =>
        this.parseFile(raw, () => {
          repaired = true;
        }),
      serialize: (file) => `${JSON.stringify(file)}\n`,
      mode: 0o600,
      maxBytes: MAX_FILE_BYTES,
      mutation: (file) => {
        const before = JSON.stringify({ records: file.records, errors: file.errors });
        change(file);
        const active = file.records.filter((record) => !isTerminalTaskStatus(record.status));
        const terminal = file.records
          .filter((record) => isTerminalTaskStatus(record.status))
          .sort(
            (a, b) =>
              (b.terminalAt ?? b.updatedAt) - (a.terminalAt ?? a.updatedAt) ||
              a.taskKey.localeCompare(b.taskKey),
          )
          .slice(0, this.terminalLimit);
        file.records = [...active, ...terminal].sort((a, b) => a.taskKey.localeCompare(b.taskKey));
        changed =
          repaired || before !== JSON.stringify({ records: file.records, errors: file.errors });
        if (changed) file.version += 1;
        return {
          ...(changed ? { value: file } : {}),
          result: clone({ version: file.version, records: file.records, errors: file.errors }),
        };
      },
    });
    if (!snapshot) throw new Error("Task projection returned no snapshot");
    if (changed)
      for (const listener of this.listeners) {
        try {
          listener(clone(snapshot));
        } catch {
          /* A closed window cannot break task ingestion. */
        }
      }
    return snapshot;
  }
  private parseFile(raw: string | undefined, onRepair: () => void): ProjectionFile {
    if (raw === undefined) return empty();
    let file: Record<string, unknown>;
    try {
      file = checkedTaskObject(
        JSON.parse(raw),
        new Set(["schemaVersion", "version", "records", "errors"]),
      );
      if (
        file.schemaVersion !== 1 ||
        !Number.isSafeInteger(file.version) ||
        Number(file.version) < 0 ||
        !Array.isArray(file.records) ||
        !Array.isArray(file.errors)
      )
        throw new Error("Invalid projection header");
    } catch {
      // Move the exact original bytes aside before a caller can rebuild this file.
      const quarantine = `${this.options.filePath}.${randomUUID()}.corrupt`;
      renameSync(this.options.filePath, quarantine);
      chmodSync(quarantine, 0o600);
      onRepair();
      return empty();
    }
    const recordIndex = new Map<string, TaskInboxRecordV1>();
    const errors: TaskInboxSourceError[] = [];
    const invalid: unknown[] = [];
    for (const row of file.records as unknown[]) {
      try {
        const record = parseTaskInboxRecord(row);
        const previous = recordIndex.get(record.taskKey);
        if (previous) invalid.push(row);
        if (!previous || shouldReplaceTaskRecord(previous, record))
          recordIndex.set(record.taskKey, record);
      } catch {
        invalid.push(row);
      }
    }
    for (const error of file.errors as unknown[]) {
      try {
        errors.push(parseError(error));
      } catch {
        invalid.push(error);
      }
    }
    if (invalid.length) {
      // Keep the entire original too: unknown fields and invalid rows are never
      // silently destroyed while salvaging unrelated valid projection entries.
      writeFileSync(`${this.options.filePath}.${randomUUID()}.corrupt`, raw, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      onRepair();
    }
    return {
      schemaVersion: 1,
      version: Number(file.version),
      records: [...recordIndex.values()],
      errors,
    };
  }
}
function parseError(value: unknown): TaskInboxSourceError {
  const raw = checkedTaskObject(value, new Set(["source", "message"]));
  if (!isTaskSource(raw.source)) throw new Error("Invalid task error source");
  return { source: raw.source, message: checkedTaskText(raw.message, "source error", 2048, true) };
}
export function createTaskInboxStore(options: TaskInboxStoreOptions): TaskInboxStore {
  return new TaskInboxStore(options);
}
