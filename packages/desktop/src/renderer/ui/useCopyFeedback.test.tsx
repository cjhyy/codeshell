import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useCopyFeedback } from "./useCopyFeedback";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const restore: Array<() => void> = [];
let unmount: (() => Promise<void>) | undefined;
let writes: Array<{ text: string; result: ReturnType<typeof deferred> }>;
let timers: Map<number, () => void>;

function replace(object: object, key: PropertyKey, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  });
}

beforeEach(() => {
  ensureMiniDom();
  writes = [];
  timers = new Map();
  replace(globalThis, "navigator", {
    clipboard: {
      writeText: (text: string) => {
        const result = deferred();
        writes.push({ text, result });
        return result.promise;
      },
    },
  });
  replace(window, "isSecureContext", true);
  replace(document, "execCommand", () => false);

  // Only own the hook's feedback timers; React's scheduling remains untouched.
  const setTimeoutBefore = globalThis.setTimeout;
  const clearTimeoutBefore = globalThis.clearTimeout;
  let nextId = -1;
  replace(
    globalThis,
    "setTimeout",
    (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      if (ms !== 1500) return setTimeoutBefore(callback, ms, ...args);
      const id = nextId--;
      timers.set(id, () => callback(...args));
      return id;
    },
  );
  replace(globalThis, "clearTimeout", (id: ReturnType<typeof setTimeout>) => {
    if (typeof id === "number" && timers.delete(id)) return;
    clearTimeoutBefore(id);
  });
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  for (const reset of restore.splice(0).reverse()) reset();
});

async function mount(resetKey?: () => unknown) {
  const hook = await renderHook(() => useCopyFeedback(resetKey?.()));
  unmount = hook.unmount;
  const startCopy = async (text: string) => {
    let result!: Promise<boolean>;
    await act(async () => {
      result = hook.result.current.copy(text);
      await flushMicrotasks();
    });
    return { result };
  };
  const finish = async (index: number, success: boolean) => {
    await act(async () => {
      if (success) writes[index].result.resolve();
      else writes[index].result.reject(new Error("Clipboard permission denied"));
      await flushMicrotasks();
    });
  };
  return { ...hook, startCopy, finish };
}

describe("useCopyFeedback", () => {
  test("reports success only once the clipboard write finishes and clears the feedback", async () => {
    const hook = await mount();
    const copy = await hook.startCopy("copy this");
    expect(writes[0].text).toBe("copy this");
    expect(hook.result.current.copied).toBe(false);
    expect(timers.size).toBe(0);
    await hook.finish(0, true);
    expect(await copy.result).toBe(true);
    expect(hook.result.current.copied).toBe(true);
    expect(timers.size).toBe(1);
    await act(async () => {
      const [id, expire] = [...timers.entries()][0];
      timers.delete(id);
      expire();
      await flushMicrotasks();
    });
    expect(hook.result.current.copied).toBe(false);
  });

  test("does not show success when both clipboard paths fail", async () => {
    const hook = await mount();
    const copy = await hook.startCopy("cannot copy");
    await hook.finish(0, false);
    expect(await copy.result).toBe(false);
    expect(hook.result.current.copied).toBe(false);
    expect(timers.size).toBe(0);
  });

  test("ignores an older success after the most recent copy has failed", async () => {
    const hook = await mount();
    const older = await hook.startCopy("older");
    const newer = await hook.startCopy("newer");
    await hook.finish(1, false);
    await hook.finish(0, true);
    expect(await newer.result).toBe(false);
    expect(await older.result).toBe(true);
    expect(hook.result.current.copied).toBe(false);
    expect(timers.size).toBe(0);
  });

  test("an older failure cannot clear a newer successful copy", async () => {
    const hook = await mount();
    await hook.startCopy("older");
    await hook.startCopy("newer");
    await hook.finish(1, true);
    const successTimer = [...timers.keys()][0];
    await hook.finish(0, false);
    expect(hook.result.current.copied).toBe(true);
    expect([...timers.keys()]).toEqual([successTimer]);
  });

  test("repeated copy replaces the old feedback timer", async () => {
    const hook = await mount();
    await hook.startCopy("first");
    await hook.finish(0, true);
    const previousTimer = [...timers.keys()][0];
    await hook.startCopy("second");
    expect(hook.result.current.copied).toBe(false);
    expect(timers.size).toBe(0);
    await hook.finish(1, true);
    expect(timers.size).toBe(1);
    expect([...timers.keys()][0]).not.toBe(previousTimer);
  });

  test("changing resetKey clears prior success and ignores a pending result for the old item", async () => {
    let resetKey = "image-a";
    const hook = await mount(() => resetKey);
    await hook.startCopy("first path");
    await hook.finish(0, true);
    resetKey = "image-b";
    await hook.rerender();
    expect(hook.result.current.copied).toBe(false);
    expect(timers.size).toBe(0);

    const pending = await hook.startCopy("second path");
    resetKey = "image-c";
    await hook.rerender();
    await hook.finish(1, true);
    expect(await pending.result).toBe(true);
    expect(hook.result.current.copied).toBe(false);
    expect(timers.size).toBe(0);
  });

  test("unmount cancels feedback and delayed clipboard completion cannot schedule another timer", async () => {
    const hook = await mount();
    await hook.startCopy("first");
    await hook.finish(0, true);
    expect(timers.size).toBe(1);
    await hook.unmount();
    expect(timers.size).toBe(0);

    const pendingHook = await mount();
    const pending = await pendingHook.startCopy("pending");
    await pendingHook.unmount();
    await pendingHook.finish(1, true);
    expect(await pending.result).toBe(true);
    expect(timers.size).toBe(0);
  });
});
