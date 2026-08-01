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

  // Capacity used to be a single 500-entry cap that INCLUDED archived rows,
  // while archiving only flips `status` and nothing ever deletes. So the cap was
  // a lifetime total: after 500 todos had existed, creation failed forever — even
  // with an empty visible list — and the message told the user to archive, which
  // could never help. Active capacity and archived history are now separate.
  describe("capacity", () => {
    test("archiving frees active capacity, so creation keeps working", async () => {
      await withStore(async (path) => {
        let tick = 0;
        const store = new PetTodoStore(path, { now: () => ++tick });
        await store.load();

        // Fill to the active cap.
        const ids: string[] = [];
        for (let i = 0; i < 500; i += 1) {
          ids.push((await store.create(`item-${i}`)).id);
        }
        await expect(store.create("overflow")).rejects.toThrow("待办列表已满");

        // Archive one → exactly one active slot opens up.
        await store.setStatus(ids[0]!, "archived");
        const created = await store.create("after archiving");
        expect(created.text).toBe("after archiving");

        // Still capped at 500 ACTIVE, with the archived row retained as history.
        expect(store.list()).toHaveLength(500);
        expect(store.list({ includeArchived: true })).toHaveLength(501);
        await expect(store.create("overflow again")).rejects.toThrow("待办列表已满");
      });
    });

    test("a fully archived list is not full", async () => {
      // The old bug's sharpest form: 500 archived, 0 visible, creation blocked.
      await withStore(async (path) => {
        let tick = 0;
        const store = new PetTodoStore(path, { now: () => ++tick });
        await store.load();

        for (let i = 0; i < 500; i += 1) {
          const item = await store.create(`old-${i}`);
          await store.setStatus(item.id, "archived");
        }
        expect(store.list()).toHaveLength(0);

        const revived = await store.create("brand new");
        expect(revived.text).toBe("brand new");
        expect(store.list()).toHaveLength(1);
      });
    });

    test("archived history is trimmed oldest-first past its retention limit", async () => {
      // Retention is overridden to 3 so this exercises the real pruning path
      // without 2000 atomic file writes.
      await withStore(async (path) => {
        let tick = 0;
        const store = new PetTodoStore(path, {
          now: () => ++tick,
          maxArchivedEntries: 3,
        });
        await store.load();

        const archivedIds: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const item = await store.create(`hist-${i}`);
          await store.setStatus(item.id, "archived");
          archivedIds.push(item.id);
        }

        const all = store.list({ includeArchived: true });
        expect(all).toHaveLength(3);
        // The two oldest aged out; the three newest survive.
        expect(all.some((item) => item.id === archivedIds[0])).toBe(false);
        expect(all.some((item) => item.id === archivedIds[1])).toBe(false);
        expect(all.map((item) => item.id).sort()).toEqual(
          [archivedIds[2]!, archivedIds[3]!, archivedIds[4]!].sort(),
        );
      });
    });

    test("active items are never pruned as history", async () => {
      await withStore(async (path) => {
        let tick = 0;
        const store = new PetTodoStore(path, {
          now: () => ++tick,
          maxArchivedEntries: 1,
        });
        await store.load();

        const keep = await store.create("still active");
        for (let i = 0; i < 3; i += 1) {
          const item = await store.create(`gone-${i}`);
          await store.setStatus(item.id, "archived");
        }

        // Retention only ever drops archived rows.
        expect(store.list().map((item) => item.id)).toEqual([keep.id]);
        expect(store.list({ includeArchived: true })).toHaveLength(2);
      });
    });
  });
});
