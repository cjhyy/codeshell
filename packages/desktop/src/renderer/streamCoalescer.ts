import type { StreamEvent } from "@cjhyy/code-shell-core";

/** Flushes a batch of events in arrival order. Callers apply them under a
 *  single reducer dispatch so one 50ms window = one render, not one per event. */
export interface SequencedStreamEvent {
  event: StreamEvent;
  seq?: number;
  epoch?: string;
}
type FlushBatch = (events: StreamEvent[], raw: SequencedStreamEvent[]) => void;

type PendingText = Extract<StreamEvent, { type: "text_delta" }>;
type PendingArgs = Extract<StreamEvent, { type: "tool_use_args_delta" }>;

/**
 * Coalesce a stream into batched, render-friendly flushes.
 *
 * Two jobs, both aimed at cutting renderer load when a (sub-)agent emits
 * events at high frequency:
 *
 *  1. Merge rapid `text_delta` / `tool_use_args_delta` bursts into one event
 *     each (mirrors the TUI's 50ms `flushTextBuffer`).
 *  2. Batch EVERYTHING flushed in a 50ms window — including boundary events
 *     like tool_use_start / tool_result / agent_* — into a single
 *     `onFlushBatch` call, so the reducer dispatches once per window instead
 *     of once per event. Before this, every tool_use_start/tool_result went
 *     straight to its own dispatch → its own full re-render of the (un-
 *     virtualized) message list; a tool-heavy sub-agent could fire dozens per
 *     second and starve scrolling. (perf: scroll-jank-2026-06-02)
 *
 * Ordering: a single insertion-ordered `order` list records every key (delta
 * slots + boundary events) as first seen, so the batch preserves arrival
 * order across types. Re-seeing a delta key merges into the existing slot
 * without re-appending — its original position is kept.
 * A run/client identity change flushes the preceding segment first, including
 * passthrough thinking events, so late output cannot merge into a newer run.
 *
 * `error` still flushes synchronously and alone (it must surface instantly and
 * may precede teardown). Pure logic, no React.
 */
export function createEventCoalescer(onFlushBatch: FlushBatch, intervalMs = 50) {
  // Ordered record of pending items. Delta slots are referenced by key so
  // repeats merge; boundary events are inlined as one-shot entries.
  type Slot =
    | { kind: "text"; key: string }
    | { kind: "args"; key: string }
    | { kind: "passthrough"; event: StreamEvent };
  let order: Slot[] = [];
  const textBuf = new Map<string, PendingText>();
  const argsBuf = new Map<string, PendingArgs>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let segment = 0;
  let raw: SequencedStreamEvent[] = [];
  let pendingRunIdentity: string | null = null;

  function isHardBoundary(event: StreamEvent): boolean {
    switch (event.type) {
      case "session_user_message":
      case "stream_request_start":
      case "assistant_message":
      case "turn_complete":
      case "tool_use_start":
      case "tool_result":
      case "agent_start":
      case "agent_end":
      case "agent_backgrounded":
      case "background_agent_completed":
      case "tombstone":
        return true;
      default:
        return false;
    }
  }

  function drainToBatch(): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (const slot of order) {
      if (slot.kind === "text") {
        const p = textBuf.get(slot.key);
        if (!p) continue;
        out.push(p);
      } else if (slot.kind === "args") {
        const p = argsBuf.get(slot.key);
        if (!p) continue;
        out.push(p);
      } else {
        out.push(slot.event);
      }
    }
    order = [];
    textBuf.clear();
    argsBuf.clear();
    return out;
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = drainToBatch();
    const entries = raw;
    raw = [];
    pendingRunIdentity = null;
    if (batch.length > 0) onFlushBatch(batch, entries);
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, intervalMs);
  }

  function push(event: StreamEvent, seq?: number, epoch?: string): void {
    const t = event.type;
    if (t === "error") {
      flush();
      onFlushBatch([event], [{ event, seq, epoch }]);
      return;
    }
    const runIdentity = JSON.stringify([event.runId ?? null, event.clientMessageId ?? null]);
    if (pendingRunIdentity !== null && pendingRunIdentity !== runIdentity) flush();
    pendingRunIdentity = runIdentity;
    raw.push({ event, seq, epoch });
    if (t === "text_delta") {
      const agentId = event.agentId;
      const key = `text|${segment}|${agentId ?? ""}`;
      const prev = textBuf.get(key);
      if (prev) {
        prev.text += event.text;
        if (event.tokens !== undefined) {
          prev.tokens = (prev.tokens ?? 0) + event.tokens;
        }
      } else {
        // Keep the complete envelope on the merged event. Clone it so neither
        // concatenation nor token accumulation mutates raw replay metadata.
        textBuf.set(key, { ...event });
        order.push({ kind: "text", key });
      }
      scheduleFlush();
      return;
    }
    if (t === "tool_use_args_delta") {
      const agentId = event.agentId;
      const toolCallId = event.toolCallId;
      const key = `args|${segment}|${agentId ?? ""}|${toolCallId}`;
      const prev = argsBuf.get(key);
      if (prev) {
        Object.assign(prev.args, event.args);
      } else {
        argsBuf.set(key, {
          ...event,
          args: { ...event.args },
        });
        order.push({ kind: "args", key });
      }
      scheduleFlush();
      return;
    }
    // Boundary events still join the ordered batch, but they also advance the
    // delta segment so later text/args cannot merge back across the boundary.
    // Non-boundary passthrough events (session_started, usage_update, ...) do
    // not split segments.
    order.push({ kind: "passthrough", event });
    if (isHardBoundary(event)) {
      segment += 1;
    }
    scheduleFlush();
  }

  function dispose(): void {
    flush();
  }

  function discard(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    drainToBatch();
    raw = [];
    pendingRunIdentity = null;
  }

  return { push, flush, dispose, discard };
}
