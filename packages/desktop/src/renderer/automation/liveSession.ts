/**
 * Pure placement logic for a LIVE automation session announced over the stream
 * (`agent/automationSession`). Stream events carry only a sessionId — the cwd
 * needed to group the run under a project lives on the cron job (main side) and
 * is forwarded once via the announcement. This module turns that announcement
 * into a (repoId, SessionSummary) the renderer can upsert into the sidebar,
 * reusing the SAME source:"automation" machinery the startup disk-backfill uses
 * (so clicking the session renders the run like a normal chat).
 *
 * Kept side-effect-free (repo creation is injected) so it unit-tests without
 * Electron / localStorage.
 */
import type { SessionSummary } from "../transcripts";
import { matchRepoIdForCwd, isNoRepoCwd, type RepoLike } from "./pathMatch";

export interface AutomationSessionAnnouncement {
  sessionId: string;
  cwd: string;
  title: string;
  /** The cron job id that owns this run. Stored on the session so deleting a
   *  still-running automation session can cancel the in-flight run before
   *  removing its on-disk dir. */
  cronJobId: string;
}

export interface PlaceLiveSessionDeps {
  caseInsensitive: boolean;
  resolveCwd?: (cwd: string) => string;
  /** Create a repo for an unmatched cwd; returns its id. */
  createRepoForCwd: (cwd: string) => string | null;
}

export interface LiveSessionPlacement {
  repoId: string | null;
  summary: SessionSummary;
}

/**
 * Resolve which project an announced automation session belongs to (matching
 * the cwd against existing repos, auto-creating one when unmatched) and build
 * the SessionSummary for it. `runStatus: "running"` mirrors the disk-backfill
 * convention so the next startup backfill re-imports the finished transcript in
 * place (upsertImportedSession keys on engineSessionId).
 */
export function placeLiveAutomationSession(
  ann: AutomationSessionAnnouncement,
  repos: RepoLike[],
  deps: PlaceLiveSessionDeps,
): LiveSessionPlacement | null {
  const cwd = deps.resolveCwd?.(ann.cwd) ?? ann.cwd;
  // The internal no-repo sandbox is a no-project chat → NO_REPO_KEY bucket
  // (repoId null), never a real repo.
  const repoId = isNoRepoCwd(cwd)
    ? null
    : (matchRepoIdForCwd(cwd, repos, deps.caseInsensitive) ?? deps.createRepoForCwd(cwd));
  if (repoId === null && !isNoRepoCwd(cwd)) return null;
  const now = Date.now();
  const summary: SessionSummary = {
    id: ann.sessionId, // engine sessionId doubles as the UI session id for imports
    title: (ann.title || "automation").slice(0, 60),
    createdAt: now,
    updatedAt: now,
    engineSessionId: ann.sessionId,
    source: "automation",
    runStatus: "running",
    cronJobId: ann.cronJobId,
  };
  return { repoId, summary };
}
