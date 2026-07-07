import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cacheGet, cacheSet } from "./settingsCache";
import { useSettingsResource } from "./useSettingsResource";
import { flushMicrotasks, renderHook } from "../test-utils/renderHook";

const KEY = "test:settings-resource:stale";

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

afterEach(() => {
  cacheSet(KEY, undefined);
});

describe("useSettingsResource", () => {
  test("a stale loader result cannot overwrite newer state or cache", async () => {
    const loads: Array<ReturnType<typeof deferred<string>>> = [];
    const loader = () => {
      const next = deferred<string>();
      loads.push(next);
      return next.promise;
    };
    const hook = await renderHook(() => useSettingsResource(KEY, loader, { fallback: "fallback" }));

    expect(hook.result.current.data).toBe("fallback");
    expect(loads).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await flushMicrotasks();
    });
    expect(loads).toHaveLength(2);

    await act(async () => {
      loads[1].resolve("newer");
      await flushMicrotasks();
    });
    expect(hook.result.current.data).toBe("newer");
    expect(cacheGet(KEY)).toBe("newer");

    await act(async () => {
      loads[0].resolve("older");
      await flushMicrotasks();
    });

    expect(hook.result.current.data).toBe("newer");
    expect(cacheGet(KEY)).toBe("newer");
    await hook.unmount();
  });
});
