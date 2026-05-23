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

export async function deleteSession(id: string): Promise<void> {
  const cleanId = id.replace(/[\\/]/g, "");
  for (const ext of [".jsonl", ".json"]) {
    const p = path.join(SESSIONS_DIR, `${cleanId}${ext}`);
    try {
      await fs.unlink(p);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
