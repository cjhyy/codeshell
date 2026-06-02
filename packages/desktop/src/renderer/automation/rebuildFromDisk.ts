/**
 * Plan how a page of disk sessions maps into repos + SessionSummary entries,
 * rebuilding the sidebar when localStorage is empty. Pure: callers apply the
 * returned (repoId, summary) pairs via upsertImportedSession and persist repos.
 * Reuses the same cwd→repo matching as live automation placement (D1).
 */
import { matchRepoIdForCwd, type RepoLike } from "./pathMatch";
import type { SessionSummary } from "../transcripts";

export interface DiskSessionMeta {
  id: string;
  engineSessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export interface RebuildDeps {
  caseInsensitive: boolean;
  createRepoForCwd: (cwd: string) => string;
}

export interface RebuildPlacement {
  repoId: string;
  summary: SessionSummary;
}

export function planDiskRebuild(
  sessions: DiskSessionMeta[],
  repos: RepoLike[],
  deps: RebuildDeps,
): RebuildPlacement[] {
  return sessions.map((s) => {
    const repoId = matchRepoIdForCwd(s.cwd, repos, deps.caseInsensitive) ?? deps.createRepoForCwd(s.cwd);
    const summary: SessionSummary = {
      id: s.id,
      title: (s.title || s.id).slice(0, 60),
      createdAt: s.updatedAt,
      updatedAt: s.updatedAt,
      engineSessionId: s.engineSessionId,
      // source absent → a normal (non-automation) session.
    };
    return { repoId, summary };
  });
}
