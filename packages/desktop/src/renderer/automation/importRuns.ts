/**
 * Attribute automation runs to sidebar projects and import their metadata.
 * Transcripts are loaded on demand after selection, through the same paged
 * hydration path as manually created sessions.
 */
import type { SessionSummary } from "../transcripts";
import { matchProjectIdForCwd, normalizeCwd, isNoRepoCwd, type ProjectLike } from "./pathMatch";

/** A run as needed for import (subset of the main-process RunSummary). */
export interface ImportableRun {
  runId: string;
  sessionId: string | null;
  cwd: string;
  objective: string;
  status: string;
  finishedAt: number | null;
  createdAt: number;
  /** Run metadata source tag; only "automation" runs are imported. */
  source?: string;
  cronJobName?: string;
}

export interface ImportDeps {
  caseInsensitive: boolean;
  /** engineSessionIds already present across all repo indices (dedup key). */
  existingEngineSessionIds: Set<string>;
  writeImported: (projectId: string | null, summary: SessionSummary) => void;
  /** Create a repo for an unmatched cwd; returns its id. */
  createProjectForCwd: (cwd: string) => string | null;
  resolveCwd?: (cwd: string) => string;
  resolvedForCwd?: ReadonlyMap<
    string,
    { projectId: string; rootId: string; created: boolean } | { noRepo: true } | null
  >;
  /** Max runs imported per repo (most-recent first). */
  cap: number;
}

export async function importAutomationRuns(
  runs: ImportableRun[],
  projects: ProjectLike[],
  deps: ImportDeps,
): Promise<void> {
  // 1. Filter: automation-sourced, has a sessionId, not already known.
  //    No terminal-status filter — a running run already has a sessionId once
  //    the engine emits session_started, and we want it in the sidebar live.
  //    (queued runs without a sessionId are excluded by the !!r.sessionId guard.)
  const candidates = runs.filter(
    (r) =>
      r.source === "automation" && !!r.sessionId && !deps.existingEngineSessionIds.has(r.sessionId),
  );

  // 2. Group by attributed projectId (auto-creating projects as needed).
  const byProject = new Map<string | null, ImportableRun[]>();
  // Memo so multiple runs sharing an unmatched cwd reuse ONE auto-created repo
  // instead of spawning a new repo per run.
  const autoCreated = new Map<string, string>();
  for (const r of candidates) {
    const cwd = deps.resolveCwd?.(r.cwd) ?? r.cwd;
    // The internal no-repo sandbox is a no-project chat → NO_REPO_KEY bucket
    // (projectId null), never a real repo.
    const mainResolution = deps.resolvedForCwd?.get(cwd);
    let projectId = deps.resolvedForCwd?.has(cwd)
      ? mainResolution && "projectId" in mainResolution
        ? mainResolution.projectId
        : null
      : isNoRepoCwd(cwd)
        ? null
        : matchProjectIdForCwd(cwd, projects, deps.caseInsensitive);
    if (!projectId && !isNoRepoCwd(cwd) && !deps.resolvedForCwd?.has(cwd)) {
      const key = normalizeCwd(cwd, deps.caseInsensitive);
      projectId = autoCreated.get(key) ?? null;
      if (!projectId) {
        projectId = deps.createProjectForCwd(cwd);
        if (!projectId) continue;
        autoCreated.set(key, projectId);
      }
    }
    if (projectId === null && mainResolution === null) continue;
    const list = byProject.get(projectId) ?? [];
    list.push(r);
    byProject.set(projectId, list);
  }

  // 3. Per repo: most-recent first, cap, write the directory entry only. A run
  // can still be streaming; importing it must never replace its live snapshot.
  for (const [projectId, list] of byProject) {
    list.sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
    for (const r of list.slice(0, deps.cap)) {
      const summary: SessionSummary = {
        id: r.sessionId as string, // engine sessionId doubles as the UI session id for imports
        title: (r.cronJobName || r.objective || "automation").slice(0, 60),
        createdAt: r.createdAt,
        updatedAt: r.finishedAt ?? r.createdAt,
        engineSessionId: r.sessionId as string,
        source: "automation",
        runId: r.runId,
        runStatus: r.status,
      };
      deps.writeImported(projectId, summary);
    }
  }
}
