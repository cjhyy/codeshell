import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetJournalStore, type PetJournalRecord } from "./pet-journal-store";

async function withStore(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pet-journal-"));
  try {
    await run(join(root, "journal.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(overrides: Partial<PetJournalRecord> = {}): PetJournalRecord {
  return {
    segmentId: "seg-1",
    title: "调试构建失败",
    summary: "定位到 Bun 版本不匹配，升级后通过。",
    startedAt: 1_000,
    endedAt: 2_000,
    messageCount: 8,
    range: { start: 0, end: 7 },
    ...overrides,
  };
}

describe("PetJournalStore", () => {
  test("records, lists newest-first, and round-trips across reload", async () => {
    await withStore(async (path) => {
      const store = new PetJournalStore(path);
      await store.load();
      await store.record(record({ segmentId: "seg-1", endedAt: 1_000 }));
      await store.record(record({ segmentId: "seg-2", endedAt: 3_000, title: "第二段" }));
      expect(store.list().map((entry) => entry.segmentId)).toEqual(["seg-2", "seg-1"]);

      const reloaded = new PetJournalStore(path);
      await reloaded.load();
      expect(reloaded.list().map((entry) => entry.segmentId)).toEqual(["seg-2", "seg-1"]);
      expect(reloaded.list()[0]).toMatchObject({ title: "第二段", range: { start: 0, end: 7 } });
    });
  });

  test("dedupes on segmentId: a re-record updates in place", async () => {
    await withStore(async (path) => {
      const store = new PetJournalStore(path);
      await store.load();
      const first = await store.record(record({ segmentId: "seg-1", title: "初稿" }));
      const second = await store.record(record({ segmentId: "seg-1", title: "修订" }));
      expect(store.list()).toHaveLength(1);
      expect(second.id).toBe(first.id);
      expect(store.list()[0]?.title).toBe("修订");
    });
  });

  test("exposes recorded segment ids for the startup backfill", async () => {
    await withStore(async (path) => {
      const store = new PetJournalStore(path);
      await store.load();
      await store.record(record({ segmentId: "seg-1" }));
      await store.record(record({ segmentId: "seg-2" }));
      expect(store.recordedSegmentIds()).toEqual(new Set(["seg-1", "seg-2"]));
    });
  });

  test("caps stored entries, dropping the oldest by endedAt", async () => {
    await withStore(async (path) => {
      const store = new PetJournalStore(path, { maxEntries: 3 });
      await store.load();
      for (let index = 0; index < 5; index += 1) {
        await store.record(record({ segmentId: `seg-${index}`, endedAt: index }));
      }
      expect(store.list().map((entry) => entry.segmentId)).toEqual(["seg-4", "seg-3", "seg-2"]);
    });
  });

  test("truncates over-long title and summary instead of rejecting", async () => {
    await withStore(async (path) => {
      const store = new PetJournalStore(path);
      await store.load();
      const entry = await store.record(
        record({ title: "标".repeat(300), summary: "详".repeat(5_000) }),
      );
      expect(entry.title.length).toBe(200);
      expect(entry.summary.length).toBe(4_000);
    });
  });

  test("rejects empty title/summary and blank segment ids", async () => {
    await withStore(async (path) => {
      const store = new PetJournalStore(path);
      await store.load();
      await expect(store.record(record({ title: "   " }))).rejects.toThrow("title");
      await expect(store.record(record({ summary: "" }))).rejects.toThrow("summary");
      await expect(store.record(record({ segmentId: "  " }))).rejects.toThrow("segmentId");
    });
  });

  test("fails closed on malformed disk state", async () => {
    await withStore(async (path) => {
      await writeFile(path, "{not json");
      const store = new PetJournalStore(path);
      await expect(store.load()).rejects.toThrow();
      expect(store.list()).toEqual([]);
      await expect(store.record(record())).rejects.toThrow();
      expect(await readFile(path, "utf-8")).toBe("{not json");
    });
  });

  test("rolls back and removes the temporary file when atomic replace fails", async () => {
    await withStore(async (path) => {
      let failReplace = false;
      const store = new PetJournalStore(path, {
        replaceFile: async (temporaryPath, targetPath) => {
          if (failReplace) throw new Error("simulated rename failure");
          await rename(temporaryPath, targetPath);
        },
      });
      await store.load();
      await store.record(record({ segmentId: "seg-1", title: "before" }));
      const durableBefore = await readFile(path, "utf-8");
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });

      failReplace = true;
      await expect(store.record(record({ segmentId: "seg-2", title: "after" }))).rejects.toThrow(
        "simulated rename failure",
      );
      expect(store.list().map((entry) => entry.title)).toEqual(["before"]);
      expect(await readFile(path, "utf-8")).toBe(durableBefore);
      expect(notifications).toBe(0);
      const files = await readdir(join(path, ".."));
      expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("notifies subscribers after each successful record", async () => {
    await withStore(async (path) => {
      const store = new PetJournalStore(path);
      await store.load();
      let notified = 0;
      const unsubscribe = store.subscribe(() => {
        notified += 1;
      });
      await store.record(record({ segmentId: "seg-1" }));
      await store.record(record({ segmentId: "seg-2" }));
      unsubscribe();
      await store.record(record({ segmentId: "seg-3" }));
      expect(notified).toBe(2);
    });
  });
});
