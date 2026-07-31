import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetTodoStore } from "./pet-todo-store";

async function withStore(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pet-todos-"));
  try {
    await run(join(root, "todos.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("PetTodoStore", () => {
  test("persists stable personal todos and archives without deleting", async () => {
    await withStore(async (path) => {
      const store = new PetTodoStore(path, {
        now: (() => {
          let tick = 10;
          return () => ++tick;
        })(),
      });
      await store.load();

      const first = await store.create("整理发布说明");
      const second = await store.create("确认回归测试");
      await store.setStatus(first.id, "in_progress");
      await store.update(second.id, "确认桌面端回归测试");
      await store.setStatus(first.id, "archived");

      expect(store.list()).toMatchObject([
        { id: second.id, text: "确认桌面端回归测试", status: "pending" },
      ]);
      expect(
        store.list({ includeArchived: true }).find((item) => item.id === first.id),
      ).toMatchObject({
        id: first.id,
        status: "archived",
      });

      const reloaded = new PetTodoStore(path);
      await reloaded.load();
      expect(reloaded.list({ includeArchived: true })).toEqual(
        store.list({ includeArchived: true }),
      );
    });
  });

  test("serializes mutations and notifies only after a durable change", async () => {
    await withStore(async (path) => {
      const store = new PetTodoStore(path, { now: () => 1 });
      await store.load();
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });

      const [first, second] = await Promise.all([store.create("第一项"), store.create("第二项")]);
      expect(first.id).not.toBe(second.id);
      expect(store.list()).toHaveLength(2);
      expect(notifications).toBe(2);
      await expect(store.create("   ")).rejects.toThrow("不能为空");
      expect(notifications).toBe(2);
    });
  });
});
