import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../session/memory.js";
import { applyGlobalDreamPromotionGate } from "./global-dream-promotion.js";
import type { ExtractedMemory } from "./extract-memories.js";

function withBase<T>(fn: (baseDir: string) => T): T {
  const baseDir = mkdtempSync(join(tmpdir(), "cs-global-promotion-"));
  try {
    return fn(baseDir);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

const candidate: ExtractedMemory = {
  type: "feedback",
  scope: "global",
  name: "prefer-rg-before-grep",
  description: "Prefer rg before grep when searching code",
  content: "Use rg first for repository text search because it is fast and already standard.",
};

describe("global dream promotion gate", () => {
  it("keeps a single-project automatic global candidate as project dream evidence only", () => {
    withBase((baseDir) => {
      const projectDir = "/tmp/project-one";

      const result = applyGlobalDreamPromotionGate({
        baseDir,
        projectDir,
        candidate,
        userDirectGlobal: false,
      });

      expect(result.promoted).toBe(false);
      expect(result.evidenceCount).toBe(1);

      const projectDream = new MemoryManager({ baseDir, projectDir, scope: "dream" }).loadAll();
      expect(projectDream.map((m) => m.name)).toEqual(["prefer-rg-before-grep"]);
      expect(projectDream[0]!.promotionKey).toBe("prefer-rg-before-grep");
      expect(projectDream[0]!.originProjects).toEqual([projectDir]);
      expect(projectDream[0]!.evidenceCount).toBe(1);

      const globalDream = new MemoryManager({ baseDir, scope: "dream" }).loadAll();
      expect(globalDream).toHaveLength(0);
    });
  });

  it("promotes when the same promotionKey appears in two different project dreams", () => {
    withBase((baseDir) => {
      const projectA = "/tmp/project-a";
      const projectB = "/tmp/project-b";
      new MemoryManager({ baseDir, projectDir: projectA, scope: "dream" }).save(
        {
          name: "prefer-rg-before-grep",
          description: "Prefer rg before grep when searching code",
          type: "feedback",
          content: "Use rg first for code search.",
          origin: "auto",
          promotionKey: "prefer-rg-before-grep",
          originProjects: [projectA],
          evidenceCount: 1,
        },
        { forceOrigin: "auto" },
      );

      const result = applyGlobalDreamPromotionGate({
        baseDir,
        projectDir: projectB,
        candidate,
        userDirectGlobal: false,
      });

      expect(result.promoted).toBe(true);
      expect(result.evidenceCount).toBe(2);
      expect(result.originProjects.sort()).toEqual([projectA, projectB].sort());

      const globalDream = new MemoryManager({ baseDir, scope: "dream" }).loadAll();
      expect(globalDream).toHaveLength(1);
      expect(globalDream[0]!.name).toBe("prefer-rg-before-grep");
      expect(globalDream[0]!.promotionKey).toBe("prefer-rg-before-grep");
      expect(globalDream[0]!.originProjects?.sort()).toEqual([projectA, projectB].sort());
      expect(globalDream[0]!.evidenceCount).toBe(2);
      expect(globalDream[0]!.promotionReason).toContain("cross-project");
    });
  });

  it("allows a user-direct global preference to promote from one project", () => {
    withBase((baseDir) => {
      const projectDir = "/tmp/direct-project";

      const result = applyGlobalDreamPromotionGate({
        baseDir,
        projectDir,
        candidate: {
          ...candidate,
          name: "user-prefers-chinese",
          description: "User prefers Chinese replies",
          content:
            "The user explicitly asked to remember globally that replies should be in Chinese.",
        },
        userDirectGlobal: true,
      });

      expect(result.promoted).toBe(true);
      expect(result.evidenceCount).toBe(1);

      const globalDream = new MemoryManager({ baseDir, scope: "dream" }).loadAll();
      expect(globalDream).toHaveLength(1);
      expect(globalDream[0]!.promotionKey).toBe("user-prefers-chinese");
      expect(globalDream[0]!.originProjects).toEqual([projectDir]);
      expect(globalDream[0]!.promotionReason).toContain("user-direct");
    });
  });
});
