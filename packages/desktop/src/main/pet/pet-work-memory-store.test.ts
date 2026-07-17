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
      await store.setSegment({ id: "s1", startedAt: 5 });
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
});
