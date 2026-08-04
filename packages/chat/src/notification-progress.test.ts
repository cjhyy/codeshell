import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileNotificationDeliveryProgressStore,
  NotificationDeliveryProgress,
  notificationTargetProgressKey,
  type NotificationDeliveryProgressState,
  type NotificationDeliveryProgressStore,
} from "./notification-progress.js";

describe("notification delivery progress", () => {
  test("atomically stores owner-only opaque target progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-notification-progress-"));
    const path = join(root, "nested", "desktop-events.json.deliveries");
    const store = new FileNotificationDeliveryProgressStore(path);
    const progress = new NotificationDeliveryProgress(store);
    const targetKey = notificationTargetProgressKey("wechat", "private-owner-id");
    try {
      await progress.begin(`${"a".repeat(32)}:7`);
      await progress.mark(`${"a".repeat(32)}:7`, targetKey, 2, 1);
      await progress.flush();

      expect(await store.load()).toEqual({
        version: 3,
        events: {
          [`${"a".repeat(32)}:7`]: {
            chunks: { [targetKey]: 2 },
            attachments: { [targetKey]: 1 },
          },
        },
      });
      expect(await readFile(path, "utf-8")).not.toContain("private-owner-id");
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps independent progress for queued events and restores legacy state", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-notification-history-"));
    const path = join(root, "progress.json");
    const store = new FileNotificationDeliveryProgressStore(path);
    const firstKey = `${"c".repeat(32)}:1`;
    const secondKey = `${"c".repeat(32)}:2`;
    const firstTarget = notificationTargetProgressKey("wechat", "first-owner");
    const secondTarget = notificationTargetProgressKey("telegram", "second-owner");
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          eventKey: firstKey,
          chunks: { [firstTarget]: 1 },
          attachments: [],
        }),
        { mode: 0o600 },
      );
      const progress = new NotificationDeliveryProgress(store);
      await progress.begin(secondKey);
      await progress.mark(secondKey, secondTarget, 2, 2);

      const restored = new NotificationDeliveryProgress(store);
      await restored.begin(firstKey);
      expect(restored.chunkIndex(firstKey, firstTarget)).toBe(1);
      expect(restored.attachmentIndex(firstKey, firstTarget)).toBe(0);
      await restored.begin(secondKey);
      expect(restored.chunkIndex(secondKey, secondTarget)).toBe(2);
      expect(restored.attachmentIndex(secondKey, secondTarget)).toBe(2);
      expect((await store.load())?.version).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps overlapping event mutations scoped to their explicit event keys", async () => {
    let saved: NotificationDeliveryProgressState | undefined;
    const store: NotificationDeliveryProgressStore = {
      load: async () => (saved ? structuredClone(saved) : undefined),
      save: async (state) => {
        saved = structuredClone(state);
      },
    };
    const progress = new NotificationDeliveryProgress(store);
    const firstEvent = `${"e".repeat(32)}:1`;
    const secondEvent = `${"e".repeat(32)}:2`;
    const firstTarget = notificationTargetProgressKey("wechat", "first");
    const secondTarget = notificationTargetProgressKey("wechat", "second");

    await Promise.all([progress.begin(firstEvent), progress.begin(secondEvent)]);
    // Deliberately write the older event after the newer event has begun. A
    // global "current event" pointer would put both markers in secondEvent.
    await Promise.all([
      progress.mark(firstEvent, firstTarget, 1, 0),
      progress.mark(secondEvent, secondTarget, 2, 1),
    ]);

    expect(progress.chunkIndex(firstEvent, firstTarget)).toBe(1);
    expect(progress.chunkIndex(firstEvent, secondTarget)).toBe(0);
    expect(progress.chunkIndex(secondEvent, firstTarget)).toBe(0);
    expect(progress.chunkIndex(secondEvent, secondTarget)).toBe(2);
    expect(saved?.events[firstEvent]?.chunks[firstTarget]).toBe(1);
    expect(saved?.events[secondEvent]?.chunks[secondTarget]).toBe(2);
  });

  test("migrates v2 all-attachments markers without replaying old media", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-notification-v2-"));
    const path = join(root, "progress.json");
    const store = new FileNotificationDeliveryProgressStore(path);
    const eventKey = `${"d".repeat(32)}:3`;
    const targetKey = notificationTargetProgressKey("telegram", "owner");
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 2,
          events: {
            [eventKey]: {
              chunks: { [targetKey]: 1 },
              attachments: [targetKey],
            },
          },
        }),
        { mode: 0o600 },
      );
      const progress = new NotificationDeliveryProgress(store);
      await progress.begin(eventKey);
      expect(progress.chunkIndex(eventKey, targetKey)).toBe(1);
      expect(progress.attachmentIndex(eventKey, targetKey)).toBe(4);
      await progress.flush();
      expect((await store.load())?.version).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed on malformed or overly-permissive progress state", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-notification-invalid-"));
    const path = join(root, "progress.json");
    const store = new FileNotificationDeliveryProgressStore(path);
    try {
      await writeFile(path, "{}", { mode: 0o600 });
      await expect(store.load()).rejects.toThrow("Invalid notification progress");

      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          eventKey: `${"b".repeat(32)}:8`,
          chunks: {},
          attachments: [],
        }),
        { mode: 0o600 },
      );
      if (process.platform !== "win32") {
        await chmod(path, 0o644);
        await expect(store.load()).rejects.toThrow("permissions must be 0600");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked and oversized progress files before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-notification-unsafe-file-"));
    const path = join(root, "progress.json");
    const target = join(root, "target.json");
    const store = new FileNotificationDeliveryProgressStore(path);
    try {
      await writeFile(target, JSON.stringify({ version: 3, events: {} }), { mode: 0o600 });
      await symlink(target, path);
      await expect(store.load()).rejects.toThrow("not a file");

      await rm(path);
      await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
      await expect(store.load()).rejects.toThrow("too large");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to persist progress through a symlinked parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-notification-unsafe-parent-"));
    const realParent = join(root, "real");
    const linkedParent = join(root, "linked");
    try {
      await mkdir(realParent);
      await symlink(realParent, linkedParent);
      const store = new FileNotificationDeliveryProgressStore(join(linkedParent, "progress.json"));
      const progress = new NotificationDeliveryProgress(store);
      await expect(progress.begin(`${"f".repeat(32)}:1`)).rejects.toThrow(
        "parent is not a regular directory",
      );
      await expect(stat(join(realParent, "progress.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
