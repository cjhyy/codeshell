import { describe, expect, test } from "bun:test";
import { NotificationDeliveryProgress, notificationTargetProgressKey, type NotificationDeliveryProgressState, type NotificationDeliveryProgressStore } from "../../../packages/chat/src/notification-progress.js";
import { createDesktopNotificationHandler, splitNotificationText } from "../../../packages/chat/src/notification-relay.js";
import { DesktopControlClient } from "../../../packages/chat/src/desktop-control-client.js";
import type { ChannelAdapter } from "../../../packages/chat/src/channel.js";

const streamId = "a".repeat(32);
const event = { id: 1, createdAt: 1, type: "tunnel.connected" as const, text: "ordinary notification" };
const targets = [{ channel: "test", target: "owned-memory-target" }];

function memoryStore(failFirstLoad = false) {
  let loads = 0;
  let saves = 0;
  let state: NotificationDeliveryProgressState | undefined;
  const store: NotificationDeliveryProgressStore = {
    async load() {
      loads += 1;
      if (failFirstLoad && loads === 1) throw new Error("simulated transient read error");
      return state ? structuredClone(state) : undefined;
    },
    async save(value) {
      saves += 1;
      state = structuredClone(value);
    },
  };
  return { store, loads: () => loads, saves: () => saves, state: () => state };
}

// Execute the actual sequential watcher loop with only its page/sleep callbacks
// substituted. No client constructor/request/descriptor, socket, process,
// filesystem checkpoint, platform adapter, credentials, or network is used.
async function watchMemoryPages(handle: Parameters<DesktopControlClient["watchEvents"]>[1],
  controller: AbortController, onError: (error: unknown) => void) {
  const cursors: number[] = [];
  const delays: number[] = [];
  const receiver = {
    async events(after: number) {
      cursors.push(after);
      return { streamId, events: [event], cursor: event.id };
    },
    async sleepFn(ms: number) { delays.push(ms); },
  };
  await DesktopControlClient.prototype.watchEvents.call(receiver as unknown as DesktopControlClient,
    controller.signal, handle, { retryBaseMs: 1, retryMaxMs: 4, onError });
  return { cursors, delays };
}

describe("audit ordinary notification progress read recovery", () => {
  test("same handler replays the cached initial load rejection after the store would recover", async () => {
    const memory = memoryStore(true);
    let sends = 0;
    const adapter: ChannelAdapter = { channel: "test", run: async () => {}, send: async () => { sends += 1; } };
    const handle = createDesktopNotificationHandler([adapter], targets, { progressStore: memory.store });
    const controller = new AbortController();
    const errors: unknown[] = [];
    const observed = await watchMemoryPages(handle, controller, (error) => {
      errors.push(error);
      if (errors.length === 3) controller.abort();
    });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe(errors[1]);
    expect(errors[1]).toBe(errors[2]);
    expect(memory.loads()).toBe(1);
    expect(memory.saves()).toBe(0);
    expect(sends).toBe(0);
    expect(observed.cursors).toEqual([0, 0, 0]);
    expect(observed.delays).toEqual([1, 2, 4]);

    // The same store's second load is healthy. A new handler can deliver the
    // exact event, so the retained rejected promise is the differentiator.
    const restarted = createDesktopNotificationHandler([adapter], targets, { progressStore: memory.store });
    await restarted(event, { streamId });
    expect(memory.loads()).toBe(2);
    expect(sends).toBe(1);
    expect(memory.saves()).toBe(3);
  });

  test("ordinary initial load succeeds and one event reaches the fake adapter", async () => {
    const memory = memoryStore();
    const controller = new AbortController();
    let sends = 0;
    const adapter: ChannelAdapter = { channel: "test", run: async () => {}, send: async () => {
      sends += 1;
      controller.abort();
    } };
    const errors: unknown[] = [];
    const handle = createDesktopNotificationHandler([adapter], targets, { progressStore: memory.store });
    const observed = await watchMemoryPages(handle, controller, (error) => errors.push(error));
    expect(errors).toEqual([]);
    expect(sends).toBe(1);
    expect(memory.loads()).toBe(1);
    expect(memory.saves()).toBe(3);
    expect(observed.cursors).toEqual([0]);
    expect(observed.delays).toEqual([]);
  });

  test("write failure control can be recovered by the same progress instance", async () => {
    let saves = 0;
    let saved: NotificationDeliveryProgressState | undefined;
    const progress = new NotificationDeliveryProgress({
      load: async () => undefined,
      save: async (value) => {
        saves += 1;
        if (saves === 2) throw new Error("simulated transient write error");
        saved = structuredClone(value);
      },
    });
    const key = `${streamId}:1`;
    const targetKey = notificationTargetProgressKey("test", "owned-memory-target");
    await progress.begin(key);
    await expect(progress.mark(key, targetKey, 1)).rejects.toThrow("transient write error");
    await progress.flush();
    expect(progress.chunkIndex(key, targetKey)).toBe(1);
    expect(saved?.events[key]?.chunks[targetKey]).toBe(1);
    expect(saves).toBe(3);
  });

  test("shared splitter preserves UTF-16 pairs, whitespace and complete text at ordinary boundaries", () => {
    const text = "开始 🐱 alpha\n" + "🧑‍💻 简单文字  \r\n".repeat(160) + "尾部🐱";
    for (const maximum of [2, 17, 1800, 8000]) {
      const parts = splitNotificationText(text, maximum);
      expect(parts.join("")).toBe(text);
      expect(parts.every((part) => part.length <= maximum)).toBe(true);
      expect(parts.every((part) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(part))).toBe(true);
    }
  });
});
