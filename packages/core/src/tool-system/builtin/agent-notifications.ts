import type { BackgroundAgentCompletedEvent, StreamEvent } from "../../types.js";
import { logger } from "../../logging/logger.js";

/**
 * Background-agent completion notification queue.
 *
 * Mirrors Claude Code's `commandQueue` with `mode: 'task-notification'`. A
 * background sub-agent that finishes (completed | failed) enqueues an item
 * here; the UI layer subscribes and, when the main agent is idle, drains
 * the queue and submits the formatted XML as a new user turn so the LLM
 * sees the result. Sub-agent cancellation does NOT enqueue (user explicitly
 * stopped the agent; no follow-up needed). DriveAgent cancellation does enqueue
 * so a detached external CLI job never leaves the waiting session hanging.
 *
 * The result text lives only in this queue + the eventual user message —
 * not in `asyncAgentRegistry`. Registry stays metadata-only.
 *
 * Every enqueue must carry a sessionId. The B2 shim that allowed undefined
 * sessionId (a `__legacy__` bucket fallback) is gone — callers without a
 * session context (standalone tool tests) must mint a sessionId or use the
 * test helpers in `tests/` that do. At runtime, a bad sessionId (empty or
 * non-string, e.g. a caller bypassing the type via `as any`) is logged at
 * warn level and dropped — it does NOT touch the buckets or fire the bus.
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
  status: "completed" | "failed" | "cancelled";
  /** What kind of background work this was (lets UIs localize the toast). */
  workKind?: "agent" | "shell" | "video" | "cc";
  /** For workKind === "shell": the command that ran. */
  command?: string;
  /** Final assistant text (completed only). */
  finalText?: string;
  /** For workKind === "cc": the external claude session id this drove, so the
   *  result is recoverable from ~/.claude/projects/.../<ccSessionId>.jsonl even
   *  if this notification is lost, and the user sees a real session id (not just
   *  an opaque background jobId). */
  ccSessionId?: string;
  /** Error message (failed/cancelled only). */
  error?: string;
  enqueuedAt: number;
};

type Listener = () => void;

// Stable empty reference so `getSnapshot(sid)` returns the same array
// identity across calls when the bucket is empty. React's
// useSyncExternalStore compares snapshots by identity to decide whether
// to re-render — a fresh `[]` each call would cause render loops.
const EMPTY: readonly NotificationItem[] = Object.freeze([]);

/**
 * Runtime guard for sessionId. The static type is already `string` on
 * the public surface, but a caller bypassing the type system via
 * `as any` (or a stale JS-only consumer) could still smuggle in
 * undefined / "". We refuse those, log once, and let the agent path
 * continue — a buggy plugin shouldn't crash the engine.
 */
function isValidSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && sid.length > 0;
}

class NotificationQueue {
  private buckets = new Map<string, NotificationItem[]>();
  private listeners = new Set<Listener>();

