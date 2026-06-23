/**
 * List session files persisted by the agent worker.
 * Sessions are JSONL files under ~/.code-shell/sessions/.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface DesktopSessionSummary {
  id: string;
  /** Path to the session file on disk. */
  file: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

const SESSIONS_DIR = path.join(os.homedir(), ".code-shell", "sessions");

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

export async function listSessions(): Promise<DesktopSessionSummary[]> {
  try {
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
    const summaries: DesktopSessionSummary[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".jsonl") && !e.name.endsWith(".json")) continue;
      const full = path.join(SESSIONS_DIR, e.name);
      try {
        const st = await fs.stat(full);
        summaries.push({
          id: e.name.replace(/\.jsonl?$/, ""),
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
  baseDir: string = SESSIONS_DIR,
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

export interface DiskSessionMeta {
  id: string;
  engineSessionId: string; // == directory name; reused as the UI session id
  cwd: string;
  title: string;
  updatedAt: number;
  /** Session origin — only "desktop" / "automation" are listed (see filter). */
  origin: "desktop" | "automation";
}

export interface ListDiskSessionsResult {
  sessions: DiskSessionMeta[];
  nextCursor: string | null; // index into the mtime-sorted dir list; null = no more
}

/**
 * List top-level (non-sub-agent) sessions from disk, newest first, paginated.
 * Filter on state.json `parentSessionId`:
 *   - key absent  → legacy → skip (存量 not auto-rebuilt)
 *   - null / ""   → top-level → show
 *   - non-empty   → sub-agent → filter out
 */
export async function listDiskSessions(
  opts: { limit: number; cursor?: string },
  baseDir: string = SESSIONS_DIR,
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
  const candidates = entries.filter((e) => e.isDirectory() && SAFE_ID.test(e.name));
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
  dirs.sort((a, b) => b.mtime - a.mtime);

  const start = opts.cursor ? Number(opts.cursor) : 0;
  const sessions: DiskSessionMeta[] = [];
  // Cache cwd existence across the loop — many sessions share one project root,
  // and we must not re-stat it per session (nor block on a sync existsSync,
  // which the async-throughout rewrite above was meant to eliminate).
  const cwdExists = new Map<string, boolean>();
  const pathExists = async (cwdStr: string): Promise<boolean> => {
    const cached = cwdExists.get(cwdStr);
    if (cached !== undefined) return cached;
    const ok = await fs.access(cwdStr).then(() => true).catch(() => false);
    cwdExists.set(cwdStr, ok);
    return ok;
  };
  let i = start;
  for (; i < dirs.length && sessions.length < opts.limit; i++) {
    const { id, mtime } = dirs[i]!;
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await fs.readFile(path.join(baseDir, id, "state.json"), "utf8"));
    } catch { continue; }
    if (!("parentSessionId" in state)) continue;          // legacy → skip
    if (state.parentSessionId) continue;                  // sub-agent (non-empty) → filter
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
    });
  }
  return { sessions, nextCursor: i < dirs.length ? String(i) : null };
}

export { getSessionTranscript } from "./transcript-reader.js";

/** A sub-agent session that appears to have been INTERRUPTED (C). */
export interface InterruptedSubagent {
  id: string; // == sub-agent session id (== agentId)
  /** Human-readable task hint — the sub-agent's persisted `summary` (its
   *  Handoff Packet / first-message head), falling back to the id. */
  description: string;
  /** Last on-disk activity (state.json mtime) — when it stalled. */
  updatedAt: number;
}

/**
 * Statuses that should NOT be surfaced as "interrupted":
 *  - completed: finished the work cleanly.
 *  - cancelled: the user deliberately stopped it (not a surprise to flag).
 * Everything else — stuck "active" (crash/kill mid-flight), or an error end
 * (failed / model_error / aborted_streaming) — means the work didn't finish, so
 * it's worth telling the user on reopen. The staleness gate still applies so a
 * genuinely still-running "active" agent isn't mislabeled. Observed real
 * statuses on disk: completed (clean), active (stuck), model_error,
 * aborted_streaming. (validated against ~/.code-shell/sessions)
 */
const NOT_INTERRUPTED_STATUSES = new Set(["completed", "cancelled"]);

/**
 * List sub-agents of `parentSessionId` that look INTERRUPTED — shown when a
 * session is reopened so the user sees "上次有个子代理没跑完" instead of it
 * silently vanishing (C: background-agent visibility).
 *
 * Interrupted ≡ a sub-agent session (origin "subagent" + parentSessionId ===
 * parent) whose status is non-terminal (stuck at "active") AND whose state.json
 * has gone stale (mtime older than `staleMs`). Staleness is the liveness gate:
 * a still-running agent keeps writing (transcript/state) so its mtime stays
 * fresh; a crashed/killed one (no graceful shutdown to mark it terminal) stops.
 * The threshold must exceed the LLM-long-request silence (~8min observed), so
 * the default is generous (10min): a genuinely-running agent is never mislabeled
 * interrupted; the cost is a freshly-died one isn't flagged until the threshold
 * passes — fine, since reopen is usually minutes later.
 *
 * Read-only: no resume, no new messages. Recovery = the user re-asks the
 * orchestrator, which re-spawns and reads the on-disk artifacts.
 */
export async function listInterruptedSubagents(
  parentSessionId: string,
  baseDir: string = SESSIONS_DIR,
  opts: { staleMs?: number; now?: number } = {},
): Promise<InterruptedSubagent[]> {
  if (!parentSessionId) return [];
  const staleMs = opts.staleMs ?? 10 * 60_000; // 10min — covers LLM long-request silence
  const now = opts.now ?? Date.now();

  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const out: InterruptedSubagent[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SAFE_ID.test(e.name)) continue;
    const stateFile = path.join(baseDir, e.name, "state.json");
    let state: Record<string, unknown>;
    let mtimeMs: number;
    try {
      const [raw, st] = await Promise.all([
        fs.readFile(stateFile, "utf8"),
        fs.stat(stateFile),
      ]);
      state = JSON.parse(raw);
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // unreadable / missing → skip
    }
    if (state.parentSessionId !== parentSessionId) continue; // not a child of this session
    const status = typeof state.status === "string" ? state.status : "active";
    if (NOT_INTERRUPTED_STATUSES.has(status)) continue; // clean finish / user-cancelled → skip
    if (now - mtimeMs < staleMs) continue; // still fresh → may be running, don't flag

    const summary = typeof state.summary === "string" ? state.summary.trim() : "";
    out.push({
      id: e.name,
      description: summary || e.name,
      updatedAt: mtimeMs,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt); // newest-stalled first
  return out;
}
