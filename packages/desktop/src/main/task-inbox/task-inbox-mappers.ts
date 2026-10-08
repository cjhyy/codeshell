import {
  isTaskStatus,
  isTerminalTaskStatus,
  parseTaskInboxRecord,
  taskInboxKey,
  type TaskAction,
  type TaskInboxRecordV1,
  type TaskSource,
  type TaskStatus,
} from "./task-inbox-types.js";

export type TaskInboxSourceRecord = Omit<
  TaskInboxRecordV1,
  "schemaVersion" | "taskKey" | "status" | "artifacts" | "capabilities"
> & {
  status: string;
  artifacts?: TaskInboxRecordV1["artifacts"];
  capabilities?: TaskAction[];
};
const STATUS_ALIASES: Record<string, TaskStatus> = {
  pending: "queued",
  scheduled: "queued",
  enabled: "queued",
  active: "running",
  in_progress: "running",
  executing: "running",
  finalizing: "running",
  streaming: "running",
  waiting_approval: "waiting",
  waiting_input: "waiting",
  awaiting_approval: "waiting",
  awaiting_input: "waiting",
  blocked: "waiting",
  needs_input: "waiting",
  needs_approval: "waiting",
  disabled: "paused",
  suspended: "paused",
  completed: "done",
  complete: "done",
  succeeded: "done",
  success: "done",
  finished: "done",
  error: "failed",
  canceled: "cancelled",
  aborted: "cancelled",
  disconnected: "interrupted",
  stopped: "interrupted",
};
export function mapTaskInboxStatus(status: string): TaskStatus {
  if (isTaskStatus(status)) return status;
  const mapped = STATUS_ALIASES[status];
  if (!mapped) throw new Error("Unknown source task status");
  return mapped;
}
export function mapTaskInboxRecord(input: TaskInboxSourceRecord): TaskInboxRecordV1 {
  const status = mapTaskInboxStatus(input.status);
  return parseTaskInboxRecord({
    ...input,
    schemaVersion: 1,
    taskKey: taskInboxKey(input.source, input.sourceId, input.attempt),
    status,
    artifacts: input.artifacts ?? [],
    // Only the authoritative adapter knows whether a live controller is reachable.
    // History never gains a write capability through a generic status alias.
    capabilities: input.source === "legacy-run" ? ["open"] : (input.capabilities ?? ["open"]),
    ...(isTerminalTaskStatus(status) ? { terminalAt: input.terminalAt ?? input.updatedAt } : {}),
  });
}
type SourceInput = Omit<TaskInboxSourceRecord, "source">;
const mapper =
  (source: TaskSource) =>
  (input: SourceInput): TaskInboxRecordV1 =>
    mapTaskInboxRecord({ ...input, source });
export const mapSessionTask = mapper("session");
export const mapLegacyRunTask = mapper("legacy-run");
export const mapAutomationTask = mapper("automation");
export const mapMimiDelegationTask = mapper("mimi-delegation");
export const mapSubagentTask = mapper("subagent");
export const mapBackgroundShellTask = mapper("background-shell");
export const mapBackgroundJobTask = mapper("background-job");
export const mapExternalRuntimeTask = mapper("external-runtime");

/** Preserve storage rows, but present one primary card per delegated execution. */
export function deduplicateTaskInboxRecords(records: TaskInboxRecordV1[]): TaskInboxRecordV1[] {
  const latest = new Map<string, TaskInboxRecordV1>();
  for (const record of records) {
    const previous = latest.get(record.taskKey);
    if (!previous || shouldReplaceTaskRecord(previous, record)) latest.set(record.taskKey, record);
  }
  const representedSessions = new Set<string>();
  const liveSessions = new Set<string>();
  const currentAttempts = new Map<string, number>();
  for (const record of latest.values()) {
    if (record.attempt !== undefined) {
      const key = JSON.stringify([record.source, record.sourceId]);
      currentAttempts.set(key, Math.max(currentAttempts.get(key) ?? 0, record.attempt));
    }
  }
  for (const record of latest.values()) {
    if (record.source !== "legacy-run" && record.source !== "automation" && record.sessionId)
      liveSessions.add(record.sessionId);
    if (
      ["mimi-delegation", "automation", "subagent", "external-runtime"].includes(record.source) &&
      record.sessionId &&
      record.sessionId !== record.parentSessionId
    )
      representedSessions.add(record.sessionId);
  }
  return [...latest.values()].filter((record) => {
    if (
      record.attempt !== undefined &&
      record.attempt <
        (currentAttempts.get(JSON.stringify([record.source, record.sourceId])) ?? record.attempt)
    )
      return false;
    if (record.source === "session" && representedSessions.has(record.sessionId ?? record.sourceId))
      return false;
    // Legacy Run and automation execution share a session with their stronger live card.
    if (record.source === "legacy-run" && record.sessionId && liveSessions.has(record.sessionId))
      return false;
    return true;
  });
}

export function shouldReplaceTaskRecord(
  previous: TaskInboxRecordV1,
  next: TaskInboxRecordV1,
): boolean {
  if (next.updatedAt !== previous.updatedAt) return next.updatedAt > previous.updatedAt;
  if (isTerminalTaskStatus(previous.status) && !isTerminalTaskStatus(next.status)) return false;
  const oldNumeric = /^\d+$/.test(previous.sourceRevision)
    ? Number(previous.sourceRevision)
    : undefined;
  const newNumeric = /^\d+$/.test(next.sourceRevision) ? Number(next.sourceRevision) : undefined;
  if (oldNumeric !== undefined && newNumeric !== undefined && oldNumeric !== newNumeric)
    return newNumeric > oldNumeric;
  // Equal revisions may refresh controller reachability or clear a stale marker.
  return JSON.stringify(previous) !== JSON.stringify(next);
}
export function taskInboxStatusGroup(
  status: TaskStatus,
): "waiting" | "running" | "failed" | "done" {
  if (["waiting", "paused", "interrupted"].includes(status)) return "waiting";
  if (["queued", "running"].includes(status)) return "running";
  return status === "failed" ? "failed" : "done";
}
export function compareTaskInboxRecords(a: TaskInboxRecordV1, b: TaskInboxRecordV1): number {
  const priority = { waiting: 0, running: 1, failed: 2, done: 3 };
  return (
    priority[taskInboxStatusGroup(a.status)] - priority[taskInboxStatusGroup(b.status)] ||
    b.updatedAt - a.updatedAt ||
    a.taskKey.localeCompare(b.taskKey)
  );
}
