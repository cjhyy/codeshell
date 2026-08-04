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
import { sessionSelectorId } from "./selector.js";

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
  summary?: unknown;
  title?: unknown;
  cwd?: unknown;
  status?: unknown;
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
    const session = await readWorkSessionOnDisk(sessionsRootDir, sessionId);
    if (session) sessions.push(session);
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.slice(0, options.limit);
}

/**
 * Resolve one exact ordinary Work Session through the same policy as L1 list.
 * Keeping this check at the read boundary prevents callers that learned an
 * internal id elsewhere from bypassing Pet/sub-agent/child/ephemeral filters.
 */
export async function readWorkSessionOnDisk(
  sessionsRootDir: string,
  sessionId: string,
): Promise<DiskWorkSession | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) return null;
  const sessionDir = join(sessionsRootDir, sessionId);
  let state: DiskSessionState;
  try {
    const raw = await readFile(join(sessionDir, "state.json"), "utf-8");
    state = JSON.parse(raw) as DiskSessionState;
  } catch {
    return null;
  }

  if (state.kind === "pet") return null;
  if (state.origin === "subagent") return null;
  if (state.parentSessionId) return null;
  if (state.ephemeral) return null;

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(join(sessionDir, "transcript.jsonl"))).mtimeMs;
  } catch {
    try {
      mtimeMs = (await stat(join(sessionDir, "state.json"))).mtimeMs;
    } catch {
      return null;
    }
  }

  const title = (
    typeof state.title === "string"
      ? state.title
      : typeof state.summary === "string"
        ? state.summary
        : sessionId
  ).slice(0, 160);
  const cwd = typeof state.cwd === "string" ? state.cwd : null;
  const status = typeof state.status === "string" ? state.status : undefined;
  return {
    sessionId,
    title,
    cwd,
    ...(status !== undefined ? { status } : {}),
    updatedAt: Math.round(mtimeMs),
  };
}

/**
 * Resolve one opaque host-issued selector without loading and sorting every
 * Session state. Directory names are the only candidates hashed; the ordinary
 * Work Session policy is applied by the exact reader after a match.
 */
export async function readWorkSessionBySelectorOnDisk(
  sessionsRootDir: string,
  selectorId: string,
): Promise<DiskWorkSession | null> {
  if (!/^session-[a-f0-9]{20}$/u.test(selectorId)) return null;
  let entries: string[];
  try {
    entries = (await readdir(sessionsRootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const sessionId = entries.find((candidate) => sessionSelectorId(candidate) === selectorId);
  return sessionId ? readWorkSessionOnDisk(sessionsRootDir, sessionId) : null;
}
