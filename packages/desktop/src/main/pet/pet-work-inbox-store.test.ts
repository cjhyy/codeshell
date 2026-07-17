import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PET_WORK_INBOX_DISMISSED_ITEMS, PetWorkInboxStore } from "./pet-work-inbox-store";

describe("PetWorkInboxStore", () => {
  test("atomically persists session-scoped work item ids and reloads them", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-"));
    try {
      const file = join(root, "work-inbox.json");
      const first = new PetWorkInboxStore(file);
      expect(first.add(["completed:session-a", "completed:session-b"])).toEqual({
        revision: 1,
        dismissedIds: ["completed:session-a", "completed:session-b"],
      });
      expect(first.add(["completed:session-a"]).revision).toBe(1);
      await first.flush();

      const second = new PetWorkInboxStore(file);
      await second.load();
      expect(second.getSnapshot()).toEqual({
        revision: 1,
        dismissedIds: ["completed:session-a", "completed:session-b"],
      });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        version: 1,
        revision: 1,
        dismissedIds: ["completed:session-a", "completed:session-b"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts every structured work group prefix, including running", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-"));
    try {
      const file = join(root, "work-inbox.json");
      const store = new PetWorkInboxStore(file);
      const ids = [
        "running:session-a",
        "pending:session-b:req-1",
        "follow-up:session-c",
        "completed:session-d",
        "other:session-e",
      ];
      expect(store.add(ids).dismissedIds).toEqual(ids);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed ids, bounds history and persists clear", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-"));
    try {
      const file = join(root, "work-inbox.json");
      const store = new PetWorkInboxStore(file);
      store.add([
        "not-scoped",
        "completed:line\nbreak",
        ...Array.from(
          { length: MAX_PET_WORK_INBOX_DISMISSED_ITEMS + 2 },
          (_, index) => `other:session-${index}`,
        ),
      ]);
      expect(store.getSnapshot().dismissedIds).toHaveLength(MAX_PET_WORK_INBOX_DISMISSED_ITEMS);
      expect(store.getSnapshot().dismissedIds[0]).toBe("other:session-2");
      expect(store.clear()).toEqual({ revision: 2, dismissedIds: [] });
      await store.flush();

      const reloaded = new PetWorkInboxStore(file);
      await reloaded.load();
      expect(reloaded.getSnapshot()).toEqual({ revision: 2, dismissedIds: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