  enqueue(item: NotificationItem, sessionId: string): void {
    if (!isValidSessionId(sessionId)) {
      logger.warn("notification_queue.invalid_session_id", {
        agentId: item.agentId,
        status: item.status,
        sessionIdType: typeof sessionId,
      });
      return;
    }
    const next = [...(this.buckets.get(sessionId) ?? []), item];
    this.buckets.set(sessionId, next);
    this.notify();
    // B2.2 — also publish to the protocol-facing bus. The bus is a
    // separate listener set so existing TUI subscribers (which poll the
    // queue via getSnapshot/drainAll) are unaffected. The server
    // subscribes on construction and forwards each event to its client
    // via the existing `agent/streamEvent` notification path.
    agentNotificationBus.publish(sessionId, notificationItemToStreamEvent(item));
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (sessionId: string): readonly NotificationItem[] => {
    if (!isValidSessionId(sessionId)) return EMPTY;
    return this.buckets.get(sessionId) ?? EMPTY;
  };

  /** Atomic: returns all items for a session and clears that bucket. */
  drainAll(sessionId: string): NotificationItem[] {
    if (!isValidSessionId(sessionId)) return [];
    const items = this.buckets.get(sessionId);
    if (!items || items.length === 0) return [];
    this.buckets.delete(sessionId);
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

// ─── Protocol-facing bus (B2.2) ─────────────────────────────────────
//
// A tiny process-local pub/sub that fires whenever a NotificationItem is
// enqueued. The server subscribes on construction and forwards each
// event through `Methods.StreamEvent` to its client. This keeps the
// dependency direction correct — tool-system doesn't import from the
// protocol layer; instead the protocol layer subscribes to a value
// owned here. Listener errors are isolated so one buggy subscriber can't
// poison fan-out to the others (same isolation rule as
// NotificationQueue.notify).

// Widened from BackgroundAgentCompletedEvent to StreamEvent: the bus now also
// carries `agent_heartbeat` (B). The server subscriber forwards whatever it
// gets to the client via Methods.StreamEvent generically, so any StreamEvent is
// safe to fan out here.
type BusHandler = (sessionId: string, event: StreamEvent) => void;

class AgentNotificationBus {
  private handlers = new Set<BusHandler>();

  publish(sessionId: string, event: StreamEvent): void {
    if (!isValidSessionId(sessionId)) {
      // Mirrors NotificationQueue.enqueue — refuse undefined / "" so the
      // server-side subscriber never has to defend against it.
      logger.warn("agent_notification_bus.invalid_session_id", {
        eventType: event.type,
        sessionIdType: typeof sessionId,
      });
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(sessionId, event);
      } catch {
        // isolate per-listener errors
      }
    }
  }

  subscribe(handler: BusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export const agentNotificationBus = new AgentNotificationBus();

/**
 * Project a queue item to its protocol-event shape. The two types are
 * field-compatible by design (see the comment on BackgroundAgentCompletedEvent
 * in types.ts) so this is essentially an identity tag.
 */
export function notificationItemToStreamEvent(
  item: NotificationItem,
): BackgroundAgentCompletedEvent {
  const event: BackgroundAgentCompletedEvent = {
    type: "background_agent_completed",
    agentId: item.agentId,
    description: item.description,
    status: item.status,
    enqueuedAt: item.enqueuedAt,
  };
  if (item.name !== undefined) event.name = item.name;
  if (item.workKind !== undefined) event.workKind = item.workKind;
  if (item.command !== undefined) event.command = item.command;
  if (item.finalText !== undefined) event.finalText = item.finalText;
  if (item.error !== undefined) event.error = item.error;
  return event;
}

/**
 * Escape XML-special characters. We only emit a fixed handful of tags, so
 * we can hand-roll this rather than pulling in a full encoder. Attribute
 * values get the quote escape too; element bodies don't need it.
 */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      // For DriveClaudeCode jobs, expose the real claude session id so the model
      // can cite it / recover the full result from disk if needed.
      const ccAttr = item.ccSessionId ? ` ccSessionId="${escapeXmlAttr(item.ccSessionId)}"` : "";
      const opening = `  <agent id="${escapeXmlAttr(item.agentId)}"${nameAttr} status="${item.status}"${ccAttr}>`;
      const desc = `    <description>${escapeXmlText(item.description)}</description>`;
      const body =
        item.status === "completed"
          ? `    <result>\n${escapeXmlText(item.finalText ?? "")}\n    </result>`
          : item.status === "cancelled"
            ? `    <cancelled>${escapeXmlText(item.error ?? "cancelled")}</cancelled>`
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
    const badge =
      item.status === "completed" ? "✓" : item.status === "cancelled" ? "cancelled" : "✗";
    const namePart = item.name ? `${item.name}  ·  ` : "";
    const statusPart =
      item.status === "failed"
        ? `  ·  failed: ${item.error ?? "unknown"}`
        : item.status === "cancelled"
          ? `  ·  cancelled`
          : "";
    return `  └─ ${namePart}${item.description}  ·  ${badge}${statusPart}`;
  });
  return [header, ...rows].join("\n");
}
