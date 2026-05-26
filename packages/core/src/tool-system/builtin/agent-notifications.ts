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
 * B2 (2026-05-26): items are keyed by `sessionId`. Same Engine process
 * may host concurrent sessions (multi-session host roadmap, standard §S3),
 * and a background agent spawned from session A must not deliver its
 * result XML into session B's next turn. Callers that don't supply a
 * `sessionId` (legacy / ad-hoc tests) operate on a `__legacy__` bucket
 * so untouched call sites keep working until B2.2 promotes notifications
 * to a protocol StreamEvent.
 *
 * Listeners are still process-wide: any bucket change wakes every
 * subscriber, and each subscriber filters by sessionId when reading
 * `getSnapshot(sid)`. This matches `useSyncExternalStore`'s contract.
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

const LEGACY_BUCKET = "__legacy__";

// Stable empty reference so `getSnapshot(sid)` returns the same array
// identity across calls when the bucket is empty. React's
// useSyncExternalStore compares snapshots by identity to decide whether
// to re-render — a fresh `[]` each call would cause render loops.
const EMPTY: readonly NotificationItem[] = Object.freeze([]);

class NotificationQueue {
  private buckets = new Map<string, NotificationItem[]>();
  private listeners = new Set<Listener>();

  enqueue(item: NotificationItem, sessionId?: string): void {
    const key = sessionId ?? LEGACY_BUCKET;
    const next = [...(this.buckets.get(key) ?? []), item];
    this.buckets.set(key, next);
    this.notify();
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (sessionId?: string): readonly NotificationItem[] => {
    return this.buckets.get(sessionId ?? LEGACY_BUCKET) ?? EMPTY;
  };

  /** Atomic: returns all items for a session and clears that bucket. */
  drainAll(sessionId?: string): NotificationItem[] {
    const key = sessionId ?? LEGACY_BUCKET;
    const items = this.buckets.get(key);
    if (!items || items.length === 0) return [];
    this.buckets.delete(key);
    this.notify();
    return items;
  }

  /**
   * Clear one bucket (sessionId given) or every bucket (no arg). Used by
   * tests; production code drains per-session through `drainAll`.
   */
  reset(sessionId?: string): void {
    if (sessionId === undefined) {
      if (this.buckets.size === 0) return;
      this.buckets.clear();
    } else {
      if (!this.buckets.has(sessionId)) return;
      this.buckets.delete(sessionId);
    }
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

/**
 * Escape XML-special characters. We only emit a fixed handful of tags, so
 * we can hand-roll this rather than pulling in a full encoder. Attribute
 * values get the quote escape too; element bodies don't need it.
 */
function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;");
}

/**
 * Render a batch of completion notifications as the XML user-message
 * body that the main agent's LLM will see. Format is stable — main
 * agent prompts can rely on the `<background-agents-completed>` root
 * tag as a signal that this turn is a system-injected notification,
 * not a real user message.
 */
export function buildNotificationMessage(items: readonly NotificationItem[]): string {
  const agents = items
    .map((item) => {
      const nameAttr = item.name ? ` name="${escapeXmlAttr(item.name)}"` : "";
      const opening = `  <agent id="${escapeXmlAttr(item.agentId)}"${nameAttr} status="${item.status}">`;
      const desc = `    <description>${escapeXmlText(item.description)}</description>`;
      const body =
        item.status === "completed"
          ? `    <result>\n${escapeXmlText(item.finalText ?? "")}\n    </result>`
          : `    <error>${escapeXmlText(item.error ?? "")}</error>`;
      return [opening, desc, body, "  </agent>"].join("\n");
    })
    .join("\n");

  return [
    "<background-agents-completed>",
    agents,
    "</background-agents-completed>",
    "",
    "Above are results from background agents that finished while you were idle. Address them appropriately — summarize for the user, continue work, or ignore if no longer relevant.",
  ].join("\n");
}

/**
 * One-line-per-agent human summary for the chat feed. The full result
 * body goes to the LLM via buildNotificationMessage; the user sees only
 * this terse marker plus an optional inline error preview, and can
 * switch to the sub-agent's dock view if they want details.
 */
export function buildNotificationSummary(items: readonly NotificationItem[]): string {
  const header = "📨 background agents completed";
  const rows = items.map((item) => {
    const badge = item.status === "completed" ? "✓" : "✗";
    const namePart = item.name ? `${item.name}  ·  ` : "";
    const statusPart = item.status === "failed" ? `  ·  failed: ${item.error ?? "unknown"}` : "";
    return `  └─ ${namePart}${item.description}  ·  ${badge}${statusPart}`;
  });
  return [header, ...rows].join("\n");
}
