import { MAX_HISTORY_STATE_BYTES, readHistorySummary } from "./session-history-summary.js";
/**
 * List session files persisted by the agent worker.
 * Uses core's canonical session root so CODE_SHELL_HOME matches the worker.
 */

import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import {
  scanSessionDirectories,
  readSessionListState,
  SessionFileError,
} from "@cjhyy/code-shell-host/session-files";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  checkListIds,
  collectDiskSessionPage,
  comparePositions,
  decodeCursor,
  isListDirectory,
  projectDiskSessionState,
  type DiskSessionListOptions,
  type ListDiskSessionsResult,
} from "./disk-session-list.js";

export interface DesktopSessionSummary {
  id: string;
  /** Path to the session file on disk. */
  file: string;
  /** Durable title/summary; UI-side renamed titles can override it. */
  title?: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
const QUICK_CHAT_SESSION_PREFIX = "qchat-";

function isQuickChatSessionId(id: string): boolean {
  return id.startsWith(QUICK_CHAT_SESSION_PREFIX);
}

export async function listSessions(
  baseDir: string = sessionsRoot(),
): Promise<DesktopSessionSummary[]> {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    // Prefer the current directory layout when a migration left a flat copy.
    const candidates = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()));
    const summaries = new Map<string, DesktopSessionSummary>();
    for (let offset = 0; offset < candidates.length; offset += 32) {
      const batch = await Promise.all(
        candidates.slice(offset, offset + 32).map((entry) => readHistorySummary(entry, baseDir)),
      );
      for (const summary of batch) {
        if (summary && !summaries.has(summary.id)) summaries.set(summary.id, summary);
      }
    }
    return [...summaries.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/**
 * Remove a session's on-disk data. Modern sessions are a directory
 * `<sessionsDir>/<id>/` (transcript.jsonl + state.json — see core
 * session-manager.ts:93,141). Pre-directory sessions were flat
 * `<id>.jsonl`/`<id>.json` files; we remove those too for back-compat.
 * `baseDir` is overridable for tests. Unsafe ids (slashes / "." / "..")
 * are rejected without any filesystem access.
 */
export async function deleteSessionDir(
  id: string,
  baseDir: string = sessionsRoot(),
): Promise<void> {
  if (!SAFE_ID.test(id) || id === "." || id === "..") return;
  // Directory form (current).
  await fs.rm(path.join(baseDir, id), { recursive: true, force: true });
  // Legacy flat files.
  for (const ext of [".jsonl", ".json"]) {
    try {
      await fs.unlink(path.join(baseDir, `${id}${ext}`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/** @deprecated retained for the existing IPC handler; delegates to deleteSessionDir. */
export async function deleteSession(id: string): Promise<void> {
  await deleteSessionDir(id);
}

/**
 * Reap quick-chat data left by an unclean prior desktop exit. This must run
 * before a new renderer/worker can claim a qchat id; normal live cleanup is
 * coordinated by QuickChatOwnershipRegistry instead.
 */
export async function cleanupStaleQuickChatSessions(
  baseDir: string = sessionsRoot(),
): Promise<string[]> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const ids = new Set<string>();
  const stagingDirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SAFE_ID.test(entry.name) && isQuickChatSessionId(entry.name)) {
      ids.add(entry.name);
      continue;
    }
    if (entry.isDirectory() && entry.name.startsWith(".pending-fork-")) {
      try {
        const state = JSON.parse(
          await fs.readFile(path.join(baseDir, entry.name, "state.json"), "utf8"),
        ) as Record<string, unknown>;
        if (
          state.ephemeral === true &&
          typeof state.sessionId === "string" &&
          isQuickChatSessionId(state.sessionId)
        ) {
          stagingDirs.push(entry.name);
        }
      } catch {
        // Missing, malformed, or unreadable state cannot prove ephemeral
        // ownership, so fail closed and leave the staging directory intact.
      }
      continue;
    }
    if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".json"))) {
      continue;
    }
    const id = entry.name.replace(/\.jsonl?$/, "");
    if (SAFE_ID.test(id) && isQuickChatSessionId(id)) ids.add(id);
  }

  for (const id of ids) await deleteSessionDir(id, baseDir);
  for (const stagingDir of stagingDirs) {
    await fs.rm(path.join(baseDir, stagingDir), { recursive: true, force: true });
  }
  return [...ids, ...stagingDirs];
}

export type {
  DiskSessionMeta,
  ListDiskSessionsResult,
  DiskSessionListOptions,
} from "./disk-session-list.js";

/** File-backed catalog, also used when the derived index is unavailable. */
export async function listDiskSessions(
  opts: DiskSessionListOptions,
  baseDir: string = sessionsRoot(),
): Promise<ListDiskSessionsResult> {
  checkListIds(opts);
  baseDir = path.resolve(baseDir);
  const dirs = (await scanSessionDirectories(baseDir, opts.sessionId))
    .filter(({ id }) => isListDirectory(id))
    .sort(comparePositions);
  const cursor = decodeCursor(opts.cursor);
  if (cursor === null) return { sessions: [], nextCursor: null };
  const start =
    typeof cursor === "number"
      ? cursor
      : dirs.findIndex((entry) => comparePositions(entry, cursor) > 0);
  if (start < 0 || start >= dirs.length) return { sessions: [], nextCursor: null };
  return collectDiskSessionPage(
    opts,
    dirs.slice(start),
    async ({ id, mtime }) => {
      try {
        const state = JSON.parse(await readSessionListState(baseDir, id, MAX_HISTORY_STATE_BYTES));
        return projectDiskSessionState(id, mtime, state);
      } catch (error) {
        if (error instanceof SessionFileError && error.code === "too_large") {
          process.emitWarning(
            `Session ${id}: state.json exceeds the 2 MiB catalog metadata limit; entry omitted.`,
            { code: "SESSION_LIST_STATE_TOO_LARGE" },
          );
        }
        return null;
      }
    },
    dirs[start - 1],
  );
}

/**
 * Set (number) or clear (undefined) a session's durable archival marker on
 * disk, then atomically replace `state.json`. This is the main-process writer
 * counterpart to `listDiskSessions`' `archivedAt` filter: main has no live
 * Engine/SessionManager handle, so it mutates the same `state.json` the worker
 * persists. The rest of the state is preserved verbatim; only `archivedAt` is
 * added or removed. Unsafe ids and missing sessions throw.
 */
export async function archiveDiskSession(
  id: string,
  archivedAt: number | undefined,
  baseDir: string = sessionsRoot(),
): Promise<void> {
  if (!SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(`archiveDiskSession: unsafe session id ${JSON.stringify(id)}`);
  }
  // Route through Core's SessionManager instead of hand-rolling the write.
  //
  // This used to read the whole state.json, set/delete `archivedAt`, and rename a
  // full replacement over it — with no lock and no revision check. A live worker
  // saving token usage, goal, workspace, title or status at the same instant
  // meant two full snapshots racing, and only one survived: archiving could roll
  // back a just-saved field, or a worker save could erase `archivedAt`.
  //
  // `setSessionArchived` → `updateSessionState` already does this correctly: it
  // takes the per-session lock, compares `stateRevision`, re-reads and merges at
  // field level on a CAS miss, and retries. Archiving is a field-level update, so
  // it belongs on exactly that path.
  const manager = new SessionManager(baseDir);
  manager.setSessionArchived(id, archivedAt);
}
