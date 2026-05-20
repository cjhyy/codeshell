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
export function buildNotificationMessage(items: NotificationItem[]): string {
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
