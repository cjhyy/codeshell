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
  ) => Promise<{ before: number; after: number }>;
  now: () => number;
  idleMs: number;
}

export interface PetDelegationClosure {
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
  constructor(private readonly options: PetSegmentControllerOptions) {}

  async onDelegationClosed(closure: PetDelegationClosure): Promise<void> {
    const segmentId = this.options.store.activeSegment()?.id ?? "unsegmented";
    await this.options.store.append(
      buildWorkMemoryEntry({
        segmentId,
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
    const now = this.options.now();
    const openNew = shouldStartNewSegment({
      lastInteractionAt: this.options.store.lastInteractionAt(),
      now,
      idleMs: this.options.idleMs,
    });
    if (!openNew) {
      await this.options.store.setLastInteractionAt(now);
      return undefined;
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
