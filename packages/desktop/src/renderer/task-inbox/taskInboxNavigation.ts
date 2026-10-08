import type { TaskInboxRecordV1, PetExternalSessionLocator } from "../../preload/types";
import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import { NO_REPO_KEY } from "../transcripts";
import type { SessionIndex } from "../../shared/session-catalog";
import { taskInboxOpenTarget } from "./taskInboxViewModel";

export interface TaskInboxNavigationAdapter {
  sessionIndices: Record<string, SessionIndex>;
  selectSession(projectId: string | null, sessionId: string): void;
  listDiskSessions(options: {
    limit: number;
    cursor?: string;
  }): Promise<{ sessions: DiskSessionMeta[]; nextCursor?: string | null }>;
  openDiskSession(session: DiskSessionMeta): Promise<void>;
  openMimi(taskId: string): void;
  openMimiSession?(sessionId: string): Promise<boolean>;
  openExternalSession?(target: PetExternalSessionLocator): Promise<boolean>;
  openAutomation(automationId: string): void;
  openRun(runId: string): void;
}

function openRetainedSourceDetails(
  record: TaskInboxRecordV1,
  adapter: TaskInboxNavigationAdapter,
): boolean {
  if (record.source === "mimi-delegation") {
    adapter.openMimi(record.sourceId);
    return true;
  }
  if (record.source === "legacy-run") {
    adapter.openRun(record.sourceId);
    return true;
  }
  if (record.source === "automation") {
    adapter.openAutomation(record.automationId ?? record.sourceId);
    return true;
  }
  return false;
}

/** Navigation uses original, authoritative metadata; it never creates a task. */
export async function openTaskInboxRecord(
  record: TaskInboxRecordV1,
  adapter: TaskInboxNavigationAdapter,
): Promise<boolean> {
  if (record.source === "external-runtime" && record.externalCli && record.sessionId) {
    if (!record.workspacePath || !adapter.openExternalSession) return false;
    return adapter.openExternalSession({
      cli: record.externalCli,
      cwd: record.workspacePath,
      sessionId: record.sessionId,
    });
  }
  if (record.source === "mimi-delegation" && record.sessionId && adapter.openMimiSession) {
    if (await adapter.openMimiSession(record.sessionId)) return true;
    return openRetainedSourceDetails(record, adapter);
  }
  const target = taskInboxOpenTarget(record);
  if (!target) return false;
  if (target.kind === "mimi") {
    adapter.openMimi(target.taskId);
    return true;
  }
  if (target.kind === "automation") {
    adapter.openAutomation(target.automationId);
    return true;
  }
  if (target.kind === "run") {
    adapter.openRun(target.runId);
    return true;
  }
  for (const [projectKey, index] of Object.entries(adapter.sessionIndices)) {
    const session = index.sessions.find(
      (item) => item.id === target.sessionId || item.engineSessionId === target.sessionId,
    );
    if (session) {
      adapter.selectSession(projectKey === NO_REPO_KEY ? null : projectKey, session.id);
      return true;
    }
  }
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await adapter.listDiskSessions({ limit: 200, ...(cursor ? { cursor } : {}) });
    const session = page.sessions.find(
      (item) => item.id === target.sessionId || item.engineSessionId === target.sessionId,
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
  return openRetainedSourceDetails(record, adapter);
}
