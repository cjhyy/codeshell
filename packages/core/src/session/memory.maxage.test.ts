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

describe("pinned + origin (feedback#18 方案 A+C)", () => {
  it("pinned entries are exempt from maxAge filtering", () => {
    const old = { ...e("old-pinned", NOW - 100 * DAY), pinned: true };
    const all = [e("recent", NOW - 1 * DAY), old, e("old-unpinned", NOW - 100 * DAY)];
    const kept = filterByAge(all, 30, NOW).map((x) => x.name);
    expect(kept).toEqual(["recent", "old-pinned"]);
  });
});

describe("pinned/origin frontmatter roundtrip + injection order", () => {
  it("save → loadAll roundtrips pinned and origin; injection sorts pinned first", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { MemoryManager } = await import("./memory.js");
    const base = mkdtempSync(join(tmpdir(), "cs-mem-pin-"));
    try {
      const mm = new MemoryManager({ baseDir: base });
      mm.save({ name: "plain", description: "d1", type: "project", content: "c" });
      mm.save({ name: "auto-noise", description: "d2", type: "project", content: "c", origin: "auto" });
      mm.save({ name: "keeper", description: "d3", type: "user", content: "c", pinned: true, origin: "manual" });

      const byName = new Map(mm.loadAll().map((x) => [x.name, x]));
      expect(byName.get("plain")!.pinned).toBe(false);
      expect(byName.get("plain")!.origin).toBeUndefined();
      expect(byName.get("auto-noise")!.origin).toBe("auto");
      expect(byName.get("keeper")!.pinned).toBe(true);
      expect(byName.get("keeper")!.origin).toBe("manual");

      const ctx = mm.buildMemoryContext();
      const lines = ctx.split("\n").filter((l) => l.startsWith("- "));
      expect(lines[0]).toContain("[pinned]");
      expect(lines[0]).toContain("keeper");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
