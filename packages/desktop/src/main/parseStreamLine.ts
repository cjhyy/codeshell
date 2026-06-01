/**
 * Pure parse of a worker→renderer JSON-RPC line into a snapshot append, if any.
 *
 * Extracted from AgentBridge's readline handler so "which lines feed the
 * snapshot" is unit-testable without spawning a subprocess. Only
 * `agent/streamEvent` notifications carry a (sessionId, event) pair worth
 * retaining; everything else (responses, other methods, malformed lines)
 * yields null — those lines are still forwarded, just not snapshotted.
 */
export interface SnapshotAppend {
  sessionId: string;
  event: unknown;
}

export function parseSnapshotAppend(line: string): SnapshotAppend | null {
  let m: { method?: string; params?: { sessionId?: unknown; event?: unknown } };
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (m.method !== "agent/streamEvent") return null;
  const sessionId = m.params?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (m.params?.event === undefined) return null;
  return { sessionId, event: m.params.event };
}
