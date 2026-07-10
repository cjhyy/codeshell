/**
 * Registry of NON-agent background jobs (GenerateVideo poll loops, DriveAgent
 * external CLI runs). Mirrors the role `asyncAgentRegistry` plays for background
 * sub-agents, but a job is not an agent — it has no transcript and must NOT
 * show up in AgentStatus.
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

import { normalizeCwdPath } from "../../cc-orchestrator/cwd-normalize.js";

function isValidSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && sid.length > 0;
}

type Listener = () => void;

export type BackgroundJobStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type BackgroundJobKind = "drive-agent" | "video" | "job";
export type ExternalCliKind = "claude" | "codex";

/** Generous per-session cap on retained terminal jobs — a leak backstop, not a
 *  UX limit; a human never spawns this many background jobs in one session. */
const MAX_TERMINAL_JOBS_PER_SESSION = 50;

/** A background job, running or finished. */
export interface BackgroundJobEntry {
  jobId: string;
  sessionId: string;
  /** Machine-readable kind for tools that need to target a subset of jobs. */
  kind?: BackgroundJobKind;
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
  /** Working directory for jobs that operate on the filesystem, e.g. DriveAgent. */
  cwd?: string;
  /** DriveAgent prompt summary, separate from the UI-oriented description. */
  promptSummary?: string;
  /** External CLI kind for DriveAgent jobs. */
  cli?: ExternalCliKind;
  /** Client message that launched this external job. */
  originClientMessageId?: string;
  /** Optional cancellation hook for jobs backed by a live process. */
  abort?: () => void | Promise<void>;
}

/** Outcome passed to finish() to record how a job ended. */
export interface BackgroundJobOutcome {
  status?: "completed" | "failed" | "cancelled";
  finalText?: string;
  ccSessionId?: string;
  changedFiles?: string[];
}

export interface BackgroundJobStartOptions {
  kind?: BackgroundJobKind;
  cwd?: string;
  promptSummary?: string;
  cli?: ExternalCliKind;
  originClientMessageId?: string;
  abort?: () => void | Promise<void>;
}

const CANCEL_WAIT_TIMEOUT_MS = 5_000;

function isActiveStatus(status: BackgroundJobStatus): boolean {
  return status === "running" || status === "cancelling";
}

