/**
 * Render batching for the remote stream.
 *
 * The Host sends one `agent/streamEvent` notification per StreamEvent, so a
 * streaming reply arrives as one WebSocket message per token. Dispatching each
 * of them separately re-renders the whole conversation once per token. This
 * buffer collects the high-frequency deltas in arrival order and hands them to
 * one batched reducer action per animation frame (or `maxDelayMs`, whichever
 * comes first — animation frames stall in hidden tabs).
 *
 * Only token-rate deltas are deferred. Any other event (turn boundaries,
 * tool start/result, turn_complete, error, Goal and user-message echoes, …)
 * flushes synchronously together with everything buffered before it, so
 * control state is never held back behind a frame. Callers must
 * also `flush()` before any other state change that depends on the stream
 * having been applied (history replay, reset, approvals, …). Pure logic, no
 * React; mirrors the idea of Desktop's streamCoalescer without merging events,
 * so every envelope reaches the reducer unchanged.
 */

/** Token-rate events that may wait for the next frame. Everything else is
 *  applied immediately (after the deltas buffered before it). */
const DEFERRABLE_EVENT_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "tool_use_args_delta",
  "agent_heartbeat",
]);

export interface StreamBatcherScheduler {
  /** Request a callback before the next paint; returns a cancel function. */
  frame?: (callback: () => void) => () => void;
  /** Fallback timer; returns a cancel function. */
  timeout: (callback: () => void, ms: number) => () => void;
}

export interface StreamBatcher {
  push(raw: unknown): void;
  /** Apply everything buffered now (no-op when empty). */
  flush(): void;
  /** Drop buffered events and pending timers without applying them. */
  discard(): void;
  readonly pending: number;
}

function defaultScheduler(): StreamBatcherScheduler {
  const frame =
    typeof globalThis.requestAnimationFrame === "function"
      ? (callback: () => void) => {
          const id = globalThis.requestAnimationFrame(() => callback());
          return () => globalThis.cancelAnimationFrame(id);
        }
      : undefined;
  return {
    frame,
    timeout: (callback, ms) => {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
  };
}

function eventType(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const params = (raw as { params?: unknown }).params;
  const event =
    params && typeof params === "object" ? (params as { event?: unknown }).event : undefined;
  const type = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
  return typeof type === "string" ? type : undefined;
}

export function isDeferrableStreamEnvelope(raw: unknown): boolean {
  const type = eventType(raw);
  return type !== undefined && DEFERRABLE_EVENT_TYPES.has(type);
}

export function createStreamBatcher(
  onFlush: (events: unknown[]) => void,
  options: { maxDelayMs?: number; scheduler?: StreamBatcherScheduler } = {},
): StreamBatcher {
  const maxDelayMs = options.maxDelayMs ?? 50;
  const scheduler = options.scheduler ?? defaultScheduler();
  let buffer: unknown[] = [];
  let cancels: Array<() => void> = [];

  const cancelScheduled = () => {
    for (const cancel of cancels) cancel();
    cancels = [];
  };

  const flush = () => {
    cancelScheduled();
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    onFlush(events);
  };

  const schedule = () => {
    if (cancels.length > 0) return;
    if (scheduler.frame) cancels.push(scheduler.frame(flush));
    cancels.push(scheduler.timeout(flush, maxDelayMs));
  };

  return {
    push(raw) {
      buffer.push(raw);
      if (isDeferrableStreamEnvelope(raw)) schedule();
      else flush();
    },
    flush,
    discard() {
      cancelScheduled();
      buffer = [];
    },
    get pending() {
      return buffer.length;
    },
  };
}
