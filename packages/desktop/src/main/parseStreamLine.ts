/**
 * Pure parse of a worker→renderer JSON-RPC line into a snapshot append, if any.
 *
 * Extracted from AgentBridge's readline handler so "which lines feed the
 * snapshot" is unit-testable without spawning a subprocess. Only
 * `agent/streamEvent` notifications carry a (sessionId, event) pair worth
 * retaining; everything else (responses, other methods, malformed lines)
 * yields null — those lines are still forwarded, just not snapshotted.
 */
import { Methods } from "@cjhyy/code-shell-core";

export interface SnapshotAppend {
  sessionId: string;
  event: unknown;
}

export interface LiveStreamEnvelope {
  sessionId: string;
  event: unknown;
  seq?: number;
}

export function parseSnapshotAppend(line: string): SnapshotAppend | null {
  let m: { method?: string; params?: { sessionId?: unknown; event?: unknown } };
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (m.method !== Methods.StreamEvent) return null;
  const sessionId = m.params?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (m.params?.event === undefined) return null;
  // steer_injected is a LIVE-only marker. The engine already persisted the
  // steered text as a `user` message in the transcript, so a resume rebuilds
  // that bubble from the transcript. If we ALSO snapshotted the event, resume
  // would replay it through applyStreamEvent → appendUserMessage and the SAME
  // steered message would render twice (the s-mqjl1uap double-bubble bug). Keep
  // it out of the snapshot: live shows one bubble (from the event), resume shows
  // one (from the transcript) — never both.
  const evType = (m.params.event as { type?: unknown } | null)?.type;
  if (evType === "steer_injected") return null;
  return { sessionId, event: m.params.event };
}

export function parseLiveStreamEnvelope(
  line: string,
  snapshotEntry?: { seq: number },
): LiveStreamEnvelope | null {
  let m: { method?: string; params?: { sessionId?: unknown; event?: unknown } };
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (m.method !== Methods.StreamEvent) return null;
  if (m.params?.event === undefined) return null;
  const sessionId = typeof m.params.sessionId === "string" ? m.params.sessionId : "";
  return {
    sessionId,
    event: m.params.event,
    ...(snapshotEntry ? { seq: snapshotEntry.seq } : {}),
  };
}
