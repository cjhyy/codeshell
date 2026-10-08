/** Browser-safe wire model. This module must never import a host or filesystem API. */
export const TASK_SOURCES = [
  "session",
  "legacy-run",
  "automation",
  "mimi-delegation",
  "subagent",
  "background-shell",
  "background-job",
  "external-runtime",
] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];
export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting",
  "paused",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_ACTIONS = ["open", "cancel", "pause", "resume", "retry", "verify"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
export type TaskInboxAction = TaskAction;

export interface TaskInboxRecordV1 {
  schemaVersion: 1;
  taskKey: string;
  source: TaskSource;
  sourceId: string;
  attempt?: number;
  title: string;
  status: TaskStatus;
  sessionId?: string;
  parentSessionId?: string;
  automationId?: string;
  projectId?: string;
  workspacePath?: string;
  summary?: string;
  error?: string;
  artifacts: Array<{ kind: string; label: string; uri: string }>;
  capabilities: TaskAction[];
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  sourceRevision: string;
  stale?: boolean;
}
export interface TaskInboxSourceError {
  source: TaskSource;
  message: string;
}
export interface TaskInboxSnapshot {
  version: number;
  records: TaskInboxRecordV1[];
  errors: TaskInboxSourceError[];
}
export interface TaskInboxListQuery {
  status?: TaskStatus;
  source?: TaskSource;
  projectId?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}
export interface TaskInboxListResult extends TaskInboxSnapshot {
  nextCursor?: string;
}
export type TaskInboxQuery = TaskInboxListQuery;
export interface TaskInboxActionRequest {
  taskKey: string;
  action: TaskAction;
  expectedRevision: string;
}
export interface TaskInboxActionContext {
  webContentsId: number;
}
export interface TaskInboxActionResult {
  status: "ok" | "stale" | "unavailable" | "rejected" | "failed";
  message?: string;
  record?: TaskInboxRecordV1;
}

const RECORD_FIELDS = new Set([
  "schemaVersion",
  "taskKey",
  "source",
  "sourceId",
  "attempt",
  "title",
  "status",
  "sessionId",
  "parentSessionId",
  "automationId",
  "projectId",
  "workspacePath",
  "summary",
  "error",
  "artifacts",
  "capabilities",
  "createdAt",
  "updatedAt",
  "terminalAt",
  "sourceRevision",
  "stale",
]);
export function checkedTaskObject(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid task object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid task object");
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown task field: ${key}`);
  return value as Record<string, unknown>;
}
export function checkedTaskText(value: unknown, label: string, max = 512, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.length) ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  ) {
    throw new Error(`Invalid task ${label}`);
  }
  return value;
}
function checkedId(value: unknown, label: string): string {
  const result = checkedTaskText(value, label);
  if (
    /[\r\n\t]/.test(result) ||
    ["__proto__", "constructor", "prototype", ".", ".."].includes(result)
  )
    throw new Error(`Invalid task ${label}`);
  return result;
}
function checkedTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`Invalid task ${label}`);
  return value;
}
export function isTaskSource(value: unknown): value is TaskSource {
  return TASK_SOURCES.includes(value as TaskSource);
}
export function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}
export function isTaskAction(value: unknown): value is TaskAction {
  return TASK_ACTIONS.includes(value as TaskAction);
}
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}
export function taskInboxKey(source: TaskSource, sourceId: string, attempt?: number): string {
  return `${source}:${sourceId}${attempt === undefined ? "" : `:${attempt}`}`;
}
export function parseTaskInboxRecord(value: unknown): TaskInboxRecordV1 {
  const raw = checkedTaskObject(value, RECORD_FIELDS);
  if (raw.schemaVersion !== 1 || !isTaskSource(raw.source) || !isTaskStatus(raw.status))
    throw new Error("Invalid task schema, source or status");
  const sourceId = checkedId(raw.sourceId, "source ID");
  if (raw.attempt !== undefined && (!Number.isSafeInteger(raw.attempt) || Number(raw.attempt) < 0))
    throw new Error("Invalid task attempt");
  const attempt = raw.attempt as number | undefined;
  if (raw.taskKey !== taskInboxKey(raw.source, sourceId, attempt))
    throw new Error("Invalid task key");
  if (
    !Array.isArray(raw.capabilities) ||
    raw.capabilities.length > TASK_ACTIONS.length ||
    !raw.capabilities.every(isTaskAction) ||
    new Set(raw.capabilities).size !== raw.capabilities.length
  )
    throw new Error("Invalid task capabilities");
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length > 100)
    throw new Error("Invalid task artifacts");
  const artifacts = raw.artifacts.map((value) => {
    const artifact = checkedTaskObject(value, new Set(["kind", "label", "uri"]));
    return {
      kind: checkedTaskText(artifact.kind, "artifact kind", 128),
      label: checkedTaskText(artifact.label, "artifact label", 1024),
      uri: checkedTaskText(artifact.uri, "artifact URI", 4096),
    };
  });
  const result: TaskInboxRecordV1 = {
    schemaVersion: 1,
    taskKey: raw.taskKey as string,
    source: raw.source,
    sourceId,
    title: checkedTaskText(raw.title, "title", 4096),
    status: raw.status,
    artifacts,
    capabilities: [...raw.capabilities],
    createdAt: checkedTime(raw.createdAt, "createdAt"),
    updatedAt: checkedTime(raw.updatedAt, "updatedAt"),
    sourceRevision: checkedTaskText(raw.sourceRevision, "revision", 1024),
  };
  if (attempt !== undefined) result.attempt = attempt;
  for (const key of ["sessionId", "parentSessionId", "automationId", "projectId"] as const) {
    if (raw[key] !== undefined) result[key] = checkedId(raw[key], key);
  }
  for (const key of ["workspacePath", "summary", "error"] as const) {
    if (raw[key] !== undefined)
      result[key] = checkedTaskText(raw[key], key, key === "workspacePath" ? 4096 : 16_384, true);
  }
  if (raw.terminalAt !== undefined) result.terminalAt = checkedTime(raw.terminalAt, "terminalAt");
  if (raw.stale !== undefined) {
    if (typeof raw.stale !== "boolean") throw new Error("Invalid task stale flag");
    if (raw.stale) result.stale = true;
  }
  return result;
}
export function parseTaskInboxListQuery(value: unknown = {}): TaskInboxListQuery {
  const raw = checkedTaskObject(
    value,
    new Set(["status", "source", "projectId", "search", "cursor", "limit"]),
  );
  const result: TaskInboxListQuery = {};
  if (raw.status !== undefined) {
    if (!isTaskStatus(raw.status)) throw new Error("Invalid task status");
    result.status = raw.status;
  }
  if (raw.source !== undefined) {
    if (!isTaskSource(raw.source)) throw new Error("Invalid task source");
    result.source = raw.source;
  }
  if (raw.projectId !== undefined) result.projectId = checkedId(raw.projectId, "project ID");
  if (raw.search !== undefined) result.search = checkedTaskText(raw.search, "search", 512, true);
  if (raw.cursor !== undefined) result.cursor = checkedTaskText(raw.cursor, "cursor", 128);
  if (raw.limit !== undefined) {
    if (!Number.isSafeInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 200)
      throw new Error("Invalid task page limit");
    result.limit = raw.limit as number;
  }
  return result;
}
export function parseTaskInboxActionRequest(value: unknown): TaskInboxActionRequest {
  const raw = checkedTaskObject(value, new Set(["taskKey", "action", "expectedRevision"]));
  if (!isTaskAction(raw.action)) throw new Error("Invalid task action");
  return {
    taskKey: checkedTaskText(raw.taskKey, "key", 1100),
    action: raw.action,
    expectedRevision: checkedTaskText(raw.expectedRevision, "revision", 1024),
  };
}
