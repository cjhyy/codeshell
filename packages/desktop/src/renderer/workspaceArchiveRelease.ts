import type { SessionSummary } from "./transcripts";

export interface WorkspaceReleaseApi {
  releaseSessionWorkspace(sessionId: string): Promise<unknown>;
  releaseManySessionWorkspaces(sessionIds: string[]): Promise<unknown>;
}

type WorkspaceReleaseResult =
  | { sessionId?: string; ok: true; status: "released"; workspace?: unknown }
  | { sessionId?: string; ok: true; status: "missing"; reason?: string }
  | { sessionId?: string; ok: false; status: "error"; error?: string };

export function engineSessionIdsForWorkspaceRelease(sessions: SessionSummary[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const id = session.engineSessionId ?? session.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export async function releaseWorkspaceForArchive(
  session: SessionSummary | undefined,
  archived: boolean,
  api: WorkspaceReleaseApi,
): Promise<void> {
  if (!archived || !session) return;
  const id = session.engineSessionId ?? session.id;
  if (!id) return;
  try {
    logWorkspaceReleaseResults(await api.releaseSessionWorkspace(id));
  } catch (err) {
    console.error("workspace release failed before archive", err);
  }
}

export async function releaseWorkspacesForArchiveMany(
  sessions: SessionSummary[],
  api: WorkspaceReleaseApi,
): Promise<void> {
  const ids = engineSessionIdsForWorkspaceRelease(sessions.filter((session) => !session.archived));
  if (ids.length === 0) return;
  try {
    logWorkspaceReleaseResults(await api.releaseManySessionWorkspaces(ids));
  } catch (err) {
    console.error("workspace releaseMany failed before archive", err);
  }
}

function logWorkspaceReleaseResults(raw: unknown): void {
  const results = Array.isArray(raw) ? raw : [raw];
  for (const result of results) {
    if (!isWorkspaceReleaseResult(result)) continue;
    if (result.status === "missing") {
      console.warn("workspace release skipped missing session before archive", {
        sessionId: result.sessionId,
        reason: result.reason,
      });
    } else if (result.status === "error") {
      console.error("workspace release failed before archive", {
        sessionId: result.sessionId,
        error: result.error,
      });
    }
  }
}

function isWorkspaceReleaseResult(value: unknown): value is WorkspaceReleaseResult {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return status === "released" || status === "missing" || status === "error";
}
