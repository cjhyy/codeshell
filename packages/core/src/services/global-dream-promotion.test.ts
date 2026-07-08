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
  it("keeps a global candidate as project dream evidence and creates a pending approval item", () => {
    withBase((baseDir) => {
      const projectDir = "/tmp/project-one";

      const result = applyGlobalDreamPromotionGate({
        baseDir,
        projectDir,
        candidate,
        userDirectGlobal: false,
      });

      expect(result.promoted).toBe(false);
      expect(result.pendingSuggested).toBe(true);
      expect(result.evidenceCount).toBe(1);

      const projectDream = new MemoryManager({ baseDir, projectDir, scope: "dream" }).loadAll();
      expect(projectDream.map((m) => m.name)).toEqual(["prefer-rg-before-grep"]);
      expect(projectDream[0]!.originProjects).toEqual([projectDir]);
      expect(projectDream[0]!.evidenceCount).toBe(1);
      expect(projectDream[0]!.promotionStatus).toBe("pending");

      const globalDream = new MemoryManager({ baseDir, scope: "dream" }).loadAll();
      expect(globalDream).toHaveLength(0);

      const pending = new MemoryManager({ baseDir, scope: "pending" }).loadAll();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.name).toBe("prefer-rg-before-grep");
      expect(pending[0]!.origin).toBe("dream");
      expect(pending[0]!.originProject).toBe(projectDir);
      expect(pending[0]!.promotionReason).toContain("suggested global dream");
    });
  });

  it("does not auto-promote even when a similar candidate exists in another project", () => {
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

      expect(result.promoted).toBe(false);
      expect(result.pendingSuggested).toBe(true);
      expect(result.evidenceCount).toBe(1);
      expect(result.originProjects).toEqual([projectB]);

      const globalDream = new MemoryManager({ baseDir, scope: "dream" }).loadAll();
      expect(globalDream).toHaveLength(0);

      const pending = new MemoryManager({ baseDir, scope: "pending" }).loadAll();
      expect(pending.map((m) => m.name)).toEqual(["prefer-rg-before-grep"]);
    });
  });

  it("turns a user-direct global preference into a pending approval item", () => {
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

      expect(result.promoted).toBe(false);
      expect(result.pendingSuggested).toBe(true);
      expect(result.evidenceCount).toBe(1);

      const globalDream = new MemoryManager({ baseDir, scope: "dream" }).loadAll();
      expect(globalDream).toHaveLength(0);

      const pending = new MemoryManager({ baseDir, scope: "pending" }).loadAll();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.name).toBe("user-prefers-chinese");
      expect(pending[0]!.originProjects).toEqual([projectDir]);
      expect(pending[0]!.promotionReason).toContain("user-direct");
      expect(pending[0]!.content).toContain("Chinese");
    });
  });

  it("does not suggest a pending item again after the source project dream was rejected", () => {
    withBase((baseDir) => {
      const projectDir = "/tmp/rejected-project";

      const first = applyGlobalDreamPromotionGate({
        baseDir,
        projectDir,
        candidate,
        userDirectGlobal: false,
      });
      expect(first.pendingSuggested).toBe(true);
      expect(new MemoryManager({ baseDir, scope: "pending" }).rejectPending(candidate.name)).toBe(
        true,
      );

      const second = applyGlobalDreamPromotionGate({
        baseDir,
        projectDir,
        candidate,
        userDirectGlobal: false,
      });
      expect(second.pendingSuggested).toBe(false);
      expect(new MemoryManager({ baseDir, scope: "pending" }).loadAll()).toHaveLength(0);
    });
  });
});
