import type { StreamEvent } from "../types.js";

/** Source time survives journal replay and transport reconnects unchanged. */
export function stampStreamEvent(event: StreamEvent, timestamp = Date.now()): StreamEvent {
  return typeof event.timestamp === "number" &&
    Number.isFinite(event.timestamp) &&
    event.timestamp >= 0
    ? event
    : { ...event, timestamp };
}

/** One logical submission, including preparation, tools, steering and Goal continuations. */
export function createRunTiming(
  clock: { now(): number; monotonicNow(): number } = {
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
  },
): { startedAt: number; prepareEvent(event: StreamEvent): StreamEvent } {
  const startedAt = clock.now();
  const monotonicStart = clock.monotonicNow();
  let terminalTiming: { startedAt: number; completedAt: number; durationMs: number } | undefined;
  return {
    startedAt,
    prepareEvent(event) {
      event = stampStreamEvent(event, clock.now());
      if ("agentId" in event && event.agentId) return event;
      if (event.type === "session_started") return { ...event, startedAt };
      // Child terminals are mirrored into the parent's stream. They must keep
      // the child's duration and cannot finish the parent's logical clock.
      if (event.type === "turn_complete") {
        terminalTiming ??= {
          startedAt,
          completedAt: event.timestamp!,
          durationMs: Math.max(0, Math.round(clock.monotonicNow() - monotonicStart)),
        };
        return { ...event, ...terminalTiming };
      }
      return event;
    },
  };
}
