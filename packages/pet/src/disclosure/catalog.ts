/**
 * L1 disclosure: the catalog of on-disk work sessions, one entry per
 * ~/.code-shell/sessions/<id> directory. Excludes Pet's own sessions,
 * sub-agent runs, forked children, and ephemeral side chats — the same
 * "ordinary resume/session picker" set the desktop disk-rebuild uses.
 *
 * state.json field names are the persisted SessionState contract from
 * packages/core/src/session/session-manager.ts / types.ts — kept in sync by
 * convention since this package cannot import core runtime.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DiskWorkSession {
  sessionId: string;
  title: string;
  cwd: string | null;
  status?: string;
  updatedAt: number;
}

interface DiskSessionState {
  kind?: string;
  origin?: string;
  parentSessionId?: string | null;
  ephemeral?: boolean;
  summary?: string;
  title?: string;
  cwd?: unknown;
  status?: string;
}

export async function listWorkSessionsOnDisk(
  sessionsRootDir: string,
  options: { limit: number },
): Promise<DiskWorkSession[]> {
  let entries: string[];
  try {
    entries = (await readdir(sessionsRootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const sessions: DiskWorkSession[] = [];
  for (const sessionId of entries) {
    const sessionDir = join(sessionsRootDir, sessionId);
    let state: DiskSessionState;
    try {
      const raw = await readFile(join(sessionDir, "state.json"), "utf-8");
      state = JSON.parse(raw) as DiskSessionState;
    } catch {
      continue;
    }

    if (state.kind === "pet") continue;
    if (state.origin === "subagent") continue;
    if (state.parentSessionId) continue;
    if (state.ephemeral) continue;

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(sessionDir, "transcript.jsonl"))).mtimeMs;
    } catch {
      try {
        mtimeMs = (await stat(join(sessionDir, "state.json"))).mtimeMs;
      } catch {
        continue;
      }
    }

    const title = (state.title ?? state.summary ?? sessionId).slice(0, 160);
    const cwd = typeof state.cwd === "string" ? state.cwd : null;

    sessions.push({
      sessionId,
      title,
      cwd,
      ...(state.status !== undefined ? { status: state.status } : {}),
      updatedAt: Math.round(mtimeMs),
    });
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.slice(0, options.limit);
}
