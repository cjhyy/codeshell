import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Worker, type MessagePort } from "node:worker_threads";
import { releaseLease } from "./database.js";
import {
  sqliteDriver,
  type SqlValue,
  type StorageDatabase,
  type StorageStatement,
} from "./driver.js";

export interface StateStorage {
  readonly mode: "sqlite" | "json";
  read<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[] | null;
  /** Multiple SELECTs from the same committed WAL snapshot; no writer lock. */
  readSnapshot<T>(read: (db: Pick<StorageDatabase, "all">) => T): T | null;
  /** False means the transaction was not acknowledged. JSON remains authoritative. */
  write(statements: readonly StorageStatement[]): Promise<boolean>;
  /** Null before dispatch if no worker is available. A failed in-flight command
   * rejects, including indeterminate results if the worker died during a mutation. */
  request<T>(command: string, payload?: unknown): Promise<T | null>;
  close(): Promise<void>;
}

const jsonOnly: StateStorage = {
  mode: "json",
  read: () => null,
  readSnapshot: () => null,
  write: async () => false,
  request: async () => null,
  close: async () => {},
};

export async function openStateStorage(
  sessionsRoot: string,
  options: { workerUrl?: URL; workerConfig?: unknown; workerPorts?: readonly MessagePort[] } = {},
): Promise<StateStorage> {
  if (!sessionsRoot) throw new Error("Storage requires an explicit sessions root");
  const token = randomUUID();
  const defaultEntry = import.meta.url.endsWith(".ts") ? "./entry.ts" : "./entry.js";
  let worker: Worker;
  try {
    worker = new Worker(options.workerUrl ?? new URL(defaultEntry, import.meta.url), {
      workerData: { sessionsRoot: resolve(sessionsRoot), token, config: options.workerConfig },
      transferList: options.workerPorts && [...options.workerPorts],
    });
  } catch {
    return jsonOnly;
  }

  let reader: StorageDatabase | undefined;
  let lease: string | undefined;
  let stopped = false;
  let closing: Promise<void> | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const dropReader = () => {
    reader?.close();
    reader = undefined;
  };
  const stop = () => {
    stopped = true;
    dropReader();
    for (const entry of pending.values())
      entry.reject(new Error("Storage worker exited before acknowledging a request"));
    pending.clear();
    resolveReady();
  };
  worker.once("error", stop);
  worker.once("exit", () => {
    stop();
    // A worker may exit abruptly; release its handle only after both the
    // writer and this host's reader are gone.
    releaseLease(lease);
  });
  function send<T>(message: Record<string, unknown>): Promise<T> {
    if (stopped) return Promise.reject(new Error("Storage worker is unavailable"));
    const id = ++sequence;
    worker.ref();
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        worker.postMessage({ ...message, id });
      } catch (error) {
        pending.delete(id);
        reject(error);
        if (!pending.size) worker.unref();
      }
    });
  }
  worker.on("message", (message) => {
    if (message.type === "lease") {
      lease = message.file;
      return;
    }
    if (message.type === "ready") {
      if (message.file) {
        try {
          const open = sqliteDriver();
          if (!open) throw new Error("Read-only driver unavailable");
          reader = open(message.file, true);
          reader.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
        } catch {
          dropReader();
          // The worker must enter JSON mode before the first domain command.
          void send({ type: "disable" }).then(resolveReady, resolveReady);
          return;
        }
      }
      worker.unref();
      resolveReady();
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.unavailable && reader) {
      dropReader();
      void send({ type: "disable" }).catch(() => {});
    }
    if (message.error !== undefined) waiter.reject(new Error(message.error));
    else waiter.resolve(message.value);
    if (!pending.size) worker.unref();
  });
  await ready;
  return {
    get mode() {
      return reader ? "sqlite" : "json";
    },
    read<T>(sql: string, params?: readonly SqlValue[]): T[] | null {
      if (!reader) return null;
      try {
        return reader.all<T>(sql, params);
      } catch {
        // No stale results after a failed query; queued work transitions first.
        dropReader();
        void send({ type: "disable" }).catch(() => {});
        return null;
      }
    },
    readSnapshot<T>(read: (db: Pick<StorageDatabase, "all">) => T): T | null {
      if (!reader) return null;
      try {
        reader.exec("BEGIN DEFERRED");
        const result = read(reader);
        reader.exec("COMMIT");
        return result;
      } catch {
        try {
          reader.exec("ROLLBACK");
        } catch {
          /* BEGIN may itself have failed. */
        } finally {
          dropReader();
          void send({ type: "disable" }).catch(() => {});
        }
        return null;
      }
    },
    async write(statements) {
      if (closing || !reader) return false;
      return send<boolean>({ type: "write", statements }).catch(() => false);
    },
    async request<T>(command: string, payload?: unknown) {
      if (stopped || closing) return null;
      return send<T>({ type: "command", command, payload });
    },
    close() {
      if (!closing) {
        dropReader();
        closing = (stopped ? Promise.resolve() : send<void>({ type: "close" })).finally(
          async () => {
            await worker.terminate();
            releaseLease(lease);
          },
        );
      }
      return closing;
    },
  };
}
