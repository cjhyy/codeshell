/**
 * Pure primitives for Mimi topic segmentation.
 *
 * A "topic segment" is a stretch of Mimi conversation bounded by long idle
 * gaps. When a new segment begins we inject a carryover brief (open tasks +
 * recent conclusions) so continuity survives the boundary. Task closure
 * (a delegated Work Session finishing or a pending decision being resolved)
 * distills into a work-memory entry.
 *
 * Everything here is a pure function: time and inputs are injected so the logic
 * is unit-testable with no side effects. Storage and effects live in the main
 * process (PetSegmentController / PetWorkMemoryStore, Task 12).
 */

export interface PetWorkMemoryEntry {
  segmentId: string;
  objective: string;
  outcome: "completed" | "pending-decided" | "failed";
  workspace?: string;
  sessionRef?: string;
  at: number;
}

export interface PetTopicSegment {
  id: string;
  startedAt: number;
  /** Inclusive transcript event id where this segment begins, for range archival. */
  startEventId?: string;
  /**
   * Client message id of the first Mimi chat turn of this segment. This is the
   * stable, cross-process identity of the turn the divider renders before —
   * unlike the renderer-local Message.id, which main can never observe. Absent
   * for a legacy/time-only segment that opened with no chat turn to key on; such
   * a segment surfaces no UI boundary.
   */
  boundaryBeforeMessageId?: string;
  /** Carryover brief distilled from the segment that just closed (see buildCarryoverBrief). */
  brief?: string;
}

/** Long-idle boundary: a new segment starts on the first message after idleMs. */
export function shouldStartNewSegment(input: {
  lastInteractionAt: number;
  now: number;
  idleMs: number;
}): boolean {
  return input.now - input.lastInteractionAt >= input.idleMs;
}

/** Carryover injected at the head of a new segment: open tasks + recent outcomes. */
export function buildCarryoverBrief(input: {
  unfinished: readonly { objective: string; workspace?: string }[];
  conclusions: readonly string[];
}): string {
  const lines: string[] = [];
  if (input.unfinished.length > 0) {
    lines.push("未完成任务:");
    for (const t of input.unfinished) {
      lines.push(`- ${t.objective}${t.workspace ? `(${t.workspace})` : ""}`);
    }
  }
  if (input.conclusions.length > 0) {
    lines.push("最近结论:");
    for (const c of input.conclusions) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}

export function buildWorkMemoryEntry(input: PetWorkMemoryEntry): PetWorkMemoryEntry {
  return { ...input };
}

export const DEFAULT_SEGMENT_IDLE_MS = 12 * 60 * 60 * 1000;
