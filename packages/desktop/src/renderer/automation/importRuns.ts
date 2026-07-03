/**
 * Attribute completed automation runs to sidebar projects and import them
 * into localStorage as normal sessions. Pure orchestration with injected
 * side effects (fetchTranscript / writeImported / createRepoForCwd) so it
 * unit-tests without Electron or localStorage.
 */
import type { FoldItem } from "../../preload/types";
import type { MessagesReducerState } from "../types";
import type { SessionSummary } from "../transcripts";
import { foldTranscript } from "./foldTranscript";
import { matchRepoIdForCwd, normalizeCwd, isNoRepoCwd, type RepoLike } from "./pathMatch";

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
  fetchTranscript: (sessionId: string) => Promise<FoldItem[]>;
  writeImported: (
    repoId: string | null,
    summary: SessionSummary,
    state: MessagesReducerState,
  ) => void;
  /** Create a repo for an unmatched cwd; returns its id. */
  createRepoForCwd: (cwd: string) => string | null;
  resolveCwd?: (cwd: string) => string;
  /** Max runs imported per repo (most-recent first). */
  cap: number;
}

export async function importAutomationRuns(
  runs: ImportableRun[],
  repos: RepoLike[],
  deps: ImportDeps,
): Promise<void> {
  // 1. Filter: automation-sourced, has a sessionId, not already known.
  //    No terminal-status filter — a running run already has a sessionId once
  //    the engine emits session_started, and we want it in the sidebar live.
  //    (queued runs without a sessionId are excluded by the !!r.sessionId guard.)
  const candidates = runs.filter(
    (r) =>
      r.source === "automation" &&
      !!r.sessionId &&
      !deps.existingEngineSessionIds.has(r.sessionId),
  );

  // 2. Group by attributed repoId (auto-creating repos as needed).
  const byRepo = new Map<string | null, ImportableRun[]>();
  // Memo so multiple runs sharing an unmatched cwd reuse ONE auto-created repo
  // instead of spawning a new repo per run.
  const autoCreated = new Map<string, string>();
  for (const r of candidates) {
    const cwd = deps.resolveCwd?.(r.cwd) ?? r.cwd;
    // The internal no-repo sandbox is a no-project chat → NO_REPO_KEY bucket
    // (repoId null), never a real repo.
    let repoId = isNoRepoCwd(cwd) ? null : matchRepoIdForCwd(cwd, repos, deps.caseInsensitive);
    if (!repoId && !isNoRepoCwd(cwd)) {
      const key = normalizeCwd(cwd, deps.caseInsensitive);
      repoId = autoCreated.get(key) ?? null;
      if (!repoId) {
        repoId = deps.createRepoForCwd(cwd);
        if (!repoId) continue;
        autoCreated.set(key, repoId);
      }
    }
    const list = byRepo.get(repoId) ?? [];
    list.push(r);
    byRepo.set(repoId, list);
  }

  // 3. Per repo: most-recent first, cap, fetch+fold+write.
  for (const [repoId, list] of byRepo) {
    list.sort(
      (a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt),
    );
    for (const r of list.slice(0, deps.cap)) {
      let state: MessagesReducerState;
      try {
        state = foldTranscript(await deps.fetchTranscript(r.sessionId as string));
      } catch {
        state = foldTranscript([]); // transcript unavailable — import an empty shell
      }
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
      deps.writeImported(repoId, summary, state);
    }
  }
}
