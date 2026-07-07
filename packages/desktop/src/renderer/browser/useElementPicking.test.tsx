import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PICKER_CLEANUP_SCRIPT, PICKER_SCRIPT, type PickedElement } from "./pickerScript";
import { useElementPicking } from "./useElementPicking";
import type { WebviewElement } from "./types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeWebview() {
  const pick = deferred<PickedElement | null>();
  const calls: string[] = [];
  const view = {
    executeJavaScript(code: string): Promise<unknown> {
      calls.push(code);
      if (code === PICKER_SCRIPT) return pick.promise;
      if (code === PICKER_CLEANUP_SCRIPT) return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    },
  } as WebviewElement;
  return { calls, pick, view };
}

let restoreTimeouts: (() => void) | null = null;

afterEach(() => {
  restoreTimeouts?.();
  restoreTimeouts = null;
});

function capturePickerTimeout(): { fire: () => void; cleared: number[] } {
  ensureMiniDom();
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const cleared: number[] = [];
  let callback: (() => void) | null = null;

  window.setTimeout = ((cb: TimerHandler): number => {
    callback = typeof cb === "function" ? cb : () => undefined;
    return 42;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number): void => {
    cleared.push(id);
  }) as typeof window.clearTimeout;
  restoreTimeouts = () => {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  };

  return {
    fire: () => {
      if (!callback) throw new Error("picker timeout was not registered");
      callback();
    },
    cleared,
  };
}

describe("useElementPicking", () => {
  test("runs cleanup when a pick times out", async () => {
    const webview = fakeWebview();
    const timeout = capturePickerTimeout();
    const viewRef = { current: webview.view };
    const hook = await renderHook(() => useElementPicking(viewRef, "https://example.com", "tab-a"));
    let startPromise!: Promise<void>;

    await act(async () => {
      startPromise = hook.result.current.startPicking();
      await flushMicrotasks();
    });
    expect(hook.result.current.selecting).toBe(true);

    await act(async () => {
      timeout.fire();
      await startPromise;
      await flushMicrotasks();
    });

    expect(webview.calls).toContain(PICKER_CLEANUP_SCRIPT);
    expect(timeout.cleared).toContain(42);
    expect(hook.result.current.selecting).toBe(false);
    await hook.unmount();
  });

  test("runs cleanup on tab switch and ignores the stale picker result", async () => {
    const webview = fakeWebview();
    capturePickerTimeout();
    const viewRef = { current: webview.view };
    let activeId = "tab-a";
    const hook = await renderHook(() =>
      useElementPicking(viewRef, "https://example.com", activeId),
    );
    let startPromise!: Promise<void>;

    await act(async () => {
      startPromise = hook.result.current.startPicking();
      await flushMicrotasks();
    });

    activeId = "tab-b";
    await hook.rerender();
    await startPromise;

    expect(webview.calls).toContain(PICKER_CLEANUP_SCRIPT);
    expect(hook.result.current.selecting).toBe(false);

    await act(async () => {
      webview.pick.resolve({
        selector: "button.buy",
        text: "Buy",
        rect: { x: 1, y: 2, width: 3, height: 4 },
        url: "https://example.com/stale",
      });
      await flushMicrotasks();
    });

    expect(hook.result.current.picked).toBeNull();
    await hook.unmount();
  });

  test("runs cleanup on unmount", async () => {
    const webview = fakeWebview();
    capturePickerTimeout();
    const viewRef = { current: webview.view };
    const hook = await renderHook(() => useElementPicking(viewRef, "https://example.com", "tab-a"));
    let startPromise!: Promise<void>;

    await act(async () => {
      startPromise = hook.result.current.startPicking();
      await flushMicrotasks();
    });
    await hook.unmount();
    await startPromise;

    expect(webview.calls).toContain(PICKER_CLEANUP_SCRIPT);
  });
});
