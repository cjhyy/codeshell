import { describe, test, expect, spyOn } from "bun:test";
import { RunQueue } from "./RunQueue.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

// The dedup/lookup paths now use a Set mirroring the pending array
// (review-2026-05-30, O(n) includes). Behavior — dedup, FIFO order, cancel —
// must be unchanged.

describe("RunQueue", () => {
  test("starts previously queued work when an executor is installed", async () => {
    const order: string[] = [];
    const q = new RunQueue();
    q.enqueue("before-executor");
    await tick();
    expect(q.pendingCount).toBe(1);

    q.setExecutor(async (id) => {
      order.push(id);
    });
    await tick();

    expect(order).toEqual(["before-executor"]);
    expect(q.pendingCount).toBe(0);
    expect(q.activeCount).toBe(0);
  });

  test("a synchronous executor failure releases capacity for the next run", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const order: string[] = [];
      const q = new RunQueue();
      q.setExecutor((id) => {
        order.push(id);
        if (id === "broken") throw new Error("failed before promise creation");
        return Promise.resolve();
      });
      q.enqueue("broken");
      q.enqueue("next");
      await tick();

      expect(order).toEqual(["broken", "next"]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(q.activeCount).toBe(0);
      expect(q.pendingCount).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  test("dedups enqueues and preserves FIFO order", async () => {
    const order: string[] = [];
    const q = new RunQueue({ concurrency: 1 });
    q.setExecutor(async (id) => {
      order.push(id);
    });
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("a"); // duplicate — ignored
    q.enqueue("c");
    await tick();
    await tick();
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("isPending reflects membership and cancel removes it", () => {
    const q = new RunQueue({ concurrency: 0 }); // never drains, stays pending
    q.setExecutor(async () => {});
    q.enqueue("x");
    expect(q.isPending("x")).toBe(true);
    expect(q.pendingCount).toBe(1);
    expect(q.cancel("x")).toBe(true);
    expect(q.isPending("x")).toBe(false);
    expect(q.pendingCount).toBe(0);
    // Re-enqueue works after cancel (set was cleaned).
    q.enqueue("x");
    expect(q.isPending("x")).toBe(true);
  });
});
