import type { TaskInboxRecordV1 } from "../../preload/task-inbox-api";
import type { PetExternalSessionLocator } from "../../preload/types";
import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import { openActivitySession } from "../activity/openActivitySession";
import type { SessionIndex } from "../../shared/session-catalog";
import { taskInboxOpenTarget } from "./taskInboxViewModel";

export interface TaskInboxNavigationAdapter {
  sessionIndices: Record<string, SessionIndex>;
  selectSession(projectId: string | null, sessionId: string): void | Promise<void>;
  listDiskSessions(options: {
    limit: number;
    cursor?: string;
  }): Promise<{ sessions: DiskSessionMeta[]; nextCursor?: string | null }>;
  openDiskSession(session: DiskSessionMeta): Promise<void>;
  openHistorySession?(sessionId: string): Promise<"opened" | "unavailable" | "cancelled">;
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
  if (adapter.openHistorySession) {
    const result = await adapter.openHistorySession(target.sessionId);
    if (result === "opened" || result === "cancelled") return true;
  } else if (await openActivitySession(target.sessionId, adapter)) return true;
  return openRetainedSourceDetails(record, adapter);
}
