import type { TurnCompletionKind } from "@cjhyy/code-shell-core";
import { access } from "node:fs/promises";
import * as path from "node:path";

export interface DiskSessionMeta {
  runId?: string;
  clientMessageId?: string;
  id: string;
  engineSessionId: string; // == directory name; reused as the UI session id
  cwd: string;
  title: string;
  model?: string;
  provider?: string;
  /** Explicit configured text connection persisted by the Session's last native run. */
  modelConnectionId?: string;
  updatedAt: number;
  /** Durable creation time, when supplied by the engine's state schema. */
  createdAt?: number;
  /** Sub-agents require an explicit parent query or the host's includeSubagents scan. */
  origin: "desktop" | "automation" | "subagent";
  /** Present for direct-child queries and the host's complete task scan. */
  parentSessionId?: string;
  /** Normalized durable status for Pet/display consumers. */
  status?: "active" | "paused" | "completed" | "failed" | "cancelled";
  /** Exceptional completed-run boundary; absent means a normal final answer. */
  completionKind?: TurnCompletionKind;
  /** Durable archival timestamp; absent = not archived. */
  archivedAt?: number;
  /** Workspace profile/digital human bound to this Session. */
  workspaceProfile?: string;
}

export interface ListDiskSessionsResult {
  sessions: DiskSessionMeta[];
  nextCursor: string | null; // opaque stable position in the mtime-sorted catalog; null = no more
}

export interface DiskSessionListOptions {
  limit: number;
  cursor?: string;
  cwds?: readonly string[];
  sessionId?: string;
  includeArchived?: boolean;
  includeSubagents?: boolean;
  parentSessionId?: string;
}

export interface DiskSessionPosition {
  id: string;
  mtime: number;
}

export function comparePositions(a: DiskSessionPosition, b: DiskSessionPosition): number {
  return b.mtime - a.mtime || a.id.localeCompare(b.id);
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(value) &&
    value !== "." &&
    !value.includes("..")
  );
}

export function isListDirectory(id: string): boolean {
  return safeId(id) && !id.startsWith("qchat-") && !id.startsWith("panel-task-");
}

export function checkListIds(options: DiskSessionListOptions): void {
  if (options.sessionId !== undefined && !safeId(options.sessionId))
    throw new Error("invalid session id");
  if (options.parentSessionId !== undefined && !safeId(options.parentSessionId))
    throw new Error("invalid parent session id");
}

export function decodeCursor(value?: string): DiskSessionPosition | number | null {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^v1:([^:]+):([A-Za-z0-9._-]+)$/.exec(value);
  if (!match) return null;
  const mtime = Number(match[1]);
  return Number.isFinite(mtime) ? { mtime, id: match[2]! } : null;
}

/** The only fields retained from state.json are those the session list actually returns. */
export function projectDiskSessionState(
  id: string,
  mtime: number,
  input: unknown,
): DiskSessionMeta | null {
  if (
    !isListDirectory(id) ||
    !Number.isFinite(mtime) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return null;
  const state = input as Record<string, unknown>;
  const origin = state.origin;
  if (
    state.ephemeral === true ||
    state.kind === "pet" ||
    !Object.hasOwn(state, "parentSessionId") ||
    (origin !== "desktop" && origin !== "automation" && origin !== "subagent")
  )
    return null;
  const childParentId = state.parentSessionId;
  if (childParentId && !safeId(childParentId)) return null;
  const archivedAt = typeof state.archivedAt === "number" ? state.archivedAt : undefined;
  return {
    id,
    ...(typeof state.runId === "string" && state.runId.length > 0 && state.runId.length <= 256
      ? { runId: state.runId }
      : {}),
    ...(typeof state.clientMessageId === "string" &&
    state.clientMessageId.length > 0 &&
    state.clientMessageId.length <= 256
      ? { clientMessageId: state.clientMessageId }
      : {}),
    engineSessionId: id,
    ...(typeof state.model === "string" ? { model: state.model } : {}),
    ...(typeof state.provider === "string" ? { provider: state.provider } : {}),
    ...(typeof state.modelConnectionId === "string" &&
    state.modelConnectionId.length > 0 &&
    state.modelConnectionId.length <= 256
      ? { modelConnectionId: state.modelConnectionId }
      : {}),
    cwd: typeof state.cwd === "string" ? state.cwd : "",
    // Prefer the LLM-generated title (now persisted to state); fall back to
    // the raw first-message summary, then the id. This lets the disk rebuild
    // surface the real title after a localStorage wipe.
    title:
      (typeof state.title === "string" && state.title ? state.title : undefined) ??
      (typeof state.summary === "string" && state.summary ? state.summary : id),
    updatedAt: mtime,
    ...(typeof state.startedAt === "number" &&
    Number.isFinite(state.startedAt) &&
    state.startedAt >= 0
      ? { createdAt: state.startedAt }
      : {}),
    origin,
    ...(typeof childParentId === "string" && childParentId
      ? { parentSessionId: childParentId }
      : {}),
    status:
      state.status === "active" || state.status === "paused" || state.status === "completed"
        ? state.status
        : state.status === "aborted_streaming" || state.status === "aborted_tools"
          ? "cancelled"
          : typeof state.status === "string"
            ? "failed"
            : undefined,
    ...(state.status === "completed" &&
    (state.lastCompletionKind === "background_wait" ||
      state.lastCompletionKind === "goal_control_stop" ||
      state.lastCompletionKind === "limit_stop")
      ? { completionKind: state.lastCompletionKind }
      : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    ...(typeof state.workspaceProfile === "string" && state.workspaceProfile
      ? { workspaceProfile: state.workspaceProfile }
      : {}),
  };
}

function pathKey(cwd: string): string {
  const normalized = path.resolve(cwd);
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

/** Both sources consume the raw directory sequence, including positions with no visible state. */
export async function collectDiskSessionPage<T extends DiskSessionPosition>(
  opts: DiskSessionListOptions,
  positions: Iterable<T> | AsyncIterable<T>,
  read: (position: T) => DiskSessionMeta | null | Promise<DiskSessionMeta | null>,
  previous?: DiskSessionPosition,
): Promise<ListDiskSessionsResult> {
  const sessions: DiskSessionMeta[] = [];
  const roots = opts.cwds?.map(pathKey);
  const cwdExists = new Map<string, boolean>();
  for await (const position of positions) {
    if (!(sessions.length < opts.limit)) {
      return { sessions, nextCursor: previous ? `v1:${previous.mtime}:${previous.id}` : null };
    }
    previous = position;
    const row = await read(position);
    if (!row || (row.archivedAt !== undefined && !opts.includeArchived)) continue;
    if (opts.parentSessionId !== undefined) {
      if (row.parentSessionId !== opts.parentSessionId) continue;
    } else if (!opts.includeSubagents && (row.parentSessionId || row.origin === "subagent"))
      continue;
    if (roots) {
      if (!row.cwd) continue;
      const candidate = pathKey(row.cwd);
      if (
        !roots.some(
          (root) =>
            candidate === root ||
            candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep),
        )
      )
        continue;
    }
    // Children can outlive temporary worktrees; top-level rows must never resurrect a deleted project.
    if (row.cwd && !row.parentSessionId && opts.parentSessionId === undefined) {
      let exists = cwdExists.get(row.cwd);
      if (exists === undefined) {
        exists = await access(row.cwd).then(
          () => true,
          () => false,
        );
        cwdExists.set(row.cwd, exists);
      }
      if (!exists) continue;
    }
    sessions.push(row);
  }
  return { sessions, nextCursor: null };
}
