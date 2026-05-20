/**
 * Background-agent completion notification queue.
 *
 * Mirrors Claude Code's `commandQueue` with `mode: 'task-notification'`. A
 * background sub-agent that finishes (completed | failed) enqueues an item
 * here; the UI layer subscribes and, when the main agent is idle, drains
 * the queue and submits the formatted XML as a new user turn so the LLM
 * sees the result. Cancellation does NOT enqueue (user explicitly stopped
 * the agent; no follow-up needed).
 *
 * The result text lives only in this queue + the eventual user message —
 * not in `asyncAgentRegistry`. Registry stays metadata-only.
 *
 * Process-local singleton; same lifetime contract as `asyncAgentRegistry`.
 */

export type NotificationItem = {
  agentId: string;
  name?: string;
  description: string;
  status: "completed" | "failed";
  /** Final assistant text (completed only). */
  finalText?: string;
  /** Error message (failed only). */
  error?: string;
  enqueuedAt: number;
};

type Listener = () => void;

class NotificationQueue {
  private items: NotificationItem[] = [];
  private listeners = new Set<Listener>();

  enqueue(item: NotificationItem): void {
    this.items = [...this.items, item];
    this.notify();
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): NotificationItem[] => this.items;

  /** Atomic: returns all items and clears in one shot. */
  drainAll(): NotificationItem[] {
    if (this.items.length === 0) return [];
    const out = this.items;
    this.items = [];
    this.notify();
    return out;
  }

  reset(): void {
    this.items = [];
    this.notify();
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

export const notificationQueue = new NotificationQueue();
