import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetMemoryStore } from "./pet-memory-store";

async function withStore(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pet-memory-"));
  try {
    await run(join(root, "memories.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("PetMemoryStore", () => {
  test("remembers, updates, forgets, and lists newest-first", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path, {
        now: (() => {
          let tick = 0;
          return () => ++tick;
        })(),
      });
      await store.load();

      const first = await store.remember("喜欢暗色主题", "mimi");
      const second = await store.remember("工作目录在 ~/work", "user");
      expect(store.list().map((entry) => entry.text)).toEqual([
        "工作目录在 ~/work",
        "喜欢暗色主题",
      ]);

      const updated = await store.update(first.id, "喜欢暗色主题和紧凑布局");
      expect(updated.text).toBe("喜欢暗色主题和紧凑布局");
      expect(updated.updatedAt).toBeGreaterThan(updated.createdAt);
      // An updated entry counts as the most recent.
      expect(store.list()[0]?.id).toBe(first.id);

      await store.forget(second.id);
      expect(store.list().map((entry) => entry.id)).toEqual([first.id]);
    });
  });

  test("persists across reloads and survives malformed disk state", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();
      const entry = await store.remember("持久化测试", "user");

      const reloaded = new PetMemoryStore(path);
      await reloaded.load();
      expect(reloaded.list()).toEqual([entry]);

      const broken = new PetMemoryStore(path);
      await Bun.write(path, "{not json");
      await broken.load();
      expect(broken.list()).toEqual([]);
    });
  });

  test("rejects invalid input and unknown ids", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();

      await expect(store.remember("", "user")).rejects.toThrow();
      await expect(store.remember("x".repeat(2_001), "user")).rejects.toThrow();
      await expect(store.update("missing", "text")).rejects.toThrow("not found");
      await expect(store.forget("missing")).rejects.toThrow("not found");
    });
  });

  test("caps stored entries, dropping the oldest", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path, { maxEntries: 3 });
      await store.load();
      for (let index = 0; index < 5; index += 1) {
        await store.remember(`memory-${index}`, "mimi");
      }
      expect(store.list().map((entry) => entry.text)).toEqual(["memory-4", "memory-3", "memory-2"]);
      const raw = JSON.parse(await readFile(path, "utf-8")) as { entries: unknown[] };
      expect(raw.entries).toHaveLength(3);
    });
  });

  test("enforces the hard 200-entry cap when loading externally written state", async () => {
    await withStore(async (path) => {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          entries: Array.from({ length: 205 }, (_, index) => ({
            id: `mem-${index}`,
            text: `memory-${index}`,
            source: "user",
            createdAt: index,
            updatedAt: index,
          })),
        }),
      );

      const store = new PetMemoryStore(path, { maxEntries: 500 });
      await store.load();
      expect(store.list()).toHaveLength(200);
      expect(store.list()[0]?.text).toBe("memory-204");
      expect(store.list().at(-1)?.text).toBe("memory-5");
    });
  });

  test("serializes concurrent mutations and always leaves complete atomic JSON", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();
      await store.remember("seed", "user");

      let settled = false;
      const mutations = Promise.all(
        Array.from({ length: 40 }, (_, index) => store.remember(`memory-${index}`, "mimi")),
      ).finally(() => {
        settled = true;
      });
      let observations = 0;
      while (!settled) {
        const raw = await readFile(path, "utf-8");
        expect(() => JSON.parse(raw)).not.toThrow();
        observations += 1;
        await Bun.sleep(0);
      }
      await mutations;

      expect(observations).toBeGreaterThan(0);
      expect(store.list()).toHaveLength(41);
      const files = await readdir(join(path, ".."));
      expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("rolls back memory and removes the temporary file when atomic replace fails", async () => {
    await withStore(async (path) => {
      let failReplace = false;
      const store = new PetMemoryStore(path, {
        replaceFile: async (temporaryPath, targetPath) => {
          if (failReplace) throw new Error("simulated rename failure");
          await rename(temporaryPath, targetPath);
        },
      });
      await store.load();
      const entry = await store.remember("before", "user");
      const durableBefore = await readFile(path, "utf-8");
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });

      failReplace = true;
      await expect(store.update(entry.id, "after")).rejects.toThrow("simulated rename failure");
      expect(store.list()[0]?.text).toBe("before");
      expect(await readFile(path, "utf-8")).toBe(durableBefore);
      expect(notifications).toBe(0);
      const files = await readdir(join(path, ".."));
      expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("notifies subscribers after each mutation", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();
      let notified = 0;
      const unsubscribe = store.subscribe(() => {
        notified += 1;
      });
      const entry = await store.remember("a", "user");
      await store.update(entry.id, "b");
      await store.forget(entry.id);
      unsubscribe();
      await store.remember("c", "user");
      expect(notified).toBe(3);
    });
  });
});
