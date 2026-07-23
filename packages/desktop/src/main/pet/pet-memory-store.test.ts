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

  test("persists across reloads and fails closed on malformed disk state", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();
      const entry = await store.remember("持久化测试", "user");

      const reloaded = new PetMemoryStore(path);
      await reloaded.load();
      expect(reloaded.list()).toEqual([entry]);

      const broken = new PetMemoryStore(path);
      await Bun.write(path, "{not json");
      await expect(broken.load()).rejects.toThrow();
      expect(broken.list()).toEqual([]);
      await expect(broken.remember("must not overwrite", "mimi")).rejects.toThrow();
      expect(await readFile(path, "utf-8")).toBe("{not json");
    });
  });

  test("retries a transient read failure and never stages an empty overwrite", async () => {
    await withStore(async (path) => {
      const durable = {
        version: 1,
        entries: [{ id: "mem-old", text: "existing", source: "user", createdAt: 1, updatedAt: 1 }],
      };
      await writeFile(path, JSON.stringify(durable));
      const before = await readFile(path, "utf-8");
      let reads = 0;
      const store = new PetMemoryStore(path, {
        readFile: async (target) => {
          reads += 1;
          if (reads === 1) {
            throw Object.assign(new Error("simulated transient EIO"), { code: "EIO" });
          }
          return await readFile(target, "utf-8");
        },
      });

      await expect(store.remember("new", "mimi")).rejects.toThrow("transient EIO");
      expect(await readFile(path, "utf-8")).toBe(before);
      await store.remember("new", "mimi");
      expect(store.list().map((entry) => entry.text)).toEqual(["new", "existing"]);
      expect(reads).toBe(2);
    });
  });

  test("updates an equivalent memory instead of adding a synonym duplicate", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path, {
        now: (() => {
          let tick = 10;
          return () => ++tick;
        })(),
      });
      await store.load();

      const original = await store.remember("用户喜欢使用暗色主题。", "user");
      const remembered = await store.remember("请记住：我偏爱深色模式", "mimi");

      expect(store.list()).toHaveLength(1);
      expect(remembered).toMatchObject({
        id: original.id,
        createdAt: original.createdAt,
        source: "user",
        text: "用户喜欢使用暗色主题。",
      });
      expect(remembered.updatedAt).toBe(original.updatedAt);
    });
  });

  test("uses conservative canonical matching and never folds distinct short facts or polarity", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();

      await store.remember("喜欢猫", "user");
      await store.remember("喜欢狗", "user");
      await store.remember("用户喜欢在所有项目中使用暗色主题", "mimi");
      await store.remember("用户不喜欢在所有项目中使用暗色主题", "mimi");

      expect(store.list()).toHaveLength(4);
    });
  });

  test("updates a long equivalent fact through a high-confidence wording alias", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();

      const original = await store.remember("默认工作目录固定在 /projects/codeshell", "user");
      const updated = await store.remember("默认工作目录固定于 /projects/codeshell", "mimi");

      expect(store.list()).toHaveLength(1);
      expect(updated.id).toBe(original.id);
      expect(updated.source).toBe("user");
    });
  });

  test("upgrades an equivalent Mimi entry to user ownership", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();
      const inferred = await store.remember("默认工作目录固定在 /projects/codeshell", "mimi");
      const confirmed = await store.remember("默认工作目录固定于 /projects/codeshell", "user");

      expect(confirmed).toMatchObject({ id: inferred.id, source: "user" });
      expect(store.list()).toHaveLength(1);
    });
  });

  test("does not merge long facts when only the project, path, or number differs", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();

      const distinctFacts = [
        "项目甲的生产发布统一使用蓝绿部署，并在完成后保留完整验证报告",
        "项目乙的生产发布统一使用蓝绿部署，并在完成后保留完整验证报告",
        "项目甲的默认工作目录固定在 /workspace/alpha/codeshell，并且统一使用 Bun 构建",
        "项目甲的默认工作目录固定在 /workspace/beta/codeshell，并且统一使用 Bun 构建",
        "项目甲每次并发任务上限固定为 12 个，同时保留两次失败重试",
        "项目甲每次并发任务上限固定为 13 个，同时保留两次失败重试",
      ];
      for (const fact of distinctFacts) await store.remember(fact, "mimi");

      expect(store.list()).toHaveLength(distinctFacts.length);
      expect(new Set(store.list().map((entry) => entry.text))).toEqual(new Set(distinctFacts));
    });
  });

  test("preserves semantic punctuation inside paths, identifiers, and numeric values", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();

      const distinctFacts = [
        "项目甲的工具目录固定在 /workspace/foo-bar，并且只从该目录加载配置",
        "项目甲的工具目录固定在 /workspace/foo/bar，并且只从该目录加载配置",
        "Windows 构建缓存固定在 C:\\workspace\\foo-bar，并保留最近三次结果",
        "Windows 构建缓存固定在 C:\\workspace\\foo\\bar，并保留最近三次结果",
        "发布流水线使用标识符 release_candidate-1，并在生产环境中保持稳定",
        "发布流水线使用标识符 release-candidate-1，并在生产环境中保持稳定",
        "发布流水线的最低版本固定为 1.20，并拒绝更早的客户端",
        "发布流水线的最低版本固定为 120，并拒绝更早的客户端",
      ];
      for (const fact of distinctFacts) await store.remember(fact, "mimi");

      expect(store.list()).toHaveLength(distinctFacts.length);
      expect(new Set(store.list().map((entry) => entry.text))).toEqual(new Set(distinctFacts));
    });
  });

  test("deduplicates equivalent concurrent remembers inside the serialized mutation", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path);
      await store.load();

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.remember(
            index % 2 === 0 ? "用户喜欢使用暗色主题" : "请记住：我偏爱深色模式",
            index % 2 === 0 ? "user" : "mimi",
          ),
        ),
      );

      expect(store.list()).toHaveLength(1);
      expect(new Set(results.map((entry) => entry.id)).size).toBe(1);
      expect(store.list()[0]?.source).toBe("user");
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
      const store = new PetMemoryStore(path, { maxEntries: 3, now: () => 1_000 });
      await store.load();
      for (let index = 0; index < 5; index += 1) {
        await store.remember(`memory-${index}`, "mimi");
      }
      expect(store.list().map((entry) => entry.text)).toEqual(["memory-4", "memory-3", "memory-2"]);
      const raw = JSON.parse(await readFile(path, "utf-8")) as { entries: unknown[] };
      expect(raw.entries).toHaveLength(3);
    });
  });

  test("Mimi evicts only Mimi entries and cannot displace a user-only library", async () => {
    await withStore(async (path) => {
      const store = new PetMemoryStore(path, { maxEntries: 3, now: () => 1_000 });
      await store.load();
      await store.remember("user-one", "user");
      await store.remember("mimi-old", "mimi");
      await store.remember("user-two", "user");
      await store.remember("mimi-new", "mimi");
      expect(store.list().map((entry) => entry.text)).toEqual(["mimi-new", "user-two", "user-one"]);

      await store.forget(store.list().find((entry) => entry.text === "mimi-new")!.id);
      await store.remember("user-three", "user");
      await expect(store.remember("mimi-blocked", "mimi")).rejects.toThrow(
        "full of user-authored entries",
      );
      expect(store.list().map((entry) => entry.text)).not.toContain("mimi-blocked");
    });
  });

  test("keeps same-millisecond mutations newest-first across reload and concurrent calls", async () => {
    await withStore(async (path) => {
      const fixedNow = () => 1_000;
      const store = new PetMemoryStore(path, { maxEntries: 3, now: fixedNow });
      await store.load();

      const first = await store.remember("first", "user");
      const second = await store.remember("second", "mimi");
      const third = await store.remember("third", "mimi");
      expect([first.updatedAt, second.updatedAt, third.updatedAt]).toEqual([1_000, 1_001, 1_002]);

      const refreshedFirst = await store.update(first.id, "first refreshed");
      expect(refreshedFirst.updatedAt).toBe(1_003);
      expect(store.list().map((entry) => entry.text)).toEqual([
        "first refreshed",
        "third",
        "second",
      ]);

      await store.remember("fourth", "mimi");
      expect(store.list().map((entry) => entry.text)).toEqual([
        "fourth",
        "first refreshed",
        "third",
      ]);

      const reloaded = new PetMemoryStore(path, { maxEntries: 3, now: fixedNow });
      await reloaded.load();
      const [fifth, sixth] = await Promise.all([
        reloaded.remember("fifth", "mimi"),
        reloaded.remember("sixth", "mimi"),
      ]);
      expect([fifth.updatedAt, sixth.updatedAt]).toEqual([1_005, 1_006]);
      expect(reloaded.list().map((entry) => entry.text)).toEqual([
        "sixth",
        "fifth",
        "first refreshed",
      ]);

      const reloadedAgain = new PetMemoryStore(path, { maxEntries: 3, now: fixedNow });
      await reloadedAgain.load();
      expect(reloadedAgain.list().map((entry) => entry.text)).toEqual([
        "sixth",
        "fifth",
        "first refreshed",
      ]);
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
