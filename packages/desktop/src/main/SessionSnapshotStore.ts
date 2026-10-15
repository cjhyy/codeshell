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
 * so eviction can't cause a cursor collision within one Main lifetime.
 * The epoch separates those counters from persisted cursors after a restart.
 */

import { randomUUID } from "node:crypto";
import type { SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import { OutputCoverage } from "./output-coverage.js";
import { compareOutputCursors } from "@cjhyy/code-shell-web";
import {
  reduceTopLevelRunLifecycle,
  type TopLevelRunLifecycle,
} from "../shared/top-level-run-lifecycle.js";

/** One snapshot entry: the forwarded event plus its assigned sequence. */
export interface SnapshotEntry {
  seq: number;
  event: unknown;
}

export interface Snapshot {
  /** Identifies the Main-process lifetime in which sequence numbers are valid. */
  epoch: string;
  events: SnapshotEntry[];
  /** The seq the next appended event will receive (cursor for the client). */
  nextSeq: number;
  /** Authoritative top-level run state, retained independently of event eviction. */
  topLevelRunning: boolean;
  /** Latest Core cursor, retained even when a large event is evicted. */
  outputCursor?: string;
  outputUnpaired?: boolean;
  outputInputIds?: string[];
  outputCoverageIdentity?: string;
  outputJournalIdentity?: string;
}

interface SessionLog {
  events: SnapshotEntry[];
  /** Next seq to assign — keeps climbing across eviction, never reused. */
  nextSeq: number;
  /** Current top-level run state from the complete worker event stream. */
  topLevelRun: TopLevelRunLifecycle;
  bytes: number;
  outputCursor?: string;
  coverage: OutputCoverage;
  persistedBlocked?: boolean;
  publicationFailed?: boolean;
}

const DEFAULT_MAX_PER_SESSION = 2000;

export class SessionSnapshotStore {
  readonly epoch = randomUUID();
  private readonly logs = new Map<string, SessionLog>();
  private readonly maxPerSession: number;
  private readonly maxBytesPerSession: number;
  private readonly maxTotalBytes: number;
  private totalBytes = 0;
  private coverageBytes = 0;
  private readonly sizes = new WeakMap<SnapshotEntry, number>();

  private readonly persistence?: SessionOutputCoverageStore;

  constructor(opts?: {
    coverage?: SessionOutputCoverageStore;
    maxPerSession?: number;
    maxBytesPerSession?: number;
    maxTotalBytes?: number;
  }) {
    this.persistence = opts?.coverage;
    this.maxPerSession = opts?.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.maxBytesPerSession = opts?.maxBytesPerSession ?? 8 * 1024 * 1024;
    this.maxTotalBytes = opts?.maxTotalBytes ?? 64 * 1024 * 1024;
  }

  /** Record a forwarded event for a session, assigning it the next seq. */
  append(sessionId: string, event: unknown): SnapshotEntry {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = {
        events: [],
        nextSeq: 1,
        topLevelRun: { running: false },
        bytes: 0,
        coverage: new OutputCoverage(),
      };
      this.logs.set(sessionId, log);
    }
    this.coverageBytes -= log.coverage.memoryBytes;
    const previousCoverage = log.coverage;
    log.coverage = previousCoverage.copy();
    log.coverage.observe(event);
    if (this.coverageBytes + log.coverage.memoryBytes > 4 * 1024 * 1024)
      log.coverage.discardProof();
    if (
      this.persistence &&
      ((log.coverage.incomplete && !log.persistedBlocked) || log.coverage.inputIds.length)
    ) {
      let withheldBeforeSession = false;
      try {
        const proof = this.persistence.record(sessionId, {
          unpaired: log.coverage.incomplete,
          inputIds: log.coverage.inputIds,
        });
        if (!proof.incarnation) {
          withheldBeforeSession = proof.status === "unavailable";
          throw new Error("Session output coverage is unavailable before publication");
        }
        if (proof.incarnation) {
          log.coverage.acknowledgeInputs(log.coverage.inputIds);
          log.persistedBlocked = proof.unpaired;
        }
      } catch (cause) {
        // A not-yet-created Session had no publication or uncertain write. A
        // real persistence/identity failure still keeps its per-Host barrier.
        log.coverage = previousCoverage;
        if (!withheldBeforeSession) log.publicationFailed = true;
        this.coverageBytes += log.coverage.memoryBytes;
        throw cause;
      }
    }
    this.coverageBytes += log.coverage.memoryBytes;
    const lifecycle = event as { type?: unknown; agentId?: unknown; outputCursor?: unknown } | null;
    const outputCursor =
      typeof lifecycle?.outputCursor === "string" && lifecycle.outputCursor.length <= 2048
        ? lifecycle.outputCursor
        : undefined;
    const cursorOrder =
      outputCursor && log.outputCursor
        ? compareOutputCursors(outputCursor, log.outputCursor)
        : undefined;
    const historicalCursor = cursorOrder !== undefined && cursorOrder <= 0;
    if (outputCursor && !historicalCursor) log.outputCursor = outputCursor;
    if (!historicalCursor) log.topLevelRun = reduceTopLevelRunLifecycle(log.topLevelRun, event);
    const entry = { seq: log.nextSeq, event };
    log.nextSeq += 1;
    const serialized = JSON.stringify(event) ?? "null";
    const bytes = Buffer.byteLength(serialized);
    if (bytes > Math.min(this.maxBytesPerSession, this.maxTotalBytes)) {
      // Keep a contiguous retained suffix. A skipped large frame must never
      // leave a misleading sequence-1 prefix followed by an internal hole.
      while (log.events.length) this.evict(log);
    } else {
      const cached = { ...entry, event: JSON.parse(serialized) };
      this.sizes.set(cached, bytes);
      log.events.push(cached);
      log.bytes += bytes;
      this.totalBytes += bytes;
      while (log.events.length > this.maxPerSession || log.bytes > this.maxBytesPerSession)
        this.evict(log);
      while (this.totalBytes > this.maxTotalBytes) {
        const oldest = [...this.logs.values()].find((candidate) => candidate.events.length);
        if (!oldest) break;
        this.evict(oldest);
      }
    }
    return entry;
  }

  /**
   * Snapshot for a session. With `sinceSeq`, returns only entries with a
   * strictly-greater seq (the increment the client is missing).
   */
  get(sessionId: string, sinceSeq = 0): Snapshot {
    const proof = this.persistence?.read(sessionId);
    const coverage = {
      ...(proof?.unpaired ? { outputUnpaired: true } : {}),
      ...(proof?.inputIds.length ? { outputInputIds: proof.inputIds } : {}),
      ...(proof?.incarnation ? { outputCoverageIdentity: proof.incarnation } : {}),
      ...(proof?.journalIdentity ? { outputJournalIdentity: proof.journalIdentity } : {}),
    };
    const log = this.logs.get(sessionId);
    if (!log)
      return { epoch: this.epoch, events: [], nextSeq: 1, topLevelRunning: false, ...coverage };
    const events = sinceSeq > 0 ? log.events.filter((e) => e.seq > sinceSeq) : log.events.slice();
    return {
      epoch: this.epoch,
      events,
      nextSeq: log.nextSeq,
      topLevelRunning: log.topLevelRun.running,
      ...(log.outputCursor ? { outputCursor: log.outputCursor } : {}),
      ...coverage,
      ...(log.coverage.incomplete || log.publicationFailed || proof?.unpaired
        ? { outputUnpaired: true }
        : {}),
      ...([...(proof?.inputIds ?? []), ...log.coverage.inputIds].length
        ? { outputInputIds: [...new Set([...(proof?.inputIds ?? []), ...log.coverage.inputIds])] }
        : {}),
    };
  }

  /**
   * A worker exited. Retain replay events, but mark only sessions owned by
   * that worker idle. Other producers (for example in-main automation) share
   * this store and must keep their independent run state.
   */
  onWorkerExit(ownedSessionIds: Iterable<string>): void {
    for (const sessionId of ownedSessionIds) {
      const log = this.logs.get(sessionId);
      if (log) log.topLevelRun = { ...log.topLevelRun, running: false };
    }
  }

  /** Drop a single session's snapshot (e.g. when the session is deleted). */
  forget(sessionId: string): void {
    this.persistence?.forget(sessionId);
    this.totalBytes -= this.logs.get(sessionId)?.bytes ?? 0;
    this.coverageBytes -= this.logs.get(sessionId)?.coverage.memoryBytes ?? 0;
    this.logs.delete(sessionId);
  }

  private evict(log: SessionLog): void {
    const entry = log.events.shift();
    if (!entry) return;
    const bytes = this.sizes.get(entry) ?? 0;
    log.bytes -= bytes;
    this.totalBytes -= bytes;
  }
}
