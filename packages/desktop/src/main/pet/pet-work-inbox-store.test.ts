import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PET_WORK_INBOX_DISMISSED_ITEMS,
  PetWorkInboxStore,
  type PetWorkInboxSnapshot,
} from "./pet-work-inbox-store";

describe("PetWorkInboxStore", () => {
  test("atomically persists session-scoped work item ids and reloads them", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-"));
    try {
      const file = join(root, "work-inbox.json");
      const first = new PetWorkInboxStore(file);
      const revisions: number[] = [];
      const unsubscribe = first.subscribe((snapshot) => revisions.push(snapshot.revision));
      expect(first.add(["completed:session-a", "completed:session-b"])).toEqual({
        revision: 1,
        dismissedIds: ["completed:session-a", "completed:session-b"],
      });
      expect(first.add(["completed:session-a"]).revision).toBe(1);
      unsubscribe();
      first.add(["completed:session-c"]);
      expect(revisions).toEqual([1]);
      await first.flush();

      const second = new PetWorkInboxStore(file);
      await second.load();
      expect(second.getSnapshot()).toEqual({
        revision: 2,
        dismissedIds: ["completed:session-a", "completed:session-b", "completed:session-c"],
      });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        version: 1,
        revision: 2,
        dismissedIds: ["completed:session-a", "completed:session-b", "completed:session-c"],
      });
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
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

  test("surfaces a failed durable write and lets the next mutation recover", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-failure-"));
    const blocker = join(root, "not-a-directory");
    const file = join(blocker, "work-inbox.json");
    try {
      await writeFile(blocker, "block directory creation");
      const store = new PetWorkInboxStore(file);
      store.add(["completed:session-a"]);
      await expect(store.flush()).rejects.toThrow();

      await unlink(blocker);
      await mkdir(blocker);
      store.add(["completed:session-b"]);
      await store.flush();

      const reloaded = new PetWorkInboxStore(file);
      await reloaded.load();
      expect(reloaded.getSnapshot().dismissedIds).toEqual([
        "completed:session-a",
        "completed:session-b",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose a Mimi host-action mutation until its durable write succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-transaction-"));
    const blocker = join(root, "not-a-directory");
    const file = join(blocker, "work-inbox.json");
    try {
      await writeFile(blocker, "block directory creation");
      const store = new PetWorkInboxStore(file);
      const changes: PetWorkInboxSnapshot[] = [];
      store.subscribe((snapshot) => changes.push(snapshot));

      await expect(store.addDurably(["follow-up:followup-a"])).rejects.toThrow();
      expect(store.getSnapshot()).toEqual({ revision: 0, dismissedIds: [] });
      expect(changes).toEqual([]);

      await unlink(blocker);
      await mkdir(blocker);
      await expect(store.addDurably(["follow-up:followup-a"])).resolves.toEqual({
        revision: 1,
        dismissedIds: ["follow-up:followup-a"],
      });
      expect(changes).toEqual([{ revision: 1, dismissedIds: ["follow-up:followup-a"] }]);

      const reloaded = new PetWorkInboxStore(file);
      await reloaded.load();
      expect(reloaded.getSnapshot().dismissedIds).toEqual(["follow-up:followup-a"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("atomically claims one follow-up across concurrent callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-claim-"));
    const file = join(root, "work-inbox.json");
    try {
      const store = new PetWorkInboxStore(file);
      const [first, second] = await Promise.all([
        store.addIfAbsentDurably("follow-up:followup-a"),
        store.addIfAbsentDurably("follow-up:followup-a"),
      ]);
      expect([first.added, second.added].sort()).toEqual([false, true]);
      expect(store.getSnapshot()).toEqual({
        revision: 1,
        dismissedIds: ["follow-up:followup-a"],
      });
      const reloaded = new PetWorkInboxStore(file);
      await reloaded.load();
      expect(reloaded.getSnapshot()).toEqual(store.getSnapshot());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restore-dismissed clear keeps handled follow-up ids while clearing session rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-restore-"));
    const file = join(root, "work-inbox.json");
    try {
      const store = new PetWorkInboxStore(file);
      await store.addDurably([
        "completed:session-a",
        "follow-up:followup-a",
        "pending:session-b:req-1",
        "follow-up:followup-b",
      ]);
      expect(await store.clearDurably()).toEqual({
        revision: 2,
        dismissedIds: ["follow-up:followup-a", "follow-up:followup-b"],
      });

      store.add(["completed:session-c"]);
      expect(store.clear()).toEqual({
        revision: 4,
        dismissedIds: ["follow-up:followup-a", "follow-up:followup-b"],
      });
      await store.flush();

      const reloaded = new PetWorkInboxStore(file);
      await reloaded.load();
      expect(reloaded.getSnapshot().dismissedIds).toEqual([
        "follow-up:followup-a",
        "follow-up:followup-b",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("history eviction drops oldest session ids before follow-up handled ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-evict-"));
    const file = join(root, "work-inbox.json");
    try {
      const store = new PetWorkInboxStore(file);
      store.add(["follow-up:followup-a"]);
      store.add(
        Array.from(
          { length: MAX_PET_WORK_INBOX_DISMISSED_ITEMS },
          (_, index) => `other:session-${index}`,
        ),
      );
      const ids = store.getSnapshot().dismissedIds;
      expect(ids).toHaveLength(MAX_PET_WORK_INBOX_DISMISSED_ITEMS);
      expect(ids).toContain("follow-up:followup-a");
      expect(ids).not.toContain("other:session-0");

      const durable = await store.addDurably(["completed:session-late"]);
      expect(durable.dismissedIds).toHaveLength(MAX_PET_WORK_INBOX_DISMISSED_ITEMS);
      expect(durable.dismissedIds).toContain("follow-up:followup-a");
      expect(durable.dismissedIds).toContain("completed:session-late");
      expect(durable.dismissedIds).not.toContain("other:session-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes the renderer's durable clear with a Mimi follow-up claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-work-inbox-clear-"));
    const file = join(root, "work-inbox.json");
    try {
      const store = new PetWorkInboxStore(file);
      await store.addDurably(["completed:session-a"]);
      const claim = store.addIfAbsentDurably("follow-up:followup-a");
      const clear = store.clearDurably();

      expect((await claim).added).toBe(true);
      // The serialized clear lands after the claim and must keep the freshly
      // claimed follow-up handled state while restoring the session row.
      expect(await clear).toEqual({ revision: 3, dismissedIds: ["follow-up:followup-a"] });
      const reloaded = new PetWorkInboxStore(file);
      await reloaded.load();
      expect(reloaded.getSnapshot()).toEqual(store.getSnapshot());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
