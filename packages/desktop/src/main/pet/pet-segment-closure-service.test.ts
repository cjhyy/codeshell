import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosureExtraction, ClosureMessage } from "@cjhyy/code-shell-pet";
import { PetJournalStore } from "./pet-journal-store";
import { PetMemoryStore } from "./pet-memory-store";
import {
  createPetSegmentClosureService,
  type ClosedSegmentDescriptor,
} from "./pet-segment-closure-service";

const messages: ClosureMessage[] = [
  { role: "user", text: "帮我调试构建", clientMessageId: "c0" },
  { role: "assistant", text: "在看了" },
  { role: "user", text: "还是失败" },
  { role: "assistant", text: "升级 Bun 后通过" },
  { role: "user", text: "新话题", clientMessageId: "c1" },
  { role: "assistant", text: "收到" },
];

async function withStores(
  run: (stores: { journal: PetJournalStore; memory: PetMemoryStore }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pet-closure-"));
  try {
    const journal = new PetJournalStore(join(root, "journal.json"), { now: () => 1 });
    const memory = new PetMemoryStore(join(root, "memories.json"), { now: () => 1 });
    await Promise.all([journal.load(), memory.load()]);
    await run({ journal, memory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function extraction(overrides: Partial<ClosureExtraction> = {}): ClosureExtraction {
  return {
    title: "调试构建失败",
    summary: "升级 Bun 版本后构建通过。",
    memories: ["偏好使用 Bun 构建"],
    ...overrides,
  };
}

describe("createPetSegmentClosureService", () => {
  test("records a journal entry, an auto memory, and returns the range", async () => {
    await withStores(async ({ journal, memory }) => {
      const service = createPetSegmentClosureService({
        petSessionId: "pet",
        sessionsRootDir: "/unused",
        journal,
        memory,
        autoExtractEnabled: () => true,
        readMessages: async () => messages,
        generate: async () => extraction(),
      });

      const result = await service.close({
        segmentId: "seg-1",
        closingBoundaryMessageId: "c0",
        nextBoundaryMessageId: "c1",
        startedAt: 100,
        endedAt: 200,
      });

      expect(result?.range).toEqual({ start: 0, end: 4 });
      expect(journal.list()).toHaveLength(1);
      expect(journal.list()[0]).toMatchObject({
        segmentId: "seg-1",
        title: "调试构建失败",
        messageCount: 4,
        range: { start: 0, end: 4 },
      });
      expect(memory.list()[0]).toMatchObject({ source: "auto", segmentId: "seg-1" });
    });
  });

  test("skips a segment shorter than the minimum message count", async () => {
    await withStores(async ({ journal, memory }) => {
      let generated = 0;
      const service = createPetSegmentClosureService({
        petSessionId: "pet",
        sessionsRootDir: "/unused",
        journal,
        memory,
        autoExtractEnabled: () => true,
        readMessages: async () => [
          { role: "user", text: "hi", clientMessageId: "c0" },
          { role: "assistant", text: "yo" },
          { role: "user", text: "next", clientMessageId: "c1" },
        ],
        generate: async () => {
          generated += 1;
          return extraction();
        },
      });

      const result = await service.close({
        segmentId: "seg-1",
        closingBoundaryMessageId: "c0",
        nextBoundaryMessageId: "c1",
        startedAt: 1,
        endedAt: 2,
      });
      expect(result).toBeNull();
      expect(generated).toBe(0);
      expect(journal.list()).toHaveLength(0);
    });
  });

  test("still returns the range for archival when auto-extract is disabled", async () => {
    await withStores(async ({ journal, memory }) => {
      let generated = 0;
      const service = createPetSegmentClosureService({
        petSessionId: "pet",
        sessionsRootDir: "/unused",
        journal,
        memory,
        autoExtractEnabled: () => false,
        readMessages: async () => messages,
        generate: async () => {
          generated += 1;
          return extraction();
        },
      });

      const result = await service.close({
        segmentId: "seg-1",
        closingBoundaryMessageId: "c0",
        nextBoundaryMessageId: "c1",
        startedAt: 1,
        endedAt: 2,
      });
      expect(result?.range).toEqual({ start: 0, end: 4 });
      expect(generated).toBe(0);
      expect(journal.list()).toHaveLength(0);
      expect(memory.list()).toHaveLength(0);
    });
  });

  test("keeps the journal entry when a memory candidate is rejected", async () => {
    await withStores(async ({ journal, memory }) => {
      const service = createPetSegmentClosureService({
        petSessionId: "pet",
        sessionsRootDir: "/unused",
        journal,
        memory,
        autoExtractEnabled: () => true,
        readMessages: async () => messages,
        generate: async () => extraction({ memories: ["", "x".repeat(3_000)] }),
      });
      const result = await service.close({
        segmentId: "seg-1",
        closingBoundaryMessageId: "c0",
        nextBoundaryMessageId: "c1",
        startedAt: 1,
        endedAt: 2,
      });
      expect(result?.range).toEqual({ start: 0, end: 4 });
      expect(journal.list()).toHaveLength(1);
      expect(memory.list()).toHaveLength(0);
    });
  });

  test("returns null but does not throw on aux failure", async () => {
    await withStores(async ({ journal, memory }) => {
      const service = createPetSegmentClosureService({
        petSessionId: "pet",
        sessionsRootDir: "/unused",
        journal,
        memory,
        autoExtractEnabled: () => true,
        readMessages: async () => messages,
        generate: async () => {
          throw new Error("aux down");
        },
      });
      const result = await service.close({
        segmentId: "seg-1",
        closingBoundaryMessageId: "c0",
        nextBoundaryMessageId: "c1",
        startedAt: 1,
        endedAt: 2,
      });
      // The range is still returned so the caller can archive the model context.
      expect(result?.range).toEqual({ start: 0, end: 4 });
      expect(journal.list()).toHaveLength(0);
    });
  });

  test("readSegmentMessages returns role+text within a clamped range", async () => {
    await withStores(async ({ journal, memory }) => {
      const service = createPetSegmentClosureService({
        petSessionId: "pet",
        sessionsRootDir: "/unused",
        journal,
        memory,
        autoExtractEnabled: () => true,
        readMessages: async () => messages,
        generate: async () => extraction(),
      });
      expect(await service.readSegmentMessages({ start: 0, end: 2 })).toEqual([
        { role: "user", text: "帮我调试构建" },
        { role: "assistant", text: "在看了" },
      ]);
      // Over-long end is clamped to the message count; empty windows return [].
      expect(await service.readSegmentMessages({ start: 4, end: 999 })).toHaveLength(2);
      expect(await service.readSegmentMessages({ start: 3, end: 3 })).toEqual([]);
    });
  });

  test("backfill records only settled, unrecorded segments and never the active one", async () => {
    await withStores(async ({ journal, memory }) => {
      const closed: string[] = [];
      const service = createPetSegmentClosureService({
        petSessionId: "pet",
        sessionsRootDir: "/unused",
        journal,
        memory,
        autoExtractEnabled: () => true,
        readMessages: async () => messages,
        generate: async () => extraction(),
      });
      // seg-1 already recorded; seg-2 settled + missing; seg-3 is active.
      await journal.record({
        segmentId: "seg-1",
        title: "旧",
        summary: "旧",
        startedAt: 1,
        endedAt: 2,
        messageCount: 3,
        range: { start: 0, end: 2 },
      });
      const originalClose = service.close.bind(service);
      service.close = async (input) => {
        closed.push(input.segmentId);
        return originalClose(input);
      };

      const segments: ClosedSegmentDescriptor[] = [
        { id: "seg-1", boundaryBeforeMessageId: "c0", startedAt: 10 },
        { id: "seg-2", boundaryBeforeMessageId: "c1", startedAt: 20 },
        { id: "seg-3", boundaryBeforeMessageId: "c9", startedAt: 30 },
      ];
      await service.backfill(segments, 999);
      expect(closed).toEqual(["seg-2"]);
    });
  });
});
