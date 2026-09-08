import { randomUUID } from "node:crypto";

export interface HubStreamCursor {
  epoch: string;
  sequence: number;
}

interface RunLog {
  baselineEvents: number;
  events: Array<{ sequence: number; event: unknown }>;
  bytes: number;
  truncated: boolean;
  requests: Set<string>;
}

/**
 * A refresh can happen before the worker persists its current assistant text.
 * Retain that run's stream separately from the durable pre-run transcript.
 * The host takes snapshots synchronously, so its cursor also covers all live
 * notifications sent before the snapshot response, without replaying twice.
 */
export class HubRunReplay {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private totalBytes = 0;
  private readonly sessions = new Map<string, RunLog>();

  constructor(
    private readonly limits: { maxBytes: number; maxEvents: number; maxTotalBytes?: number } = {
      maxBytes: 8 * 1024 * 1024,
      maxEvents: 16_000,
      maxTotalBytes: 64 * 1024 * 1024,
    },
  ) {}

  begin(sessionId: string, requestId: string, baselineEvents: number): void {
    let log = this.sessions.get(sessionId);
    if (!log) {
      log = {
        baselineEvents: Number.isSafeInteger(baselineEvents) ? Math.max(0, baselineEvents) : 0,
        events: [],
        bytes: 0,
        truncated: false,
        requests: new Set(),
      };
      this.sessions.set(sessionId, log);
    }
    log.requests.add(requestId);
  }

  /** Only a new, still-tracked conversation can safely replay before disk publication. */
  hasEmptyBaseline(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.baselineEvents === 0;
  }

  append(sessionId: string, event: unknown): HubStreamCursor {
    const sequence = ++this.sequence;
    const log = this.sessions.get(sessionId);
    if (log && !log.truncated) {
      const serialized = JSON.stringify(event) ?? "null";
      const bytes = Buffer.byteLength(serialized);
      if (
        log.bytes + bytes > this.limits.maxBytes ||
        log.events.length >= this.limits.maxEvents ||
        this.totalBytes + bytes > (this.limits.maxTotalBytes ?? 64 * 1024 * 1024)
      ) {
        // Never silently present an arbitrary tail as a complete conversation.
        // The caller falls back to the full durable log and exposes this flag.
        log.truncated = true;
        log.events = [];
        this.totalBytes -= log.bytes;
        log.bytes = 0;
      } else {
        // Own the wire value. Later changes to the worker message object must
        // not change a previously captured stream or invalidate its byte limit.
        log.events.push({ sequence, event: JSON.parse(serialized) });
        log.bytes += bytes;
        this.totalBytes += bytes;
      }
    }
    return { epoch: this.epoch, sequence };
  }

  finish(sessionId: string, requestId: string): void {
    const log = this.sessions.get(sessionId);
    if (!log) return;
    log.requests.delete(requestId);
    if (!log.requests.size) {
      this.totalBytes -= log.bytes;
      this.sessions.delete(sessionId);
    }
  }

  snapshot<T>(sessionId: string, durableEvents: readonly T[]) {
    const log = this.sessions.get(sessionId);
    return {
      transcript:
        log && !log.truncated ? durableEvents.slice(0, log.baselineEvents) : durableEvents.slice(),
      streamCursor: { epoch: this.epoch, sequence: this.sequence },
      ...(log
        ? { liveStream: { events: structuredClone(log.events), truncated: log.truncated } }
        : {}),
    };
  }

  clear(): void {
    this.sessions.clear();
    this.totalBytes = 0;
  }
}
