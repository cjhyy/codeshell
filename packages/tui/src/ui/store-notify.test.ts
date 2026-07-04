import { describe, test, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { chatStore } from "./store.js";

// Regression: notify() looped listeners without isolation, so one throwing
// listener aborted the loop and the rest missed the update (review-2026-05-30).

describe("chatStore.notify error isolation", () => {
  let errSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    chatStore.setEntries([]);
  });

  test("a throwing listener does not prevent others from being notified", () => {
    let goodCalls = 0;
    const unsubBad = chatStore.subscribe(() => {
      throw new Error("boom");
    });
    const unsubGood = chatStore.subscribe(() => {
      goodCalls++;
    });
    try {
      // append() triggers notify(); must not throw and must reach the good one.
      expect(() => chatStore.append({ role: "user", text: "hi" } as never)).not.toThrow();
      expect(goodCalls).toBe(1);
    } finally {
      unsubBad();
      unsubGood();
    }
  });

  test("update returning the same entries reference does not notify", () => {
    chatStore.setEntries([]);
    let calls = 0;
    const unsub = chatStore.subscribe(() => {
      calls++;
    });
    try {
      chatStore.update((prev) => prev);
      expect(calls).toBe(0);
    } finally {
      unsub();
    }
  });

  test("commitInterruptedStreaming is quiet when nothing changes", () => {
    chatStore.setEntries([]);
    chatStore.append({ type: "user", text: "hi" });

    let calls = 0;
    const unsub = chatStore.subscribe(() => {
      calls++;
    });
    try {
      chatStore.commitInterruptedStreaming("...");
      expect(calls).toBe(0);
    } finally {
      unsub();
    }
  });
});
