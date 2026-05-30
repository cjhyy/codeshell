import type { SessionMemoryEntry } from "./session-memory.js";

/**
 * Order session memories most-recent-first by their `createdAt` field. The
 * caller previously sorted by filename (= sessionId), which has no
 * chronological meaning (review-2026-05-30). Returns a new array; input is not
 * mutated.
 */
export function sortSessionMemoriesByRecency(
  entries: SessionMemoryEntry[],
): SessionMemoryEntry[] {
  return [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
