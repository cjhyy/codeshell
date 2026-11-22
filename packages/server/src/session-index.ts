import { lstatSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { openStateStorage, type StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { assertSessionFileId } from "@cjhyy/code-shell-host/session-files";
import { listDiskSessions } from "./sessions-service.js";
import { listIndexedDiskSessions } from "./indexed-disk-sessions.js";

type ListOptions = Parameters<typeof listDiskSessions>[0];

export interface SessionIndex {
  list(options: ListOptions): ReturnType<typeof listDiskSessions>;
  changed(id: string): Promise<void>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

export function createSessionIndex(
  root: string,
  options: { workerUrl?: URL; storage?: Promise<StateStorage> } = {},
): SessionIndex {
  const sessionsRoot = resolve(root);
  const storage =
    options.storage ??
    openStateStorage(sessionsRoot, {
      workerUrl: options.workerUrl ?? new URL("./session-index-worker.js", import.meta.url),
    });
  let closed = false;
  let usable = true;
  let watcher: FSWatcher | undefined;
  let watchedInode: number | undefined;
  const dirty = new Map<string, number>();
  const queued = new Set<string>();
  let revision = 0;
  let batch: Promise<void> | undefined;
  let full: Promise<void> | undefined;

  async function reconcile(ids?: string[]) {
    const db = await storage;
    if (closed || db.mode !== "sqlite") return;
    try {
      const ok = await db.request<boolean>("sessions/reconcile", ids);
      if (!ok) usable = false;
      else if (!ids) usable = true;
    } catch {
      // A failed incremental update invalidates this snapshot until a full
      // pass succeeds. JSON remains authoritative and available in the interim.
      usable = false;
    }
  }

  function changed(id: string): Promise<void> {
    if (closed) return Promise.resolve();
    assertSessionFileId(id);
    dirty.set(id, ++revision);
    queued.add(id);
    return (batch ??= Promise.resolve().then(async () => {
      while (queued.size && !closed) {
        const ids: string[] = [];
        for (const key of queued) {
          ids.push(key);
          queued.delete(key);
          if (ids.length === 512) break;
        }
        const watermark = revision;
        await reconcile(ids);
        for (const key of ids) if ((dirty.get(key) ?? 0) <= watermark) dirty.delete(key);
      }
      batch = undefined;
    }));
  }

  // A non-recursive watch picks up legacy clients creating/removing directories.
  // Changes within old sessions are reconciled periodically. Current Desktop
  // writers notify the Host after committing state.json.
  function watchRoot() {
    try {
      const info = lstatSync(sessionsRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        watcher?.close();
        watcher = undefined;
        return;
      }
      if (watcher && watchedInode === info.ino) return;
      watcher?.close();
      watchedInode = info.ino;
      const next = watch(sessionsRoot, { persistent: false }, (_event, name) => {
        if (name && /^[A-Za-z0-9_.-]{1,128}$/.test(name) && name !== "." && !name.includes(".."))
          void changed(name);
      });
      watcher = next;
      next.on("error", () => {
        next.close();
        if (next === watcher) watcher = undefined;
      });
    } catch {
      watcher?.close();
      watcher = undefined;
    }
  }

  function reconcileAll(): Promise<void> {
    if (closed) return Promise.resolve();
    watchRoot();
    return (full ??= reconcile().finally(() => {
      full = undefined;
    }));
  }

  watchRoot();
  const timer = setInterval(() => {
    void reconcileAll();
  }, 60_000);
  timer.unref();
  return {
    async list(options) {
      const db = await storage;
      if (
        !closed &&
        usable &&
        db.mode === "sqlite" &&
        !(options.sessionId && dirty.has(options.sessionId))
      ) {
        const page = await listIndexedDiskSessions(db, options);
        if (page) {
          if (!options.sessionId || page.sessions.length || options.cursor) return page;
          // A legacy writer can create its directory, allow the watcher to run,
          // then atomically publish state.json. Recover this ID without scanning
          // other Sessions or waiting for the next minute-long reconciliation.
          const current = await listDiskSessions(options, sessionsRoot);
          if (current.sessions.length) void changed(options.sessionId);
          return current;
        }
      }
      return listDiskSessions(options, sessionsRoot);
    },
    changed,
    reconcile: reconcileAll,
    async close() {
      closed = true;
      clearInterval(timer);
      watcher?.close();
      await batch;
      await full;
      if (!options.storage) await (await storage).close();
    },
  };
}
