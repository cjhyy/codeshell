import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import type { SessionIndex } from "../../shared/session-catalog";
import { NO_REPO_KEY } from "../transcripts";

export interface ActivitySessionAdapter {
  sessionIndices: Record<string, SessionIndex>;
  selectSession(projectId: string | null, sessionId: string): void | Promise<void>;
  listDiskSessions(options: {
    limit: number;
    cursor?: string;
  }): Promise<{ sessions: DiskSessionMeta[]; nextCursor?: string | null }>;
  openDiskSession(session: DiskSessionMeta): Promise<void>;
  /** A newer selection or page navigation invalidates this opening intent. */
  isCurrent?(): boolean;
}

/** Resolve both UI and engine IDs using the original session's workspace metadata. */
export async function openActivitySession(
  sessionId: string,
  adapter: ActivitySessionAdapter,
): Promise<boolean> {
  if (adapter.isCurrent && !adapter.isCurrent()) return false;
  for (const [projectKey, index] of Object.entries(adapter.sessionIndices)) {
    const session = index.sessions.find(
      (item) => item.id === sessionId || item.engineSessionId === sessionId,
    );
    if (session) {
      await adapter.selectSession(projectKey === NO_REPO_KEY ? null : projectKey, session.id);
      return true;
    }
  }
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await adapter.listDiskSessions({ limit: 200, ...(cursor ? { cursor } : {}) });
    if (adapter.isCurrent && !adapter.isCurrent()) return false;
    const session = page.sessions.find(
      (item) => item.id === sessionId || item.engineSessionId === sessionId,
    );
    if (session) {
      await adapter.openDiskSession(session);
      return true;
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor)) return false;
      cursors.add(cursor);
    }
  } while (cursor);
  return false;
}
