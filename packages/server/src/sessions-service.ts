/**
 * List session files persisted by the agent worker.
 * Uses core's canonical session root so CODE_SHELL_HOME matches the worker.
 */

import { sessionsRoot } from "@cjhyy/code-shell-core";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

export interface DesktopSessionSummary {
  id: string;
  /** Path to the session file on disk. */
  file: string;
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
    const summaries: DesktopSessionSummary[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".jsonl") && !e.name.endsWith(".json")) continue;
      const id = e.name.replace(/\.jsonl?$/, "");
      if (isQuickChatSessionId(id)) continue;
      const full = path.join(baseDir, e.name);
      try {
        const st = await fs.stat(full);
        summaries.push({
          id,
          file: full,
          size: st.size,
          createdAt: st.birthtimeMs || st.mtimeMs,
          updatedAt: st.mtimeMs,
        });
      } catch {
        // Skip files we cannot stat (race with delete, permissions).
      }
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
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

export interface DiskSessionMeta {
  id: string;
  engineSessionId: string; // == directory name; reused as the UI session id
  cwd: string;
  title: string;
  updatedAt: number;
  /** Session origin — only "desktop" / "automation" are listed (see filter). */
  origin: "desktop" | "automation";
  /** Normalized durable status for Pet/display consumers. */
  status?: "active" | "paused" | "completed" | "failed" | "cancelled";
  /** Durable archival timestamp; absent = not archived. */
  archivedAt?: number;
}

export interface ListDiskSessionsResult {
  sessions: DiskSessionMeta[];
  nextCursor: string | null; // opaque stable position in the mtime-sorted catalog; null = no more
}

interface DiskSessionCursor {
  mtime: number;
  id: string;
}

function encodeDiskSessionCursor(cursor: DiskSessionCursor): string {
  return `v1:${cursor.mtime}:${cursor.id}`;
}

function decodeDiskSessionCursor(value: string | undefined): DiskSessionCursor | number | null {
  if (!value) return 0;
  // Keep accepting the old numeric offset during upgrades. New responses use
  // a stable tuple so deleting an item from an earlier page cannot shift and
  // skip a later session.
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^v1:([^:]+):([A-Za-z0-9._-]+)$/.exec(value);
  if (!match) return null;
  const mtime = Number(match[1]);
  return Number.isFinite(mtime) ? { mtime, id: match[2]! } : null;
}

/**
 * List top-level (non-sub-agent) sessions from disk, newest first, paginated.
 * Filter on state.json `parentSessionId`:
 *   - key absent  → legacy → skip (存量 not auto-rebuilt)
 *   - null / ""   → top-level → show
 *   - non-empty   → sub-agent → filter out
 */
export async function listDiskSessions(
  opts: { limit: number; cursor?: string; includeArchived?: boolean },
  baseDir: string = sessionsRoot(),
): Promise<ListDiskSessionsResult> {
  // Async fs throughout: this is an IPC handler on the Electron main thread
  // (sessions:listDisk). The previous synchronous statSync/readFileSync loops
  // never yielded the event loop and froze the UI while enumerating sessions.
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], nextCursor: null };
    throw e;
  }
  const candidates = entries.filter(
    (e) => e.isDirectory() && SAFE_ID.test(e.name) && !isQuickChatSessionId(e.name),
  );
  const stats = await Promise.all(
    candidates.map(async (e) => {
      try {
        return { id: e.name, mtime: (await fs.stat(path.join(baseDir, e.name))).mtimeMs };
      } catch {
        return null; // skip unreadable
      }
    }),
  );
  const dirs = stats.filter((d): d is { id: string; mtime: number } => d !== null);
  dirs.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));

  const decodedCursor = decodeDiskSessionCursor(opts.cursor);
  if (decodedCursor === null) return { sessions: [], nextCursor: null };
  const start =
    typeof decodedCursor === "number"
      ? Math.max(0, decodedCursor)
      : (() => {
          const index = dirs.findIndex(
            (entry) =>
              entry.mtime < decodedCursor.mtime ||
              (entry.mtime === decodedCursor.mtime && entry.id > decodedCursor.id),
          );
          return index < 0 ? dirs.length : index;
        })();
  const sessions: DiskSessionMeta[] = [];
  // Cache cwd existence across the loop — many sessions share one project root,
  // and we must not re-stat it per session (nor block on a sync existsSync,
  // which the async-throughout rewrite above was meant to eliminate).
  const cwdExists = new Map<string, boolean>();
  const pathExists = async (cwdStr: string): Promise<boolean> => {
    const cached = cwdExists.get(cwdStr);
    if (cached !== undefined) return cached;
    const ok = await fs
      .access(cwdStr)
      .then(() => true)
      .catch(() => false);
    cwdExists.set(cwdStr, ok);
    return ok;
  };
  let i = start;
  for (; i < dirs.length && sessions.length < opts.limit; i++) {
    const { id, mtime } = dirs[i]!;
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await fs.readFile(path.join(baseDir, id, "state.json"), "utf8"));
    } catch {
      continue;
    }
    if (state.ephemeral === true) continue;
    if (state.kind === "pet") continue;
    if (!("parentSessionId" in state)) continue; // legacy → skip
    if (state.parentSessionId) continue; // sub-agent (non-empty) → filter
    // Only desktop + automation belong in the desktop sidebar. tui / missing
    // origin are filtered out (tui shares ~/.code-shell; legacy has no origin).
    const origin = state.origin;
    if (origin !== "desktop" && origin !== "automation") continue;
    // Skip sessions whose project root has been deleted. Listing them led the
    // renderer's disk-rebuild to call createRepoForCwd → the deleted project
    // reappeared in the sidebar, and any subsequent write under that cwd
    // resurrected it on disk as an empty shell. An empty cwd (no-repo session)
    // is intentionally NOT filtered here — the renderer handles that via
    // isNoRepoCwd. (deleted-project resurrection)
    const cwdStr = typeof state.cwd === "string" ? state.cwd : "";
    if (cwdStr && !(await pathExists(cwdStr))) continue;
    // Archived sessions are hidden from the default catalog. Filtering happens
    // before the push (like every other skip above), so the mtime cursor —
    // derived from the dirs[] position, not from how many rows we kept — keeps
    // advancing across archived rows: a page may return fewer than `limit`
    // sessions, but no live session is skipped and the cursor never stalls.
    const archivedAt = typeof state.archivedAt === "number" ? state.archivedAt : undefined;
    if (archivedAt !== undefined && !opts.includeArchived) continue;
    sessions.push({
      id,
      engineSessionId: id,
      cwd: typeof state.cwd === "string" ? state.cwd : "",
      // Prefer the LLM-generated title (now persisted to state); fall back to
      // the raw first-message summary, then the id. This lets the disk rebuild
      // surface the real title after a localStorage wipe.
      title:
        (typeof state.title === "string" && state.title ? state.title : undefined) ??
        (typeof state.summary === "string" && state.summary ? state.summary : id),
      updatedAt: mtime,
      origin,
      status:
        state.status === "active" || state.status === "paused" || state.status === "completed"
          ? state.status
          : state.status === "aborted_streaming" || state.status === "aborted_tools"
            ? "cancelled"
            : typeof state.status === "string"
              ? "failed"
              : undefined,
      ...(archivedAt !== undefined ? { archivedAt } : {}),
    });
  }
  return {
    sessions,
    nextCursor: i < dirs.length && i > 0 ? encodeDiskSessionCursor(dirs[i - 1]!) : null,
  };
}
