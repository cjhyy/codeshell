import { parentPort, workerData } from "node:worker_threads";
import { mutateJsonFile } from "../utils/file-mutex.js";
import { openWriter, releaseLease } from "./database.js";
import type { StorageDatabase, StorageStatement } from "./driver.js";

export interface StorageWorkerContext {
  sessionsRoot: string;
  /** Structured-cloned startup configuration supplied by the trusted host. */
  config?: unknown;
  db: StorageDatabase | null;
  /** Only domain handlers choose file paths, validation, and mutation functions. */
  mutateJsonFile: typeof mutateJsonFile;
}

export interface StorageWorkerHandlers {
  initialize?(ctx: StorageWorkerContext): unknown;
  close?(ctx: StorageWorkerContext): unknown;
  handle?(ctx: StorageWorkerContext, command: string, payload: unknown): unknown;
}

/** Entry point for a trusted store-specific worker. Only fixed commands
 * registered by its host are reachable; this is not a renderer transport. */
export async function serveStorageWorker(handlers: StorageWorkerHandlers = {}): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("Storage worker requires a parent");
  const { sessionsRoot, token, config } = workerData as {
    sessionsRoot: string;
    token: string;
    config?: unknown;
  };
  let writer: ReturnType<typeof openWriter>;
  try {
    writer = openWriter(sessionsRoot, token);
  } catch {
    /* Sources and locked JSON mutations remain available. */
  }
  const ctx: StorageWorkerContext = {
    sessionsRoot,
    config,
    db: writer?.db ?? null,
    mutateJsonFile,
  };
  const closeWriter = () => {
    const old = writer;
    writer = undefined;
    ctx.db = null;
    try {
      old?.db.close();
    } finally {
      releaseLease(old?.lease);
    }
  };
  if (writer) port.postMessage({ type: "lease", file: writer.lease });
  try {
    await handlers.initialize?.(ctx);
  } catch {
    // An incomplete reconciliation must never publish a readable index.
    closeWriter();
  }
  let tail = Promise.resolve();
  port.on("message", (message) => {
    tail = tail.then(async () => {
      try {
        let value: unknown;
        switch (message.type) {
          case "write": {
            if (!ctx.db) {
              value = false;
              break;
            }
            const db = ctx.db;
            db.transaction(() => {
              for (const statement of message.statements as StorageStatement[])
                db.run(statement.sql, statement.params);
            });
            value = true;
            break;
          }
          case "command":
            if (!handlers.handle) throw new Error("Unknown storage command");
            value = await handlers.handle(ctx, message.command, message.payload);
            break;
          case "disable":
            try {
              await handlers.close?.(ctx);
            } finally {
              closeWriter();
            }
            break;
          case "close":
            try {
              await handlers.close?.(ctx);
            } finally {
              closeWriter();
            }
            port.postMessage({ id: message.id, value: true });
            port.close();
            return;
          default:
            throw new Error("Unknown storage worker message");
        }
        port.postMessage({ id: message.id, value });
      } catch (error) {
        // SQLite uses primary result codes in the low byte. An ordinary
        // constraint failure rolls back cleanly. A failed device, full disk
        // or unavailable writer must stop serving stale projections.
        const sql = error as { code?: string; errcode?: number };
        const unavailable =
          Boolean(ctx.db) &&
          (message.type === "write"
            ? !(sql?.code?.startsWith("SQLITE_CONSTRAINT") || (Number(sql?.errcode) & 255) === 19)
            : [5, 6, 8, 10, 11, 13, 14, 26].includes(Number(sql?.errcode) & 255) ||
              /^SQLITE_(BUSY|LOCKED|READONLY|IOERR|CORRUPT|FULL|CANTOPEN|NOTADB)/.test(
                sql?.code ?? "",
              ));
        if (unavailable) ctx.db = null;
        port.postMessage({
          unavailable,
          id: message.id,
          error: error instanceof Error ? error.message : "Storage request failed",
        });
      }
    });
  });
  port.postMessage({ type: "ready", file: writer?.file });
}
