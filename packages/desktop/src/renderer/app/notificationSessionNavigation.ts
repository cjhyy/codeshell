import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import type { SessionIndex, SessionSummary } from "../../shared/session-catalog";

export const OPEN_NOTIFICATION_SESSION_EVENT = "codeshell:open-notification-session";

interface IndexedSession {
  projectId: string | null;
  session: SessionSummary;
}

export function findNotificationSession(
  indices: Record<string, SessionIndex>,
  sessionId: string,
): IndexedSession | null {
  for (const [projectKey, index] of Object.entries(indices)) {
    const session = index.sessions.find(
      (candidate) => candidate.engineSessionId === sessionId || candidate.id === sessionId,
    );
    if (session) {
      return { projectId: projectKey === "__no_repo__" ? null : projectKey, session };
    }
  }
  return null;
}

interface ResolutionDeps {
  currentIndices: () => Record<string, SessionIndex>;
  persistedIndices: () => Record<string, SessionIndex>;
  listDiskSessions?: (opts: { limit: number; cursor?: string }) => Promise<{
    sessions: DiskSessionMeta[];
    nextCursor: string | null;
  }>;
}

type NotificationSessionTarget =
  | { kind: "indexed"; target: IndexedSession }
  | { kind: "disk"; session: DiskSessionMeta };

/** Resolve existing identity only: a notification must never manufacture a blank chat. */
export async function resolveNotificationSession(
  sessionId: string,
  deps: ResolutionDeps,
): Promise<NotificationSessionTarget | null> {
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  const indexed = () => {
    const current = findNotificationSession(deps.currentIndices(), sessionId);
    const persisted = findNotificationSession(deps.persistedIndices(), sessionId);
    // A row removed from durable state may still be in React's prior render.
    // Do not resurrect it while the engine directory is being deleted.
    if (current && !persisted) return { unavailable: true } as const;
    if (persisted?.session.archived) return { unavailable: true } as const;
    return persisted ? ({ kind: "indexed", target: persisted } as const) : null;
  };
  const existing = indexed();
  if (existing) return "unavailable" in existing ? null : existing;
  if (!deps.listDiskSessions) return null;

  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await deps.listDiskSessions({ limit: 100, ...(cursor ? { cursor } : {}) });
    const session = page.sessions.find(
      (candidate) => candidate.engineSessionId === sessionId || candidate.id === sessionId,
    );
    // Re-check after I/O: another import or a deletion may have completed.
    const latest = indexed();
    if (latest) return "unavailable" in latest ? null : latest;
    if (session) {
      // Child sessions cannot be placed by the ordinary sidebar importer.
      if (session.parentSessionId || session.origin === "subagent") return null;
      return { kind: "disk", session };
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) return null;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return null;
}
