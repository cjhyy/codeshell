import type { CompanionOperation } from "./cua-activity-server.js";

export type RunOutcome = "completed" | "failed" | "cancelled";

export interface ComputerActivityListener {
  onOperation(event: CompanionOperation): void | Promise<void>;
  onRun?(run: { sessionId: string; outcome: RunOutcome }): void;
}

const MAX_QUEUED = 64;
const MAX_TRACKED_SESSIONS = 32;

/** Bounded, ordered presentation queue between the execution side and any
 * character. Updates coalesce per operation; an operation that ends before its
 * start was delivered is dropped whole; ends are never dropped otherwise. */
export class ComputerActivityBus {
  private listener?: ComputerActivityListener;
  private readonly queue: Array<{ event: CompanionOperation; done?: () => void }> = [];
  private readonly delivered = new Set<string>();
  private readonly sessions = new Set<string>();
  private draining = false;

  subscribe(listener: ComputerActivityListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  /** Resolves immediately, except for a capture start: that resolves once the
   * character has handled it (hidden itself), so the screenshot excludes it. */
  publish(event: CompanionOperation): Promise<void> {
    if (event.sessionId) this.trackSession(event.sessionId);
    if (event.phase === "update") {
      const queued = this.queue.find(
        (item) => item.event.id === event.id && item.event.phase === "update",
      );
      if (queued) {
        queued.event = event;
        return Promise.resolve();
      }
    }
    if (event.phase === "end" && !this.delivered.has(event.id)) {
      const before = this.queue.length;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i]!.event.id !== event.id) continue;
        this.queue[i]!.done?.();
        this.queue.splice(i, 1);
      }
      // Neither the start nor anything else of it was shown: drop it whole.
      if (this.queue.length !== before) return Promise.resolve();
    }
    while (this.queue.length >= MAX_QUEUED) {
      const index = this.queue.findIndex((item) => item.event.phase !== "end");
      if (index < 0) break;
      this.queue[index]!.done?.();
      this.queue.splice(index, 1);
    }
    const capture = event.phase === "start" && event.capture;
    const settled = capture
      ? new Promise<void>((resolve) => this.queue.push({ event, done: resolve }))
      : (this.queue.push({ event }), Promise.resolve());
    void this.drain();
    return settled;
  }

  /** Only runs that actually used the computer are presented. */
  publishRun(sessionId: string, outcome: RunOutcome): void {
    if (!this.sessions.delete(sessionId)) return;
    try {
      this.listener?.onRun?.({ sessionId, outcome });
    } catch {
      /* Presentation failure never affects the run. */
    }
  }

  private trackSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessions.add(sessionId);
    while (this.sessions.size > MAX_TRACKED_SESSIONS)
      this.sessions.delete(this.sessions.values().next().value!);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        const { event } = item;
        if (event.phase === "start") this.delivered.add(event.id);
        if (event.phase === "end") this.delivered.delete(event.id);
        while (this.delivered.size > 256)
          this.delivered.delete(this.delivered.values().next().value!);
        try {
          await this.listener?.onOperation(event);
        } catch {
          /* Presentation failure never affects execution. */
        } finally {
          item.done?.();
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
