import { describe, test, expect } from "bun:test";
import { drainBackgroundNotifications } from "./drain-notifications.js";
import type { NotificationItem } from "@cjhyy/code-shell-core";

// Minimal fakes for the two process-global singletons the drainer consults.
function fakeQueue(items: NotificationItem[]) {
  let drained = false;
  return {
    drainAll(_sid: string): NotificationItem[] {
      if (drained) return [];
      drained = true;
      return items;
    },
    get wasDrained() {
      return drained;
    },
  };
}

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    agentId: "a1",
    description: "background task",
    status: "completed",
    finalText: "done",
    enqueuedAt: 1,
    ...over,
  };
}

describe("drainBackgroundNotifications", () => {
  test("returns enqueued items and drains the queue atomically", async () => {
    const queue = fakeQueue([item(), item({ agentId: "a2" })]);
    const out = await drainBackgroundNotifications("sid", {
      queue,
      hasRunning: () => false,
      wait: false,
    });
    expect(out).toHaveLength(2);
    expect(queue.wasDrained).toBe(true);
  });

  test("with wait=false it does not wait even if agents are running", async () => {
    const queue = fakeQueue([]);
    const start = performance.now();
    const out = await drainBackgroundNotifications("sid", {
      queue,
      hasRunning: () => true, // would block forever if respected
      wait: false,
      timeoutMs: 5000,
    });
    expect(out).toEqual([]);
    expect(performance.now() - start).toBeLessThan(200);
  });

  test("with wait=true it polls until no agents are running, then drains", async () => {
    let ticks = 0;
    const late = [item({ agentId: "late" })];
    const queue = fakeQueue(late);
    const out = await drainBackgroundNotifications("sid", {
      queue,
      // running for the first couple polls, then settles.
      hasRunning: () => ++ticks < 3,
      wait: true,
      timeoutMs: 2000,
      pollMs: 5,
    });
    expect(out.map((i) => i.agentId)).toEqual(["late"]);
  });

  test("with wait=true it gives up at the timeout and still drains what arrived", async () => {
    const queue = fakeQueue([item({ agentId: "partial" })]);
    const start = performance.now();
    const out = await drainBackgroundNotifications("sid", {
      queue,
      hasRunning: () => true, // never settles
      wait: true,
      timeoutMs: 40,
      pollMs: 5,
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    // It still drains whatever the queue held at timeout.
    expect(out.map((i) => i.agentId)).toEqual(["partial"]);
  });
});
