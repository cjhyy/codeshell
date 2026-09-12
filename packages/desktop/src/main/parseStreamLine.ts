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
import { normalizeStreamEnvelope } from "../shared/stream-envelope.js";

export interface SnapshotAppend {
  sessionId: string;
  event: unknown;
}

export interface LiveStreamEnvelope {
  sessionId: string;
  event: unknown;
  seq?: number;
  epoch?: string;
}

export function parseSnapshotAppend(line: string): SnapshotAppend | null {
  let m: { method?: string; params?: { sessionId?: unknown; event?: unknown } };
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || m.method !== Methods.StreamEvent) return null;
  const envelope = normalizeStreamEnvelope(m.params);
  if (!envelope?.sessionId) return null;
  const { sessionId, event } = envelope;
  // Identified steers are real user-turn boundaries. Dropping them attaches
  // later replies to the previous input on replay. Their persisted steerId
  // lets hydration join the same user intent without adding a second bubble.
  // Legacy markers without an id still cannot be joined safely (s-mqjl1uap).
  if (event.type === "steer_injected" && (typeof event.id !== "string" || !event.id.trim()))
    return null;
  return { sessionId, event };
}

export function parseLiveStreamEnvelope(
  line: string,
  snapshotEntry?: { seq: number; epoch?: string },
): LiveStreamEnvelope | null {
  let m: { method?: string; params?: { sessionId?: unknown; event?: unknown } };
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || m.method !== Methods.StreamEvent) return null;
  const envelope = normalizeStreamEnvelope(m.params);
  if (!envelope) return null;
  return {
    ...envelope,
    ...(snapshotEntry ? { seq: snapshotEntry.seq } : {}),
    ...(snapshotEntry?.epoch ? { epoch: snapshotEntry.epoch } : {}),
  };
}
