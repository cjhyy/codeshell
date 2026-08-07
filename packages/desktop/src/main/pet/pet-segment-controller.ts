import { randomUUID } from "node:crypto";
import {
  buildCarryoverBrief,
  buildWorkMemoryEntry,
  shouldStartNewSegment,
  type PetTopicSegment,
  type PetWorkMemoryEntry,
} from "@cjhyy/code-shell-pet";

/** The slice of PetWorkMemoryStore the controller depends on (eases faking). */
export interface PetWorkMemoryStoreLike {
  entries(): PetWorkMemoryEntry[];
  activeSegment(): PetTopicSegment | undefined;
  segmentBoundaries(): { boundaryBeforeMessageId: string; brief?: string }[];
  lastInteractionAt(): number;
  append(entry: PetWorkMemoryEntry): Promise<void>;
  openSegment(segment: PetTopicSegment): Promise<void>;
  setLastInteractionAt(at: number): Promise<void>;
}

export interface PetSegmentControllerOptions {
  store: PetWorkMemoryStoreLike;
  /** The Mimi main-conversation engine session id (target of range archival). */
  petSessionId: string;
  /**
   * Range-archival seam onto the generic core primitive (engine.archiveTurnRange
   * via the archive_range worker query). Only invoked when a caller supplies a
   * concrete turn range — see onDelegationClosed.
   */
  archiveRange: (
    sessionId: string,
    range: { start: number; end: number },
    anchors?: PetArchiveAnchors,
  ) => Promise<{ before: number; after: number }>;
  /**
   * Optional closure sink: invoked (fire-and-forget) when a long-idle boundary
   * closes a segment, before the new one is opened. Receives the just-closed
   * segment plus the newly-opened segment's first-turn client message id so the
   * host can locate the closed window in the transcript. Distilling the journal
   * entry + auto-memories and archiving the range is the sink's responsibility.
   */
  onSegmentClosed?: (closed: PetSegmentClosed) => void;
  now: () => number;
  idleMs: number;
}

export interface PetSegmentClosed {
  segmentId: string;
  closingBoundaryMessageId?: string;
  nextBoundaryMessageId?: string;
  startedAt: number;
  endedAt: number;
}

/** Anchors forwarded to the archive_range worker query for a persisted marker. */
export interface PetArchiveAnchors {
  toClientMessageId: string;
  fromClientMessageId?: string;
  segmentId?: string;
}

/**
 * Derive the archive-marker anchors from a just-closed segment. Anchors are
 * only meaningful when the newly-opened segment captured a first-turn client
 * message id (`nextBoundaryMessageId`) — that id is the marker's "to" cursor.
 * Without it there is nothing locatable to anchor and the caller must degrade
 * to an in-memory-only archive (undefined anchors, same as pre-anchors
 * behavior).
 */
export function buildArchiveAnchors(closed: PetSegmentClosed): PetArchiveAnchors | undefined {
  if (!closed.nextBoundaryMessageId) return undefined;
  return {
    toClientMessageId: closed.nextBoundaryMessageId,
    ...(closed.closingBoundaryMessageId
      ? { fromClientMessageId: closed.closingBoundaryMessageId }
      : {}),
    segmentId: closed.segmentId,
  };
}

export interface PetDelegationClosure {
  /** Stable across crash replay; the work-memory store suppresses duplicates. */
  dedupeKey?: string;
  objective: string;
  outcome: PetWorkMemoryEntry["outcome"];
  workspace?: string;
  sessionRef?: string;
  /**
   * Optional contiguous transcript index window of the Mimi main conversation
   * to collapse into a summary. Deliberately left unset by the current dispatch
   * wiring: the chat return carries no reliable turn cursor, and guessing a
   * window would mis-trim live context. When absent, the closure only records
   * work memory — the archival capability stays available but dormant.
   */
  turnRange?: { start: number; end: number };
}

/**
 * Connects the pure topic-segment primitives (packages/pet) to the real main
 * process effects: persistent work memory + the generic range-archival seam.
 *
 * - onDelegationClosed: a delegated Work Session finished → distill one
 *   work-memory entry; if (and only if) a concrete turnRange was supplied,
 *   collapse those turns of the Mimi conversation via archiveRange.
 * - beginTurn: called before each Mimi chat turn. If the idle gap since the
 *   last interaction crosses idleMs, open a fresh segment and return a carryover
 *   brief (open tasks + recent conclusions) for injection; otherwise return
 *   undefined. Either way the interaction clock advances.
 */
