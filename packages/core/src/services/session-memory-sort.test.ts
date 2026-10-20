import { describe, test, expect } from "bun:test";
import { sortSessionMemoriesByRecency } from "./session-memory-sort.js";
import type { SessionMemoryEntry } from "./session-memory.js";

// Regression: listSessionMemories sorted by FILENAME (= sessionId), which has
// no chronological relation to createdAt, so "most recent first" was wrong
// (review-2026-05-30). Sort by createdAt descending instead.

function entry(sessionId: string, createdAt: string): SessionMemoryEntry {
  return { sessionId, summary: "", keyTopics: [], decisions: [], createdAt };
}

describe("sortSessionMemoriesByRecency", () => {
  test("orders by createdAt descending, regardless of sessionId order", () => {
    const a = entry("zzz-old", "2026-01-01T00:00:00Z"); // high sessionId, old
    const b = entry("aaa-new", "2026-05-30T00:00:00Z"); // low sessionId, new
    const out = sortSessionMemoriesByRecency([a, b]);
    expect(out.map((e) => e.sessionId)).toEqual(["aaa-new", "zzz-old"]);
  });

  test("compares the instants of timestamps with different UTC offsets", () => {
    const older = entry("older", "2026-10-17T01:00:00+08:00"); // 2026-10-16T17:00Z
    const newer = entry("newer", "2026-10-16T23:00:00Z");
    const out = sortSessionMemoriesByRecency([older, newer]);
    expect(out.map((e) => e.sessionId)).toEqual(["newer", "older"]);
  });

  test("does not mutate the input array", () => {
    const arr = [entry("a", "2026-01-01T00:00:00Z"), entry("b", "2026-02-01T00:00:00Z")];
    const copy = [...arr];
    sortSessionMemoriesByRecency(arr);
    expect(arr).toEqual(copy);
  });
});
