import { describe, it, expect } from "bun:test";
import { filterByAge, type MemoryEntry } from "./memory.js";

function e(name: string, updatedAt?: number): MemoryEntry {
  return {
    name,
    description: "d",
    type: "project",
    content: "c",
    fileName: `${name}.md`,
    scope: "user",
    updatedAt,
  };
}

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("filterByAge (TODO 8.1)", () => {
  it("returns all entries when maxAge is undefined or non-positive", () => {
    const all = [e("a", NOW), e("b", NOW - 100 * DAY)];
    expect(filterByAge(all, undefined, NOW)).toHaveLength(2);
    expect(filterByAge(all, 0, NOW)).toHaveLength(2);
    expect(filterByAge(all, -5, NOW)).toHaveLength(2);
  });

  it("drops entries older than maxAge days", () => {
    const all = [e("recent", NOW - 2 * DAY), e("old", NOW - 40 * DAY)];
    const kept = filterByAge(all, 30, NOW).map((x) => x.name);
    expect(kept).toEqual(["recent"]);
  });

  it("keeps an entry exactly at the cutoff", () => {
    const all = [e("edge", NOW - 30 * DAY)];
    expect(filterByAge(all, 30, NOW)).toHaveLength(1);
  });

  it("keeps entries with unknown mtime (never hide due to missing timestamp)", () => {
    const all = [e("notime", 0), e("undef", undefined)];
    expect(filterByAge(all, 1, NOW)).toHaveLength(2);
  });
});
