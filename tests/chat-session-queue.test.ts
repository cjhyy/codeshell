import { describe, it, expect } from "bun:test";
import { ChatSession } from "../packages/core/src/protocol/chat-session.ts";

const fakeEngine: any = {
  run: async (task: string) => {
    // Simulate a slow turn so we can observe queueing.
    await new Promise((r) => setTimeout(r, 30));
    return { text: `done:${task}`, reason: "completed", sessionId: "s1", turnCount: 1, usage: {} };
  },
  permissionMode: "default",
  planMode: false,
};

describe("ChatSession", () => {
  it("runs a single turn", async () => {
    const s = new ChatSession({ id: "s1", engine: fakeEngine });
    const result = await s.enqueueTurn("hello", {});
    expect(result.text).toBe("done:hello");
    expect(s.isBusy()).toBe(false);
  });

  it("serializes turns from the same session", async () => {
    const s = new ChatSession({ id: "s1", engine: fakeEngine });
    const order: string[] = [];
    const a = s.enqueueTurn("a", {}).then((r) => order.push(r.text));
    const b = s.enqueueTurn("b", {}).then((r) => order.push(r.text));
    expect(s.queueDepth()).toBe(1); // a running, b queued
    await Promise.all([a, b]);
    expect(order).toEqual(["done:a", "done:b"]);
  });

  it("cancel aborts in-flight turn", async () => {
    const slowEngine: any = {
      run: async (_task: string, opts: any) => {
        await new Promise((resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(resolve, 5000);
        });
        return { text: "never", reason: "completed", sessionId: "s1", turnCount: 1, usage: {} };
      },
      permissionMode: "default",
      planMode: false,
    };
    const s = new ChatSession({ id: "s1", engine: slowEngine });
    const p = s.enqueueTurn("slow", {});
    setTimeout(() => s.cancel(), 10);
    await expect(p).rejects.toThrow(/aborted/);
  });
});