export class PetSegmentController {
  /**
   * Serializes beginTurn so its read-decide-write of lastInteractionAt is
   * atomic. Two chat entry points (desktop IPC + IM gateway) hit the same pet
   * session; without this, concurrent turns both read the old lastInteractionAt,
   * both decide to open a new segment, and both fire onSegmentClosed → the same
   * transcript range gets archived twice (the second archive uses now-shifted
   * absolute indices and removes the wrong turns).
   */
  private beginTurnQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PetSegmentControllerOptions) {}

  async onDelegationClosed(closure: PetDelegationClosure): Promise<void> {
    const segmentId = this.options.store.activeSegment()?.id ?? "unsegmented";
    await this.options.store.append(
      buildWorkMemoryEntry({
        segmentId,
        ...(closure.dedupeKey ? { dedupeKey: closure.dedupeKey } : {}),
        objective: closure.objective,
        outcome: closure.outcome,
        ...(closure.workspace ? { workspace: closure.workspace } : {}),
        ...(closure.sessionRef ? { sessionRef: closure.sessionRef } : {}),
        at: this.options.now(),
      }),
    );
    if (closure.turnRange) {
      await this.options.archiveRange(this.options.petSessionId, closure.turnRange);
    }
  }

  /**
   * Called before each Mimi chat turn. `clientMessageId` is the cross-process
   * id of the turn being sent — the only turn identity main can observe (the
   * renderer-local Message.id is invisible here). When a long-idle boundary is
   * crossed we open a fresh segment keyed to that id so the chat UI can render a
   * divider (+ optional brief card) immediately before the turn.
   */
  async beginTurn(clientMessageId?: string): Promise<string | undefined> {
    // Chain on the queue so overlapping turns run one-at-a-time. A failure in
    // one turn must not poison the chain, so swallow the tail's rejection.
    const run = this.beginTurnQueue
      .catch(() => undefined)
      .then(() => this.runBeginTurn(clientMessageId));
    this.beginTurnQueue = run.catch(() => undefined);
    return run;
  }

  private async runBeginTurn(clientMessageId?: string): Promise<string | undefined> {
    const now = this.options.now();
    const lastInteractionAt = this.options.store.lastInteractionAt();
    // The very first interaction has no preceding segment to close, so it only
    // establishes the interaction baseline — never a visible boundary. Without
    // this guard `shouldStartNewSegment(0, now, idleMs)` is always true and the
    // user's first message would render a bare "new topic" divider (with no
    // brief, since work memory is still empty). Only a *later* turn that crosses
    // the idle gap opens a visible new segment.
    const isFirstInteraction = lastInteractionAt === 0;
    const openNew =
      !isFirstInteraction &&
      shouldStartNewSegment({ lastInteractionAt, now, idleMs: this.options.idleMs });
    if (!openNew) {
      await this.options.store.setLastInteractionAt(now);
      return undefined;
    }
    // Capture the segment that is about to close before we append the new one.
    // Only a segment that actually captured a first-turn message id yields a
    // locatable transcript window; a legacy/time-only segment closes silently.
    const closing = this.options.store.activeSegment();
    if (closing && this.options.onSegmentClosed) {
      this.options.onSegmentClosed({
        segmentId: closing.id,
        ...(closing.boundaryBeforeMessageId
          ? { closingBoundaryMessageId: closing.boundaryBeforeMessageId }
          : {}),
        ...(clientMessageId ? { nextBoundaryMessageId: clientMessageId } : {}),
        startedAt: closing.startedAt,
        endedAt: now,
      });
    }
    const brief = this.buildBrief();
    const briefText = brief.length > 0 ? brief : undefined;
    await this.options.store.openSegment({
      id: `seg-${randomUUID()}`,
      startedAt: now,
      ...(clientMessageId ? { boundaryBeforeMessageId: clientMessageId } : {}),
      ...(briefText ? { brief: briefText } : {}),
    });
    await this.options.store.setLastInteractionAt(now);
    return briefText;
  }

  /** Message-keyed topic-segment boundaries for the Mimi chat UI (oldest → newest). */
  segmentBoundaries(): { boundaryBeforeMessageId: string; brief?: string }[] {
    return this.options.store.segmentBoundaries();
  }

  /** Distill open tasks + recent conclusions from stored work memory. */
  private buildBrief(): string {
    const entries = this.options.store.entries();
    const unfinished = entries
      .filter((entry) => entry.outcome === "failed" || entry.outcome === "pending-decided")
      .slice(-8)
      .map((entry) => ({
        objective: entry.objective,
        ...(entry.workspace ? { workspace: entry.workspace } : {}),
      }));
    const conclusions = entries
      .filter((entry) => entry.outcome === "completed")
      .slice(-8)
      .map((entry) => entry.objective);
    return buildCarryoverBrief({ unfinished, conclusions });
  }
}
