import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetWorkMemoryStore } from "./pet-work-memory-store";

describe("PetWorkMemoryStore", () => {
  test("appends and reloads work memory entries and tracks the active segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load();
      await store.append({ segmentId: "s1", objective: "修 bug", outcome: "completed", at: 5 });
      await store.openSegment({ id: "s1", startedAt: 5 });
      expect(store.entries()).toHaveLength(1);
      expect(store.activeSegment()?.id).toBe("s1");

      const reopened = new PetWorkMemoryStore(filePath, () => 6);
      await reopened.load();
      expect(reopened.entries()).toHaveLength(1);
      expect(reopened.activeSegment()?.id).toBe("s1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tracks lastInteractionAt across reloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load();
      expect(store.lastInteractionAt()).toBe(0);
      await store.setLastInteractionAt(9_999);
      await store.flush();

      const reopened = new PetWorkMemoryStore(filePath, () => 6);
      await reopened.load();
      expect(reopened.lastInteractionAt()).toBe(9_999);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deduplicates replayed terminal closures across reloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      const entry = {
        segmentId: "s1",
        dedupeKey: "task-1:1:completed",
        objective: "Ship the task",
        outcome: "completed" as const,
        at: 5,
      };
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load();
      await store.append(entry);
      await store.append({ ...entry, at: 6 });
      expect(store.entries()).toHaveLength(1);

      const reopened = new PetWorkMemoryStore(filePath, () => 7);
      await reopened.load();
      await reopened.append({ ...entry, at: 7 });
      expect(reopened.entries()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caps stored entries at 1000, keeping the most recent", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load();
      for (let i = 0; i < 1_050; i++) {
        await store.append({ segmentId: "s", objective: `t${i}`, outcome: "completed", at: i });
      }
      await store.flush();
      expect(store.entries()).toHaveLength(1_000);
      expect(store.entries()[0]?.objective).toBe("t50");
      expect(store.entries().at(-1)?.objective).toBe("t1049");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records segment boundaries with chat message ids and reloads them", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load();
      await store.openSegment({
        id: "seg-1",
        startedAt: 5,
        boundaryBeforeMessageId: "pet-a",
      });
      await store.openSegment({
        id: "seg-2",
        startedAt: 6,
        boundaryBeforeMessageId: "pet-b",
        brief: "未完成任务:\n- 重构 X",
      });
      // The latest opened segment is the active one.
      expect(store.activeSegment()?.id).toBe("seg-2");
      // The boundary history is message-keyed and ordered oldest → newest.
      expect(store.segmentBoundaries()).toEqual([
        { boundaryBeforeMessageId: "pet-a" },
        { boundaryBeforeMessageId: "pet-b", brief: "未完成任务:\n- 重构 X" },
      ]);
      await store.flush();

      const reopened = new PetWorkMemoryStore(filePath, () => 7);
      await reopened.load();
      expect(reopened.activeSegment()?.id).toBe("seg-2");
      expect(reopened.segmentBoundaries()).toEqual([
        { boundaryBeforeMessageId: "pet-a" },
        { boundaryBeforeMessageId: "pet-b", brief: "未完成任务:\n- 重构 X" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caps the segment boundary history, keeping the most recent", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load();
      for (let i = 0; i < 80; i++) {
        await store.openSegment({
          id: `seg-${i}`,
          startedAt: i,
          boundaryBeforeMessageId: `msg-${i}`,
        });
      }
      await store.flush();
      const boundaries = store.segmentBoundaries();
      expect(boundaries).toHaveLength(50);
      expect(boundaries[0]?.boundaryBeforeMessageId).toBe("msg-30");
      expect(boundaries.at(-1)?.boundaryBeforeMessageId).toBe("msg-79");
      expect(store.activeSegment()?.id).toBe("seg-79");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omits boundaries that never captured a chat message id", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load();
      // A legacy/time-only segment with no message id must not surface a boundary.
      await store.openSegment({ id: "seg-legacy", startedAt: 5 });
      await store.openSegment({
        id: "seg-real",
        startedAt: 6,
        boundaryBeforeMessageId: "msg-1",
      });
      expect(store.segmentBoundaries()).toEqual([{ boundaryBeforeMessageId: "msg-1" }]);
      expect(store.activeSegment()?.id).toBe("seg-real");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("survives a missing or corrupt file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const filePath = join(root, "pet", "work-memory.json");
      await writeFile(`${filePath}`, "not json", "utf8").catch(() => {});
      const store = new PetWorkMemoryStore(filePath, () => 5);
      await store.load(); // must not throw even though the parent dir is absent
      expect(store.entries()).toHaveLength(0);
      expect(store.activeSegment()).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not acknowledge an entry when its durable write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
    try {
      const blockingFile = join(root, "not-a-directory");
      await writeFile(blockingFile, "block mkdir", "utf8");
      const store = new PetWorkMemoryStore(join(blockingFile, "work-memory.json"), () => 5);
      await expect(
        store.append({
          segmentId: "s1",
          dedupeKey: "task-1:1:completed",
          objective: "Must persist",
          outcome: "completed",
          at: 5,
        }),
      ).rejects.toThrow();
      expect(store.entries()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
