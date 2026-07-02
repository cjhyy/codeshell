/**
 * Registry of NON-agent background jobs (GenerateVideo poll loops, DriveAgent
 * external CLI runs). Mirrors the role `asyncAgentRegistry` plays for background
 * sub-agents, but a job is not an agent — it has no transcript, no abort(), and
 * must NOT show up in AgentStatus.
 *
 * The engine's wait-for-background loop parks the turn until a session has no
 * more RUNNING jobs, so the goal-stop-hook doesn't force the model to busy-loop
 * with `sleep` while a video renders (the s-mqe0ox7n-a8d11c26 bug).
 *
 * Finished jobs are RETAINED (status flips to completed/failed, result stored)
 * so the background panel can show them + let the user open the result — they
 * don't vanish the instant they complete (#2/#5). Retention is bounded:
 *   - event-driven: a session's jobs are dropped when the session is deleted
 *     (dropForSession, wired to session close/delete);
 *   - a generous per-session cap on TERMINAL jobs is a pure memory backstop for
 *     a session that spawns hundreds of jobs and is never deleted.
 *
 * Process-local singleton, same pattern as asyncAgentRegistry. The video/Drive
 * loops run in the main engine process, so start/finish and the engine's wait
 * loop observe the same instance.
 */

function isValidSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && sid.length > 0;
}

type Listener = () => void;

export type BackgroundJobStatus = "running" | "completed" | "failed";

/** Generous per-session cap on retained terminal jobs — a leak backstop, not a
 *  UX limit; a human never spawns this many background jobs in one session. */
const MAX_TERMINAL_JOBS_PER_SESSION = 50;

/** A background job, running or finished. */
export interface BackgroundJobEntry {
  jobId: string;
  sessionId: string;
  /** Human description (e.g. "Generating video: <prompt>"). Shown to the goal
   *  judge (running) and in the background panel (all). */
  description: string;
  status: BackgroundJobStatus;
  startedAt: number;
  /** Set when status flips to a terminal state. */
  finishedAt?: number;
  /** Result summary (video URL, DriveAgent final text) or error message. */
  finalText?: string;
  /** External CLI session id, when the job is a DriveAgent run — lets the host
   *  read that CLI's transcript to attribute file changes (#6). */
  ccSessionId?: string;
  /** Files the external agent changed (parsed from its transcript, #6). */
  changedFiles?: string[];
}

/** Outcome passed to finish() to record how a job ended. */
export interface BackgroundJobOutcome {
  status?: "completed" | "failed";
  finalText?: string;
  ccSessionId?: string;
  changedFiles?: string[];
}

class BackgroundJobRegistry {
  private jobs = new Map<string, BackgroundJobEntry>(); // jobId -> entry (insertion-ordered)
  private listeners = new Set<Listener>();

  /** Register a running job. Invalid sessionId is ignored (cannot be waited on). */
  start(jobId: string, sessionId: string, description = ""): void {
    if (!isValidSessionId(sessionId)) return;
    this.jobs.set(jobId, {
      jobId,
      sessionId,
      description,
      status: "running",
      startedAt: Date.now(),
    });
    this.notify();
  }

  /** Mark a job terminal (retained, not deleted). Unknown id is a no-op (no
   *  notify) so a double-finish or a finish after reset stays quiet. */
  finish(jobId: string, outcome?: BackgroundJobOutcome): void {
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    entry.status = outcome?.status ?? "completed";
    entry.finishedAt = Date.now();
    if (outcome?.finalText !== undefined) entry.finalText = outcome.finalText;
    if (outcome?.ccSessionId !== undefined) entry.ccSessionId = outcome.ccSessionId;
    if (outcome?.changedFiles !== undefined) entry.changedFiles = outcome.changedFiles;
    this.evictTerminalOverCap(entry.sessionId);
    this.notify();
  }

  /** True while any RUNNING job spawned by `sessionId` remains. */
  hasRunningForSession(sessionId: string): boolean {
    for (const e of this.jobs.values()) {
      if (e.sessionId === sessionId && e.status === "running") return true;
    }
    return false;
  }

  /** Running jobs spawned by `sessionId`. Feeds the goal judge's task list. */
  listRunningForSession(sessionId: string): BackgroundJobEntry[] {
    return [...this.jobs.values()].filter(
      (e) => e.sessionId === sessionId && e.status === "running",
    );
  }

  /** All jobs (running + retained terminal) for `sessionId`. Feeds the panel. */
  listForSession(sessionId: string): BackgroundJobEntry[] {
    return [...this.jobs.values()].filter((e) => e.sessionId === sessionId);
  }

  /** Drop every job of a session — called when the session is deleted/closed. */
  dropForSession(sessionId: string): void {
    let removed = false;
    for (const [id, e] of this.jobs) {
      if (e.sessionId === sessionId) {
        this.jobs.delete(id);
        removed = true;
      }
    }
    if (removed) this.notify();
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** Test helper: drop all tracked jobs. */
  reset(): void {
    this.jobs.clear();
  }

  /** Backstop: keep at most MAX_TERMINAL_JOBS_PER_SESSION terminal jobs per
   *  session, evicting the oldest (insertion order). Running jobs never evicted. */
  private evictTerminalOverCap(sessionId: string): void {
    const terminal = [...this.jobs.values()].filter(
      (e) => e.sessionId === sessionId && e.status !== "running",
    );
    const over = terminal.length - MAX_TERMINAL_JOBS_PER_SESSION;
    if (over <= 0) return;
    // Map iteration is insertion order → the first `over` terminal entries are
    // the oldest.
    for (let i = 0; i < over; i++) {
      this.jobs.delete(terminal[i].jobId);
    }
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // isolate per-listener errors
      }
    }
  }
}

export const backgroundJobRegistry = new BackgroundJobRegistry();
