import {
  closeSync,
  openSync,
  readSync,
  statSync,
  unwatchFile,
  watchFile,
  type Stats,
} from "node:fs";
import { basename } from "node:path";
import type {
  RecentExternalSession,
  SessionTailEvent,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import {
  decayExternalActivity,
  reduceExternalTail,
  seedExternalActivity,
  type ExternalSessionActivity,
} from "./external-session-state.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

export type ExternalCli = "codex" | "claude";

export interface ExternalPetSessionSink {
  upsertExternalSession(session: DesktopPetSession): void;
  removeExternalSession(agentSessionId: string): void;
}

export interface ExternalSessionAdapterOptions {
  cli: ExternalCli;
  parseLine: (line: string) => SessionTailEvent[];
  sink: ExternalPetSessionSink;
  discover: () => RecentExternalSession[];
  /** Filter before a discovered record is registered or tailed. */
  includeSession?: (session: RecentExternalSession) => boolean;
  scanIntervalMs?: number;
  liveWindowMs?: number;
  quietMs?: number;
  tailPollMs?: number;
  now?: () => number;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

interface WatchedSession {
  meta: RecentExternalSession;
  offset: number;
  carry: Buffer;
  activity: ExternalSessionActivity;
  listener?: (curr: Stats, prev: Stats) => void;
  lastPublishedKey?: string;
}

const MAX_TITLE_LENGTH = 160;

function bounded(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

/** Read `[start, end)` fully, looping over short reads. Mirrors the Buffer path
 * in cc-room/transcript-subscriptions so multibyte chars/large lines survive. */
function readRange(file: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const fd = openSync(file, "r");
  let total = 0;
  try {
    while (total < length) {
      const read = readSync(fd, buffer, total, length - total, start + total);
      if (read === 0) break;
      total += read;
    }
  } finally {
    closeSync(fd);
  }
  return total === length ? buffer : buffer.subarray(0, total);
}

/**
 * Host-side adapter for one EXTERNAL coding CLI (Codex or Claude). Periodically
 * discovers recent sessions, tails live ones (same drain/carry pattern as
 * cc-room/transcript-subscriptions), reduces tail events to metadata-only
 * activity state, and feeds the PetStateAggregator. Carries no transcript
 * content, tool args/outputs, or file contents into the projection. CLI-neutral:
 * the caller injects `discover` + `parseLine`, so one class serves both CLIs.
 */
export class ExternalSessionAdapter {
  private readonly records = new Map<string, WatchedSession>();
  private readonly scanIntervalMs: number;
  private readonly liveWindowMs: number;
  private readonly quietMs: number;
  private readonly tailPollMs: number;
  private readonly now: () => number;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(private readonly options: ExternalSessionAdapterOptions) {
    this.scanIntervalMs = options.scanIntervalMs ?? 15_000;
    this.liveWindowMs = options.liveWindowMs ?? 30 * 60_000;
    this.quietMs = options.quietMs ?? 90_000;
    this.tailPollMs = options.tailPollMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    void this.scanOnce().catch((error) => this.options.onBackgroundError?.("scan", error));
    if (this.scanIntervalMs > 0) {
      this.scanTimer = setInterval(() => {
        if (this.scanning) return;
        void this.scanOnce().catch((error) => this.options.onBackgroundError?.("scan", error));
      }, this.scanIntervalMs);
      (this.scanTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const record of this.records.values()) this.unwatch(record);
    this.records.clear();
  }

  /** One discovery pass: reconcile the record set with what is on disk. */
  async scanOnce(): Promise<void> {
    // Guards against reentrancy if scanOnce ever gains an await.
    this.scanning = true;
    try {
      // Re-check records already being tailed before touching the discovery
      // source. A hot project-off write therefore detaches its watchers first,
      // even when another project keeps this CLI's adapter alive.
      if (this.options.includeSession) {
        for (const [sessionId, record] of this.records) {
          if (this.options.includeSession(record.meta)) continue;
          this.unwatch(record);
          this.records.delete(sessionId);
          this.options.sink.removeExternalSession(sessionId);
        }
      }
      const discovered = this.options.discover();
      const now = this.now();
      const seen = new Set<string>();
      for (const meta of discovered) {
        if (this.options.includeSession && !this.options.includeSession(meta)) continue;
        seen.add(meta.sessionId);
        let record = this.records.get(meta.sessionId);
        if (!record) {
          record = {
            meta,
            offset: this.safeSize(meta.file),
            carry: Buffer.alloc(0),
            activity: seedExternalActivity(meta.lastModified, now, this.quietMs),
          };
          this.records.set(meta.sessionId, record);
        } else if (record.meta.file !== meta.file) {
          this.unwatch(record);
          record.meta = meta;
          record.offset = this.safeSize(meta.file);
          record.carry = Buffer.alloc(0);
        } else {
          record.meta = meta;
        }
        const live = now - meta.lastModified <= this.liveWindowMs;
        if (live && !record.listener) this.watch(record);
        if (!live && record.listener) this.unwatch(record);
        record.activity = decayExternalActivity(record.activity, now, this.quietMs);
        this.publish(record);
      }
      for (const [sessionId, record] of this.records) {
        if (seen.has(sessionId)) continue;
        this.unwatch(record);
        this.records.delete(sessionId);
        this.options.sink.removeExternalSession(sessionId);
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Drain + decay every record once. Tests call this instead of watchFile timers. */
  pollOnce(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      this.drain(record);
      record.activity = decayExternalActivity(record.activity, now, this.quietMs);
      this.publish(record);
    }
  }

  private watch(record: WatchedSession): void {
    const listener = (curr: Stats): void => {
      if (curr.nlink === 0) {
        this.unwatch(record);
        return;
      }
      this.drain(record);
      this.publish(record);
    };
    record.listener = listener;
    watchFile(record.meta.file, { interval: this.tailPollMs, persistent: false }, listener);
  }

  private unwatch(record: WatchedSession): void {
    if (!record.listener) return;
    unwatchFile(record.meta.file, record.listener);
    record.listener = undefined;
  }

  private safeSize(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  private drain(record: WatchedSession): void {
    let size: number;
    try {
      size = statSync(record.meta.file).size;
    } catch {
      return;
    }
    if (size < record.offset) {
      // A rewrite/rotation is a new stream boundary; resync at current EOF.
      record.offset = size;
      record.carry = Buffer.alloc(0);
      return;
    }
    if (size === record.offset) return;

    let appended: Buffer;
    try {
      appended = readRange(record.meta.file, record.offset, size);
    } catch {
      return;
    }
    // Advance by bytes actually read, not the stat size: readRange may return a
    // short buffer, and any unread tail is picked up on the next drain.
    record.offset += appended.length;
    const data = record.carry.length > 0 ? Buffer.concat([record.carry, appended]) : appended;
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // No complete line yet (may be mid-multibyte-char); keep raw bytes.
      record.carry = data;
      return;
    }
    const complete = data.subarray(0, lastNewline).toString("utf-8");
    record.carry = Buffer.from(data.subarray(lastNewline + 1));
    const events = complete
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => this.options.parseLine(line));
    if (events.length === 0) return;
    record.activity = reduceExternalTail(record.activity, events, this.now());
  }

  private publish(record: WatchedSession): void {
    const session = this.toPetSession(record);
    const key = `${session.runState}|${session.phase ?? ""}|${session.summary ?? ""}|${session.lastActivityAt}`;
    if (record.lastPublishedKey === key) return;
    record.lastPublishedKey = key;
    this.options.sink.upsertExternalSession(session);
  }

  private toPetSession(record: WatchedSession): DesktopPetSession {
    const { meta, activity } = record;
    return {
      agentSessionId: meta.sessionId,
      title: meta.firstMessage ? bounded(meta.firstMessage, MAX_TITLE_LENGTH) : basename(meta.cwd),
      workspaceDisplayName: basename(meta.cwd),
      runState: activity.runState,
      ...(activity.phase ? { phase: activity.phase } : {}),
      ...(activity.phase === "tool" && activity.toolName
        ? { summary: `正在运行 ${activity.toolName}` }
        : {}),
      queueDepth: 0,
      lastActivityAt: Math.max(activity.lastEventAt, meta.lastModified),
      pendingDecisionCount: 0,
      external: { cli: this.options.cli, cwd: meta.cwd },
      freshness: { source: "external-tail", observedAt: this.now(), workerState: "active" },
    };
  }
}
