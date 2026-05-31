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
import { matchRepoIdForCwd, type RepoLike } from "./pathMatch";

/** A run as needed for import (subset of the main-process RunSummary). */
export interface ImportableRun {
  runId: string;
  sessionId: string | null;
  cwd: string;
  objective: string;
  status: string;
  finishedAt: number | null;
  createdAt: number;
  /** "automation" only — non-automation runs are filtered out. */
  source?: "automation" | string;
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
  createRepoForCwd: (cwd: string) => string;
  /** Max runs imported per repo (most-recent first). */
  cap: number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function importAutomationRuns(
  runs: ImportableRun[],
  repos: RepoLike[],
  deps: ImportDeps,
): Promise<void> {
  // 1. Filter: automation-sourced, terminal, has a sessionId, not already known.
  const candidates = runs.filter(
    (r) =>
      r.source === "automation" &&
      TERMINAL.has(r.status) &&
      !!r.sessionId &&
      !deps.existingEngineSessionIds.has(r.sessionId),
  );

  // 2. Group by attributed repoId (auto-creating repos as needed).
  const byRepo = new Map<string | null, ImportableRun[]>();
  for (const r of candidates) {
    let repoId = matchRepoIdForCwd(r.cwd, repos, deps.caseInsensitive);
    if (!repoId) repoId = deps.createRepoForCwd(r.cwd);
    const list = byRepo.get(repoId) ?? [];
    list.push(r);
    byRepo.set(repoId, list);
  }

  // 3. Per repo: most-recent first, cap, fetch+fold+write.
  for (const [repoId, list] of byRepo) {
    list.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
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
      };
      deps.writeImported(repoId, summary, state);
    }
  }
}
