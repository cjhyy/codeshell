/**
 * List session files persisted by the agent worker.
 * Sessions are JSONL files under ~/.code-shell/sessions/.
 */

import * as fs from "node:fs/promises";
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

export { getSessionTranscript } from "./transcript-reader.js";
