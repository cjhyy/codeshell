import type { SessionTailEvent } from "@cjhyy/code-shell-capability-coding/orchestration";

/**
 * Activity state of one EXTERNAL CLI session (Codex/Claude), derived purely
 * from its transcript tail. No "queued"/"waiting-decision": external storage
 * records neither queueing nor approval waits, so we never claim them.
 */
export interface ExternalSessionActivity {
  runState: "running" | "idle";
  phase?: "model" | "tool";
  /** Most recent tool name while phase === "tool". */
  toolName?: string;
  lastEventAt: number;
}

/** Initial state for a session we have not tailed yet, judged by file mtime. */
export function seedExternalActivity(
  mtimeMs: number,
  now: number,
  quietMs: number,
): ExternalSessionActivity {
  return now - mtimeMs <= quietMs
    ? { runState: "running", lastEventAt: mtimeMs }
    : { runState: "idle", lastEventAt: mtimeMs };
}

export function reduceExternalTail(
  previous: ExternalSessionActivity | undefined,
  events: readonly SessionTailEvent[],
  observedAt: number,
): ExternalSessionActivity {
  let next = previous ?? { runState: "idle" as const, lastEventAt: observedAt };
  for (const event of events) {
    switch (event.type) {
      case "user":
      case "assistant":
        next = { runState: "running", phase: "model", lastEventAt: observedAt };
        break;
      case "tool":
        next = {
          runState: "running",
          phase: "tool",
          toolName: event.name,
          lastEventAt: observedAt,
        };
        break;
      case "tool_result":
        next = next.toolName
          ? { runState: "running", phase: "tool", toolName: next.toolName, lastEventAt: observedAt }
          : { runState: "running", lastEventAt: observedAt };
        break;
      case "turn_end":
        next = { runState: "idle", lastEventAt: observedAt };
        break;
    }
  }
  return next;
}

/** A writer killed mid-turn never emits turn_end; fall back to idle after quietMs. */
export function decayExternalActivity(
  activity: ExternalSessionActivity,
  now: number,
  quietMs: number,
): ExternalSessionActivity {
  if (activity.runState !== "running" || now - activity.lastEventAt <= quietMs) return activity;
  return { runState: "idle", lastEventAt: activity.lastEventAt };
}
