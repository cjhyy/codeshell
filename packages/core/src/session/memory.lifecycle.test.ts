import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory.js";

function withBase<T>(fn: (base: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), "cs-mem-life-"));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const DAY = 24 * 60 * 60 * 1000;

describe("lifecycle frontmatter (created/lastUsed/usageCount)", () => {
  it("save writes created/lastUsed/usageCount; first save sets created=now", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      const t0 = new Date("2026-06-01T00:00:00.000Z");
      mm.save({ name: "a", description: "d", type: "project", content: "c", created: t0.toISOString(), lastUsed: t0.toISOString() });
      const e = mm.loadAll().find((x) => x.name === "a")!;
      expect(e.created).toBe(t0.toISOString());
      expect(e.lastUsed).toBe(t0.toISOString());
      expect(e.usageCount).toBe(0);
    });
  });

  it("overwrite (UPDATE) preserves the original created and accumulated usageCount", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      const created = "2026-06-01T00:00:00.000Z";
      mm.save({ name: "a", description: "d1", type: "project", content: "c1", created, usageCount: 5 });
      // overwrite without passing created/usageCount → must be preserved
      mm.save({ name: "a", description: "d2", type: "project", content: "c2" });
      const e = mm.loadAll().find((x) => x.name === "a")!;
      expect(e.created).toBe(created);
      expect(e.usageCount).toBe(5);
      expect(e.description).toBe("d2"); // new content wins
    });
  });

  it("legacy file without lifecycle fields reads back with usageCount 0 and a created fallback", () => {
    withBase((base) => {
      const { writeFileSync, mkdirSync } = require("node:fs");
      const dir = join(base, "memory", "user");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "legacy.md"),
        `---\nname: legacy\ndescription: old\ntype: project\n---\n\nbody\n`,
        "utf-8",
      );
      const mm = new MemoryManager({ baseDir: base });
      const e = mm.loadAll().find((x) => x.name === "legacy")!;
      expect(e.usageCount).toBe(0);
      expect(e.created).toBeDefined(); // falls back to mtime, never undefined-crashes
    });
  });
});

describe("recordRecall", () => {
  it("bumps usageCount and updates lastUsed without touching content", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      mm.save({ name: "a", description: "d", type: "project", content: "keep-me" });
      const now = new Date("2026-06-25T12:00:00.000Z");
      expect(mm.recordRecall("a", now)).toBe(true);
      const e = mm.loadAll().find((x) => x.name === "a")!;
      expect(e.usageCount).toBe(1);
      expect(e.lastUsed).toBe(now.toISOString());
      expect(e.content).toBe("keep-me");
      // second recall accumulates
      mm.recordRecall("a", now);
      expect(mm.loadAll().find((x) => x.name === "a")!.usageCount).toBe(2);
    });
  });

  it("returns false for a missing entry, no throw", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      expect(mm.recordRecall("nope")).toBe(false);
    });
  });
});

describe("pruneByRecall (recall TTL)", () => {
  it("prunes only project-type entries not read within ttlDays", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      const now = new Date("2026-06-25T00:00:00.000Z");
      const old = new Date(now.getTime() - 40 * DAY).toISOString();
      const recent = new Date(now.getTime() - 2 * DAY).toISOString();
      mm.save({ name: "stale-project", description: "d", type: "project", content: "c", lastUsed: old });
      mm.save({ name: "fresh-project", description: "d", type: "project", content: "c", lastUsed: recent });
      mm.save({ name: "old-user", description: "d", type: "user", content: "c", lastUsed: old }); // stable type exempt
      mm.save({ name: "old-pinned", description: "d", type: "project", content: "c", lastUsed: old, pinned: true }); // pinned exempt

      const pruned = mm.pruneByRecall(30, now);
      expect(pruned).toEqual(["stale-project"]);
      const names = mm.loadAll().map((x) => x.name).sort();
      expect(names).toEqual(["fresh-project", "old-pinned", "old-user"]);
    });
  });

  it("ttlDays<=0 disables the sweep", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      mm.save({ name: "x", description: "d", type: "project", content: "c", lastUsed: "2000-01-01T00:00:00.000Z" });
      expect(mm.pruneByRecall(0)).toEqual([]);
      expect(mm.pruneByRecall(-5)).toEqual([]);
      expect(mm.loadAll()).toHaveLength(1);
    });
  });

  it("keeps an entry with unparseable lastUsed (never prune on missing data)", () => {
    withBase((base) => {
      const { writeFileSync, mkdirSync } = require("node:fs");
      const dir = join(base, "memory", "user");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "bad.md"),
        `---\nname: bad\ndescription: d\ntype: project\nlastUsed: not-a-date\nusageCount: 0\n---\n\nbody\n`,
        "utf-8",
      );
      const mm = new MemoryManager({ baseDir: base });
      // mtime is "now" so even with the bad lastUsed the created/mtime fallback keeps it;
      // explicit assertion: pruning a far cutoff must not drop it on unparseable data.
      const pruned = mm.pruneByRecall(0.0001, new Date());
      expect(pruned).not.toContain("bad");
    });
  });
});

describe("buildInjectionIndex (two-layer, global + project)", () => {
  it("merges global and project memories and shows NO body content", () => {
    withBase((base) => {
      const globalMm = new MemoryManager({ baseDir: base });
      globalMm.save({ name: "grep-first", description: "grep before dead-code", type: "feedback", content: "SECRET-BODY-GLOBAL" });

      const projDir = "/tmp/some/project";
      const projMm = new MemoryManager({ baseDir: base, projectDir: projDir });
      projMm.save({ name: "uses-worktree", description: "this repo uses worktrees", type: "project", content: "SECRET-BODY-PROJECT" });

      const idx = MemoryManager.buildInjectionIndex({ projectDir: projDir, baseDir: base });
      expect(idx).toContain("Global memories");
      expect(idx).toContain("grep-first");
      expect(idx).toContain("Project memories");
      expect(idx).toContain("uses-worktree");
      // bodies must NOT be inlined — that's the whole point of the two-layer design
      expect(idx).not.toContain("SECRET-BODY-GLOBAL");
      expect(idx).not.toContain("SECRET-BODY-PROJECT");
      // it should instruct the model to MemoryRead
      expect(idx).toContain("MemoryRead");
    });
  });

  it("with no projectDir, shows only global memories", () => {
    withBase((base) => {
      const globalMm = new MemoryManager({ baseDir: base });
      globalMm.save({ name: "g", description: "global lesson", type: "feedback", content: "x" });
      const idx = MemoryManager.buildInjectionIndex({ baseDir: base });
      expect(idx).toContain("Global memories");
      expect(idx).not.toContain("Project memories");
    });
  });

  it("returns empty string when there are no memories", () => {
    withBase((base) => {
      expect(MemoryManager.buildInjectionIndex({ projectDir: "/tmp/p", baseDir: base })).toBe("");
    });
  });
});
