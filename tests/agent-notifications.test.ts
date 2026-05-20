import { describe, expect, test, beforeEach } from "bun:test";
import { notificationQueue, type NotificationItem } from "../src/tool-system/builtin/agent-notifications.js";

const fixture = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  agentId: "abc12345",
  name: "Explore",
  description: "调研 AI 公司新闻",
  status: "completed",
  finalText: "Found 3 stories.",
  enqueuedAt: 1_700_000_000_000,
  ...overrides,
});

beforeEach(() => {
  notificationQueue.reset();
});

describe("notificationQueue", () => {
  test("starts empty", () => {
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });

  test("enqueue appends to snapshot", () => {
    notificationQueue.enqueue(fixture());
    expect(notificationQueue.getSnapshot()).toHaveLength(1);
    expect(notificationQueue.getSnapshot()[0]!.agentId).toBe("abc12345");
  });

  test("multiple enqueues preserve order", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }));
    notificationQueue.enqueue(fixture({ agentId: "b" }));
    notificationQueue.enqueue(fixture({ agentId: "c" }));
    expect(notificationQueue.getSnapshot().map((i) => i.agentId)).toEqual(["a", "b", "c"]);
  });

  test("drainAll returns all items and clears queue", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }));
    notificationQueue.enqueue(fixture({ agentId: "b" }));
    const drained = notificationQueue.drainAll();
    expect(drained).toHaveLength(2);
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });

  test("drainAll on empty queue returns empty array", () => {
    expect(notificationQueue.drainAll()).toEqual([]);
  });

  test("reset clears queue", () => {
    notificationQueue.enqueue(fixture());
    notificationQueue.reset();
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });

  test("subscribe is notified on enqueue", () => {
    let calls = 0;
    const unsub = notificationQueue.subscribe(() => {
      calls += 1;
    });
    notificationQueue.enqueue(fixture());
    expect(calls).toBe(1);
    notificationQueue.enqueue(fixture());
    expect(calls).toBe(2);
    unsub();
  });

  test("subscribe is notified on drainAll", () => {
    let calls = 0;
    notificationQueue.subscribe(() => {
      calls += 1;
    });
    notificationQueue.enqueue(fixture());
    calls = 0; // reset count after enqueue
    notificationQueue.drainAll();
    expect(calls).toBe(1);
  });

  test("unsubscribe stops notifications", () => {
    let calls = 0;
    const unsub = notificationQueue.subscribe(() => {
      calls += 1;
    });
    unsub();
    notificationQueue.enqueue(fixture());
    expect(calls).toBe(0);
  });
});
