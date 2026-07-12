/**
 * Plan how a page of disk sessions maps into projects + SessionSummary entries,
 * rebuilding the sidebar when localStorage is empty. Pure: callers apply the
 * returned (projectId, summary) pairs via upsertImportedSession and persist projects.
 * Reuses the same cwd→repo matching as live automation placement (D1).
 */
import { matchProjectIdForCwd, isNoRepoCwd, type ProjectLike } from "./pathMatch";
import type { SessionSummary } from "../transcripts";

export interface DiskSessionMeta {
  id: string;
  engineSessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  /** Session origin from disk; "automation" sessions get the ⚙ source mark. */
  origin?: "desktop" | "automation";
}

export interface RebuildDeps {
  caseInsensitive: boolean;
  resolveCwd?: (cwd: string) => string;
  createProjectForCwd: (cwd: string) => string | null;
}

export interface RebuildPlacement {
  /** Target repo id, or `null` for the no-project (chat / NO_REPO_KEY) bucket. */
  projectId: string | null;
  summary: SessionSummary;
}

export function planDiskRebuild(
  sessions: DiskSessionMeta[],
  projects: ProjectLike[],
  deps: RebuildDeps,
): RebuildPlacement[] {
  return sessions.flatMap((s) => {
    const cwd = deps.resolveCwd?.(s.cwd) ?? s.cwd;
    // The internal no-repo sandbox is a no-project chat, never a real repo.
    const projectId = isNoRepoCwd(cwd)
      ? null
      : (matchProjectIdForCwd(cwd, projects, deps.caseInsensitive) ??
        deps.createProjectForCwd(cwd));
    if (projectId === null && !isNoRepoCwd(cwd)) return [];
    const summary: SessionSummary = {
      id: s.id,
      title: (s.title || s.id).slice(0, 60),
      createdAt: s.updatedAt,
      updatedAt: s.updatedAt,
      engineSessionId: s.engineSessionId,
      // automation sessions carry the ⚙ source mark; desktop leaves it absent.
      ...(s.origin === "automation" ? { source: "automation" as const } : {}),
    };
    return [{ projectId, summary }];
  });
}