async function waitForAbort(abort: () => void | Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(abort),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CANCEL_WAIT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Cancellation is best-effort; the terminal state still closes after the
    // abort hook settles or the hard deadline expires.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class BackgroundJobRegistry {
  private jobs = new Map<string, BackgroundJobEntry>(); // jobId -> entry (insertion-ordered)
  private listeners = new Set<Listener>();

  /** Register a running job. Invalid sessionId is ignored (cannot be waited on). */
  start(
    jobId: string,
    sessionId: string,
    description = "",
    options?: BackgroundJobStartOptions,
  ): void {
    if (!isValidSessionId(sessionId)) return;
    this.jobs.set(jobId, {
      jobId,
      sessionId,
      ...(options?.kind ? { kind: options.kind } : {}),
      description,
      status: "running",
      startedAt: Date.now(),
      ...(options?.cwd ? { cwd: normalizeCwdPath(options.cwd) } : {}),
      ...(options?.promptSummary ? { promptSummary: options.promptSummary } : {}),
      ...(options?.cli ? { cli: options.cli } : {}),
      ...(options?.originClientMessageId
        ? { originClientMessageId: options.originClientMessageId }
        : {}),
      ...(options?.abort ? { abort: options.abort } : {}),
    });
    this.notify();
  }

  /** Mark a job terminal (retained, not deleted). Unknown id is a no-op (no
   *  notify) so a double-finish or a finish after reset stays quiet. */
  finish(jobId: string, outcome?: BackgroundJobOutcome): void {
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    if (entry.status !== "running") return;
    entry.status = outcome?.status ?? "completed";
    entry.finishedAt = Date.now();
    if (outcome?.finalText !== undefined) entry.finalText = outcome.finalText;
    if (outcome?.ccSessionId !== undefined) entry.ccSessionId = outcome.ccSessionId;
    if (outcome?.changedFiles !== undefined) entry.changedFiles = outcome.changedFiles;
    this.evictTerminalOverCap(entry.sessionId);
    this.notify();
  }

  get(jobId: string): BackgroundJobEntry | undefined {
    return this.jobs.get(jobId);
  }

  /** Persist artifacts discovered while a running job is winding down. */
  recordArtifacts(
    jobId: string,
    artifacts: Pick<BackgroundJobOutcome, "ccSessionId" | "changedFiles">,
  ): void {
    const entry = this.jobs.get(jobId);
    if (!entry || !isActiveStatus(entry.status)) return;
    if (artifacts.ccSessionId !== undefined) entry.ccSessionId = artifacts.ccSessionId;
    if (artifacts.changedFiles !== undefined) entry.changedFiles = artifacts.changedFiles;
  }

  async cancel(jobId: string, outcome?: Omit<BackgroundJobOutcome, "status">): Promise<boolean> {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    if (entry.status !== "running") return false;
    // Publish a non-terminal guard before invoking external code. A completion
    // callback may synchronously re-enter finish(); it must not publish
    // completed/failed, while cwd/session conflict checks must still see the
    // process as active until the abort hook confirms exit.
    entry.status = "cancelling";
    this.notify();
    if (entry.abort) await waitForAbort(entry.abort);

    // Session teardown/reset may have removed the entry while termination was
    // in flight. Do not resurrect or notify for a closed session.
    if (this.jobs.get(jobId) !== entry || entry.status !== "cancelling") return false;
    entry.status = "cancelled";
    entry.finishedAt = Date.now();
    if (outcome?.finalText !== undefined) entry.finalText = outcome.finalText;
    if (outcome?.ccSessionId !== undefined) entry.ccSessionId = outcome.ccSessionId;
    if (outcome?.changedFiles !== undefined) entry.changedFiles = outcome.changedFiles;
    this.evictTerminalOverCap(entry.sessionId);
    this.notify();
    return true;
  }

  /** True while any running/cancelling job spawned by `sessionId` remains. */
  hasRunningForSession(sessionId: string): boolean {
    for (const e of this.jobs.values()) {
      if (e.sessionId === sessionId && isActiveStatus(e.status)) return true;
    }
    return false;
  }

  /** Running jobs spawned by `sessionId`. Feeds the goal judge's task list. */
  listRunningForSession(sessionId: string): BackgroundJobEntry[] {
    return [...this.jobs.values()].filter(
      (e) => e.sessionId === sessionId && isActiveStatus(e.status),
    );
  }

  /** Running jobs, across all sessions, that are operating in the same cwd. */
  listRunningByCwd(cwd: string): BackgroundJobEntry[] {
    const normalized = normalizeCwdPath(cwd);
    return [...this.jobs.values()].filter((e) => isActiveStatus(e.status) && e.cwd === normalized);
  }

  /** All jobs (running + retained terminal) for `sessionId`. Feeds the panel. */
  listForSession(sessionId: string): BackgroundJobEntry[] {
    return [...this.jobs.values()].filter((e) => e.sessionId === sessionId);
  }

  /** All jobs (running + retained terminal) across sessions. Feeds all-scope UI. */
  list(): BackgroundJobEntry[] {
    return [...this.jobs.values()];
  }

  /** Drop every job of a session — called when the session is deleted/closed. */
  dropForSession(sessionId: string): void {
    let removed = false;
    const aborts: Array<() => void | Promise<void>> = [];
    for (const [id, e] of this.jobs) {
      if (e.sessionId === sessionId) {
        // Delete first so a synchronous/queued completion caused by abort sees
        // no live registry entry and cannot publish a late result for a closed
        // session. Terminal jobs have nothing left to stop.
        this.jobs.delete(id);
        if (isActiveStatus(e.status) && e.abort) aborts.push(e.abort);
        removed = true;
      }
    }
    for (const abort of aborts) {
      try {
        void Promise.resolve(abort()).catch(() => undefined);
      } catch {
        // teardown is best-effort across jobs; continue reaping the rest
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
    const aborts = [...this.jobs.values()].flatMap((entry) =>
      isActiveStatus(entry.status) && entry.abort ? [entry.abort] : [],
    );
    this.jobs.clear();
    for (const abort of aborts) {
      try {
        void Promise.resolve(abort()).catch(() => undefined);
      } catch {
        // ignore
      }
    }
  }

  /** Backstop: keep at most MAX_TERMINAL_JOBS_PER_SESSION terminal jobs per
   *  session, evicting the oldest (insertion order). Running jobs never evicted. */
  private evictTerminalOverCap(sessionId: string): void {
    const terminal = [...this.jobs.values()].filter(
      (e) => e.sessionId === sessionId && !isActiveStatus(e.status),
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
