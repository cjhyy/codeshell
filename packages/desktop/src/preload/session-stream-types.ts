import type { StreamEvent } from "@cjhyy/code-shell-core";

/**
 * Multi-session stream envelope. The renderer routes by sessionId; a missing
 * sessionId (legacy single-engine path) routes to the active session.
 */
export interface StreamEventEnvelope {
  /** Main-process lifetime for the accompanying sequence. Absent on older bridges. */
  epoch?: string;
  sessionId: string;
  event: StreamEvent;
  seq?: number;
}

/** One entry in a main-held session snapshot: a forwarded event + its seq. */
export interface SnapshotEntry {
  seq: number;
  event: StreamEvent;
}

/** Reply to subscribeSession — events past the requested cursor + next cursor. */
export interface SessionSnapshot {
  /** Main-process lifetime for these sequence numbers. Absent on older bridges. */
  epoch?: string;
  events: SnapshotEntry[];
  nextSeq: number;
  /** Main-authoritative top-level run state. Missing on legacy snapshots. */
  topLevelRunning?: boolean;
}

/**
 * A raw on-disk transcript event (getSessionRawEvents). Preserves the stable
 * `id` (dedup key) and `turnNumber`/`timestamp` that the folded reader drops.
 */
export interface RawTranscriptEvent {
  id: string;
  type: string;
  timestamp: number;
  turnNumber: number;
  data: Record<string, unknown>;
}
