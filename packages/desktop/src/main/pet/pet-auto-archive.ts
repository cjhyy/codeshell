/**
 * Pure auto-archival policy for Mimi work sessions.
 *
 * Time is injected (`opts.now`) rather than read from the clock so the policy is
 * fully deterministic and unit-testable. The caller (pet init in main/index.ts)
 * passes `Date.now()`.
 */

export interface ArchiveCandidate {
  engineSessionId: string;
  status?: "active" | "paused" | "completed" | "failed" | "cancelled";
  /** Last-activity timestamp (ms) — the disk catalog's mtime for the session. */
  updatedAt: number;
  /** Present iff already archived; such sessions are never re-selected. */
  archivedAt?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A session is auto-archived when its durable status is "completed", it is not
 * already archived, and it has been idle for at least `idleDays` (inclusive
 * boundary). Failed / cancelled / active / paused / status-less sessions are
 * never auto-archived — only settled, successful work fades out of the catalog.
 */
export function selectSessionsToArchive(
  sessions: readonly ArchiveCandidate[],
  opts: { now: number; idleDays: number },
): string[] {
  const cutoff = opts.now - opts.idleDays * DAY_MS;
  return sessions
    .filter(
      (s) =>
        s.status === "completed" &&
        s.archivedAt === undefined &&
        s.updatedAt <= cutoff,
    )
    .map((s) => s.engineSessionId);
}
