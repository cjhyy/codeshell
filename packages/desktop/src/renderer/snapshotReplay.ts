/**
 * Pick which snapshot events a (re)subscribing renderer must replay.
 *
 * The renderer tracks the highest seq it has applied per bucket. On a fresh
 * remount that cursor is 0 and the whole snapshot replays; while live it only
 * replays events past the cursor, so the main-held snapshot and the live
 * stream align with no gap and no duplicate. seq is assigned by the main
 * SessionSnapshotStore — live StreamEvents have no stable id of their own.
 */
import type { SessionSnapshot } from "../preload/types";

export interface ReplaySelection {
  /** The bare events to feed through the normal stream reducer, in order. */
  events: unknown[];
  /** New highest-applied seq (unchanged if nothing was replayed). */
  cursor: number;
}

export function selectReplayEvents(snapshot: SessionSnapshot, appliedSeq: number): ReplaySelection {
  let cursor = appliedSeq;
  const events: unknown[] = [];
  for (const entry of snapshot.events) {
    if (entry.seq > appliedSeq) {
      events.push(entry.event);
      if (entry.seq > cursor) cursor = entry.seq;
    }
  }
  return { events, cursor };
}

/** Whether the retained snapshot ends inside an unfinished top-level turn. */
export function snapshotHasUnfinishedTopLevelTurn(snapshot: SessionSnapshot): boolean {
  if (typeof snapshot.topLevelRunning === "boolean") return snapshot.topLevelRunning;

  let running = false;
  for (const entry of snapshot.events) {
    const event = entry.event as { type?: unknown; agentId?: unknown };
    if (event.agentId) continue;
    if (event.type === "session_started" || event.type === "stream_request_start") {
      running = true;
    } else if (event.type === "turn_complete" || event.type === "error") {
      running = false;
    }
  }
  return running;
}
