import type { TaskInboxSnapshot } from "./task-inbox-types.js";
import { compareTaskInboxRecords, deduplicateTaskInboxRecords } from "./task-inbox-mappers.js";

/** Bounded disclosure only: registry payloads, commands, artifact URIs and errors stay in Main. */
export function taskInboxPetView(snapshot: TaskInboxSnapshot, limit = 100) {
  const visible = deduplicateTaskInboxRecords(snapshot.records).sort(compareTaskInboxRecords);
  const records = visible.slice(0, Math.max(1, Math.min(100, limit)));
  return {
    version: snapshot.version,
    total: visible.length,
    truncated: records.length < visible.length,
    staleSources: snapshot.errors.map(({ source }) => source),
    tasks: records.map((record) => ({
      taskKey: record.taskKey,
      source: record.source,
      title: record.title.slice(0, 240),
      status: record.status,
      updatedAt: record.updatedAt,
      ...(record.source === "mimi-delegation" ? { taskId: record.sourceId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.automationId ? { automationId: record.automationId } : {}),
      ...(record.projectId ? { projectId: record.projectId } : {}),
      ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
      ...(record.summary ? { summary: record.summary.slice(0, 800) } : {}),
      ...(record.stale ? { stale: true } : {}),
    })),
  };
}

export type TaskInboxPetView = ReturnType<typeof taskInboxPetView>;
