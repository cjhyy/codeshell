import type { TaskInboxRecordV1, TaskStatus } from "../../preload/types";

export const TASK_INBOX_GROUPS = ["waiting", "running", "failed", "done"] as const;
export type TaskInboxGroup = (typeof TASK_INBOX_GROUPS)[number];

export function taskInboxGroup(status: TaskStatus): TaskInboxGroup {
  if (status === "waiting" || status === "paused" || status === "interrupted") return "waiting";
  if (status === "queued" || status === "running") return "running";
  if (status === "failed") return "failed";
  return "done";
}

export interface TaskInboxFilters {
  source: string;
  status: string;
  project: string;
  search: string;
}

/** Missing project IDs still have a useful workspace filter and visible path. */
export function taskInboxProject(record: TaskInboxRecordV1): string {
  return record.projectId ?? record.workspacePath ?? "";
}

export function groupTaskInboxRecords(
  records: readonly TaskInboxRecordV1[],
  filters: TaskInboxFilters,
): Record<TaskInboxGroup, TaskInboxRecordV1[]> {
  const result: Record<TaskInboxGroup, TaskInboxRecordV1[]> = {
    waiting: [],
    running: [],
    failed: [],
    done: [],
  };
  const search = filters.search.trim().toLocaleLowerCase();
  for (const record of records) {
    if (filters.source && record.source !== filters.source) continue;
    if (filters.status && record.status !== filters.status) continue;
    if (filters.project && taskInboxProject(record) !== filters.project) continue;
    if (search && !record.title.toLocaleLowerCase().includes(search)) continue;
    result[taskInboxGroup(record.status)].push(record);
  }
  for (const group of TASK_INBOX_GROUPS) {
    result[group].sort((a, b) => b.updatedAt - a.updatedAt || a.taskKey.localeCompare(b.taskKey));
  }
  return result;
}

export type TaskInboxOpenTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "mimi"; taskId: string }
  | { kind: "automation"; automationId: string }
  | { kind: "run"; runId: string };

export function taskInboxOpenTarget(record: TaskInboxRecordV1): TaskInboxOpenTarget | null {
  if (record.sessionId) return { kind: "session", sessionId: record.sessionId };
  if (record.source === "mimi-delegation") return { kind: "mimi", taskId: record.sourceId };
  if (record.automationId || record.source === "automation") {
    return { kind: "automation", automationId: record.automationId ?? record.sourceId };
  }
  if (record.source === "legacy-run") return { kind: "run", runId: record.sourceId };
  if (record.parentSessionId) return { kind: "session", sessionId: record.parentSessionId };
  return null;
}
