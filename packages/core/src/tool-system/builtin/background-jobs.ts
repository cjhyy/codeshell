/**
 * Lightweight registry of NON-agent background jobs (currently: GenerateVideo's
 * background poll loop). Mirrors the role `asyncAgentRegistry` plays for
 * background sub-agents, but deliberately tiny: a video job is not an agent —
 * it has no transcript, no abort(), and must NOT show up in AgentStatus. All
 * the engine needs is "does this session still have a background job running?"
 * so its wait-for-background loop parks the turn until the job's completion
 * notification lands, instead of letting the goal-stop-hook force the model to
 * busy-loop with `sleep` while the video renders (the s-mqe0ox7n-a8d11c26 bug).
 *
 * Process-local singleton, same pattern as asyncAgentRegistry. The video poll
 * runs in the main engine process, so start/finish and the engine's wait loop
 * observe the same instance.
 */

function isValidSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && sid.length > 0;
}

type Listener = () => void;

class BackgroundJobRegistry {
  private jobs = new Map<string, string>(); // jobId -> sessionId
  private listeners = new Set<Listener>();

  /** Register a running job. Invalid sessionId is ignored (cannot be waited on). */
  start(jobId: string, sessionId: string): void {
    if (!isValidSessionId(sessionId)) return;
    this.jobs.set(jobId, sessionId);
    this.notify();
  }

  /** Mark a job done. Unknown id is a no-op (no notify) so a double-finish or
   *  a finish after reset stays quiet. */
  finish(jobId: string): void {
    if (!this.jobs.has(jobId)) return;
    this.jobs.delete(jobId);
    this.notify();
  }

  /** True while any background job spawned by `sessionId` is still running.
   *  Drives Engine.run's "wait for my background work before resolving". */
  hasRunningForSession(sessionId: string): boolean {
    for (const sid of this.jobs.values()) {
      if (sid === sessionId) return true;
    }
    return false;
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
