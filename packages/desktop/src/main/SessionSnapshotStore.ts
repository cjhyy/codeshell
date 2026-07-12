/**
 * SessionSnapshotStore — main-process, per-session event snapshot.
 *
 * The renderer is a thin client whose in-memory event buffer + route table are
 * wiped on every remount (refresh / HMR / crash recovery). The main process
 * (AgentBridge) does not remount, so it holds a snapshot a reloaded renderer
 * can re-subscribe to and replay — that is what keeps a resumed worker's output
 * visible after a reload.
 *
 * Live StreamEvents carry no stable id, so this store stamps each event with a
 * monotonic `seq` per session. That seq is the cursor: the renderer asks for
 * everything `since` the last seq it saw, so the snapshot and the live
 * increment stream align with no gap and no duplication.
 *
 * Bounded: only the most recent `maxPerSession` events are retained (older ones
 * are recoverable from the on-disk transcript — see phase 4). seq never resets,
 * so eviction can't cause a cursor collision.
 */

/** One snapshot entry: the forwarded event plus its assigned sequence. */
export interface SnapshotEntry {
  seq: number;
  event: unknown;
}

export interface Snapshot {
  events: SnapshotEntry[];
  /** The seq the next appended event will receive (cursor for the client). */
  nextSeq: number;
  /** Authoritative top-level run state, retained independently of event eviction. */
  topLevelRunning: boolean;
}

interface SessionLog {
  events: SnapshotEntry[];
  /** Next seq to assign — keeps climbing across eviction, never reused. */
  nextSeq: number;
  /** Current top-level run state from the complete worker event stream. */
  topLevelRunning: boolean;
}

const DEFAULT_MAX_PER_SESSION = 2000;

export class SessionSnapshotStore {
  private readonly logs = new Map<string, SessionLog>();
  private readonly maxPerSession: number;

  constructor(opts?: { maxPerSession?: number }) {
    this.maxPerSession = opts?.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  }

  /** Record a forwarded event for a session, assigning it the next seq. */
  append(sessionId: string, event: unknown): SnapshotEntry {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = { events: [], nextSeq: 1, topLevelRunning: false };
      this.logs.set(sessionId, log);
    }
    const lifecycle = event as { type?: unknown; agentId?: unknown } | null;
    if (lifecycle && !lifecycle.agentId) {
      if (lifecycle.type === "session_started" || lifecycle.type === "stream_request_start") {
        log.topLevelRunning = true;
      } else if (lifecycle.type === "turn_complete" || lifecycle.type === "error") {
        log.topLevelRunning = false;
      }
    }
    const entry = { seq: log.nextSeq, event };
    log.events.push(entry);
    log.nextSeq += 1;
    if (log.events.length > this.maxPerSession) {
      log.events.splice(0, log.events.length - this.maxPerSession);
    }
    return entry;
  }

  /**
   * Snapshot for a session. With `sinceSeq`, returns only entries with a
   * strictly-greater seq (the increment the client is missing).
   */
  get(sessionId: string, sinceSeq = 0): Snapshot {
    const log = this.logs.get(sessionId);
    if (!log) return { events: [], nextSeq: 1, topLevelRunning: false };
    const events = sinceSeq > 0 ? log.events.filter((e) => e.seq > sinceSeq) : log.events.slice();
    return { events, nextSeq: log.nextSeq, topLevelRunning: log.topLevelRunning };
  }

  /**
   * A worker exited. Retain replay events, but mark only sessions owned by
   * that worker idle. Other producers (for example in-main automation) share
   * this store and must keep their independent run state.
   */
  onWorkerExit(ownedSessionIds: Iterable<string>): void {
    for (const sessionId of ownedSessionIds) {
      const log = this.logs.get(sessionId);
      if (log) log.topLevelRunning = false;
    }
  }

  /** Drop a single session's snapshot (e.g. when the session is deleted). */
  forget(sessionId: string): void {
    this.logs.delete(sessionId);
  }
}
