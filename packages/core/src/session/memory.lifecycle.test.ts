import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("lifecycle frontmatter (createdAt/lastUsedAt/useCount/updateCount)", () => {
  it("save writes stable id and new lifecycle fields", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      const t0 = new Date("2026-06-01T00:00:00.000Z");
      const fileName = mm.save({
        name: "a",
        description: "d",
        type: "project",
        content: "c",
        createdAt: t0.toISOString(),
        lastUsedAt: t0.toISOString(),
      });
      const e = mm.loadAll().find((x) => x.name === "a")!;
      expect(e.id).toBeString();
      expect(fileName).toBe(`${e.id}.md`);
      expect(e.createdAt).toBe(t0.toISOString());
      expect(e.lastUsedAt).toBe(t0.toISOString());
      expect(e.useCount).toBe(0);
      expect(e.updateCount).toBe(0);
      expect(e.origin).toBe("manual");
      const raw = readdirSync(join(base, "memory", "user")).filter((f) => f.endsWith(".md"));
      expect(raw).toContain(`${e.id}.md`);
    });
  });

  it("updates by id, allows renaming without a new file, and increments updateCount only for content changes", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      const createdAt = "2026-06-01T00:00:00.000Z";
      const firstFile = mm.save({
        name: "a-2026-07-08",
        description: "d1",
        type: "project",
        content: "c1",
        createdAt,
        useCount: 5,
      });
      const first = mm.loadAll().find((x) => x.name === "a-2026-07-08")!;

      const secondFile = mm.save({
        id: first.id,
        name: "a-2026-07-09",
        description: "d2",
        type: "project",
        content: "c2",
      });

      expect(secondFile).toBe(firstFile);
      const entries = mm.loadAll();
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.id).toBe(first.id);
      expect(e.fileName).toBe(firstFile);
      expect(e.name).toBe("a-2026-07-09");
      expect(e.createdAt).toBe(createdAt);
      expect(e.useCount).toBe(5);
      expect(e.updateCount).toBe(1);
      expect(e.description).toBe("d2");

      mm.save({
        id: e.id,
        name: e.name,
        description: e.description,
        type: e.type,
        content: e.content,
        pinned: true,
      });
      const pinned = mm.loadAll()[0]!;
      expect(pinned.pinned).toBe(true);
      expect(pinned.updateCount).toBe(1);
    });
  });

  it("legacy lifecycle fields read as useCount/createdAt/lastUsedAt and missing origin is manual", () => {
    withBase((base) => {
      const dir = join(base, "memory", "user");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "legacy.md"),
        [
          "---",
          "name: legacy",
          "description: old",
          "type: project",
          "created: 2026-06-01T00:00:00.000Z",
          "lastUsed: 2026-06-02T00:00:00.000Z",
          "usageCount: 7",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
        "utf-8",
      );
      const mm = new MemoryManager({ baseDir: base });
      const e = mm.loadAll().find((x) => x.name === "legacy")!;
      expect(e.id).toBe("legacy:user:legacy.md");
      expect(e.origin).toBe("manual");
      expect(e.useCount).toBe(7);
      expect(e.usageCount).toBe(7);
      expect(e.createdAt).toBe("2026-06-01T00:00:00.000Z");
      expect(e.created).toBe("2026-06-01T00:00:00.000Z");
      expect(e.lastUsedAt).toBe("2026-06-02T00:00:00.000Z");
      expect(e.lastUsed).toBe("2026-06-02T00:00:00.000Z");
      expect(e.updateCount).toBe(0);
    });
  });

  it("legacy file without lifecycle fields reads back with zero counts and timestamp fallbacks", () => {
    withBase((base) => {
      const dir = join(base, "memory", "user");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "legacy.md"),
        `---\nname: legacy\ndescription: old\ntype: project\n---\n\nbody\n`,
        "utf-8",
      );
      const mm = new MemoryManager({ baseDir: base });
      const e = mm.loadAll().find((x) => x.name === "legacy")!;
      expect(e.useCount).toBe(0);
      expect(e.createdAt).toBeDefined(); // falls back to mtime, never undefined-crashes
    });
  });
});

