import {
  parseTaskInboxRecord,
  type TaskInboxListQuery,
  type TaskInboxListResult,
  type TaskInboxRecordV1,
  type TaskInboxSnapshot,
  type TaskSource,
} from "./task-inbox-types.js";
import type { TaskInboxStore } from "./task-inbox-store.js";

export interface TaskInboxSourceReader {
  source: TaskSource;
  read(): TaskInboxRecordV1[] | Promise<TaskInboxRecordV1[]>;
}
export interface TaskInboxProjectorOptions {
  store: TaskInboxStore;
  readers: TaskInboxSourceReader[];
  /** Metadata-only diagnostics; callers must not log prompts or controller payloads. */
  onError?: (source: TaskSource | "projection", error: unknown) => void;
}
export class TaskInboxProjector {
  private pending?: Promise<TaskInboxSnapshot>;
  private readonly listeners = new Set<(snapshot: TaskInboxSnapshot) => void>();
  private unsubscribe: () => void;
  constructor(private readonly options: TaskInboxProjectorOptions) {
    if (new Set(options.readers.map((reader) => reader.source)).size !== options.readers.length)
      throw new Error("Duplicate task source reader");
    this.unsubscribe = options.store.subscribe((snapshot) => {
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(snapshot));
        } catch {
          /* Destroyed window. */
        }
      }
    });
  }
  snapshot(): TaskInboxSnapshot {
    return this.options.store.snapshot();
  }
  list(query: TaskInboxListQuery = {}): TaskInboxListResult {
    return this.options.store.list(query);
  }
  get(taskKey: string): TaskInboxRecordV1 | undefined {
    return this.options.store.get(taskKey);
  }
  subscribe(listener: (snapshot: TaskInboxSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
  ingest(value: TaskInboxRecordV1 | TaskInboxRecordV1[]): TaskInboxSnapshot {
    return this.options.store.upsertMany(Array.isArray(value) ? value : [value]);
  }
  reconcile(): Promise<TaskInboxSnapshot> {
    if (this.pending) return this.pending;
    const work = this.reconcileOnce();
    this.pending = work;
    void work
      .finally(() => {
        if (this.pending === work) this.pending = undefined;
      })
      .catch(() => undefined);
    return work;
  }
  private async reconcileOnce(): Promise<TaskInboxSnapshot> {
    const results = await Promise.all(
      this.options.readers.map(async (reader) => {
        try {
          const raw = await reader.read();
          if (!Array.isArray(raw)) throw new Error("Invalid task source snapshot");
          const records = raw.map((record) => {
            const parsed = parseTaskInboxRecord(record);
            if (parsed.source !== reader.source)
              throw new Error("Task reader returned a different source");
            return parsed;
          });
          return { source: reader.source, records };
        } catch (error) {
          try {
            this.options.onError?.(reader.source, error);
          } catch {
            /* Diagnostics cannot stop reconciliation. */
          }
          return {
            source: reader.source,
            error:
              error instanceof Error
                ? error.message.slice(0, 2048) || "Source unavailable"
                : "Source unavailable",
          };
        }
      }),
    );
    return this.options.store.reconcile(results);
  }
}
export function createTaskInboxProjector(options: TaskInboxProjectorOptions): TaskInboxProjector {
  return new TaskInboxProjector(options);
}