describe("recordRecall", () => {
  it("bumps useCount and lastUsedAt without touching content or updateCount", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      mm.save({ name: "a", description: "d", type: "project", content: "keep-me" });
      const before = mm.loadAll().find((x) => x.name === "a")!;
      const now = new Date("2026-06-25T12:00:00.000Z");
      expect(mm.recordRecall("a", now)).toBe(true);
      const e = mm.loadAll().find((x) => x.name === "a")!;
      expect(e.id).toBe(before.id);
      expect(e.useCount).toBe(1);
      expect(e.usageCount).toBe(1);
      expect(e.lastUsedAt).toBe(now.toISOString());
      expect(e.content).toBe("keep-me");
      expect(e.updateCount).toBe(0);
      // second recall accumulates
      mm.recordRecall("a", now);
      const afterSecond = mm.loadAll().find((x) => x.name === "a")!;
      expect(afterSecond.useCount).toBe(2);
      expect(afterSecond.updateCount).toBe(0);
      expect(existsSync(join(base, "memory", "user", before.fileName))).toBe(true);
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
      mm.save({
        name: "stale-project",
        description: "d",
        type: "project",
        content: "c",
        lastUsed: old,
      });
      mm.save({
        name: "fresh-project",
        description: "d",
        type: "project",
        content: "c",
        lastUsed: recent,
      });
      mm.save({ name: "old-user", description: "d", type: "user", content: "c", lastUsed: old }); // stable type exempt
      mm.save({
        name: "old-pinned",
        description: "d",
        type: "project",
        content: "c",
        lastUsed: old,
        pinned: true,
      }); // pinned exempt

      const pruned = mm.pruneByRecall(30, now);
      expect(pruned).toEqual(["stale-project"]);
      const names = mm
        .loadAll()
        .map((x) => x.name)
        .sort();
      expect(names).toEqual(["fresh-project", "old-pinned", "old-user"]);
    });
  });

  it("ttlDays<=0 disables the sweep", () => {
    withBase((base) => {
      const mm = new MemoryManager({ baseDir: base });
      mm.save({
        name: "x",
        description: "d",
        type: "project",
        content: "c",
        lastUsed: "2000-01-01T00:00:00.000Z",
      });
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

describe("pending 审批门 三态 + originProject", () => {
  it("approve moves pending → global user store", () => {
    withBase((base) => {
      const pend = new MemoryManager({ baseDir: base, scope: "pending" });
      pend.save({ name: "g", description: "d", type: "feedback", content: "c", origin: "auto" });
      expect(pend.approvePending("g")).toBeTruthy();
      expect(pend.loadAll().map((e) => e.name)).not.toContain("g");
      const global = new MemoryManager({ baseDir: base, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(global).toContain("g");
    });
  });

  it("demote moves pending → its originProject's user store, not global", () => {
    withBase((base) => {
      const projectDir = "/tmp/demote-origin-proj";
      const pend = new MemoryManager({ baseDir: base, scope: "pending" });
      pend.save({
        name: "d1",
        description: "d",
        type: "project",
        content: "c",
        origin: "auto",
        originProject: projectDir,
      });
      expect(pend.demotePending("d1")).toBeTruthy();
      const proj = new MemoryManager({ baseDir: base, projectDir, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(proj).toContain("d1");
      const global = new MemoryManager({ baseDir: base, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(global).not.toContain("d1");
    });
  });

  it("demote with no originProject falls back to global (never loses the memory)", () => {
    withBase((base) => {
      const pend = new MemoryManager({ baseDir: base, scope: "pending" });
      pend.save({
        name: "orphan",
        description: "d",
        type: "project",
        content: "c",
        origin: "auto",
      });
      expect(pend.demotePending("orphan")).toBeTruthy();
      const global = new MemoryManager({ baseDir: base, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(global).toContain("orphan");
    });
  });

  it("promoteToGlobal moves a project user memory → global, removing the project copy", () => {
    withBase((base) => {
      const projectDir = "/tmp/promote-proj";
      const proj = new MemoryManager({ baseDir: base, projectDir, scope: "user" });
      proj.save({ name: "lesson", description: "d", type: "feedback", content: "c" });
      expect(proj.promoteToGlobal("lesson")).toBeTruthy();
      expect(proj.loadAll().map((e) => e.name)).not.toContain("lesson");
      const global = new MemoryManager({ baseDir: base, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(global).toContain("lesson");
    });
  });

  it("originProject roundtrips through frontmatter; origin not confused with originProject", () => {
    withBase((base) => {
      const pend = new MemoryManager({ baseDir: base, scope: "pending" });
      pend.save({
        name: "rt",
        description: "d",
        type: "project",
        content: "c",
        origin: "auto",
        originProject: "/some/proj",
      });
      const e = pend.loadAll().find((x) => x.name === "rt")!;
      expect(e.origin).toBe("auto");
      expect(e.originProject).toBe("/some/proj");
    });
  });
});

describe("buildInjectionIndex (two-layer, global + project)", () => {
  it("merges global and project memories and shows NO body content", () => {
    withBase((base) => {
      const globalMm = new MemoryManager({ baseDir: base });
      globalMm.save({
        name: "grep-first",
        description: "grep before dead-code",
        type: "feedback",
        content: "SECRET-BODY-GLOBAL",
      });

      const projDir = "/tmp/some/project";
      const projMm = new MemoryManager({ baseDir: base, projectDir: projDir });
      projMm.save({
        name: "uses-worktree",
        description: "this repo uses worktrees",
        type: "project",
        content: "SECRET-BODY-PROJECT",
      });

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
