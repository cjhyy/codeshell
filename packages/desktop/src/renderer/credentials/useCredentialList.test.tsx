import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useCredentialList } from "./useCredentialList";
import type { MaskedCredentialView } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const credential = (id: string, type: "cookie" | "token" = "cookie"): MaskedCredentialView => ({
  id,
  type,
  label: id,
  hasSecret: true,
});

describe("credential list request ownership", () => {
  let previous: typeof window.codeshell;
  let loads: Array<{ cwd: string } & ReturnType<typeof deferred<MaskedCredentialView[]>>>;
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useCredentialList>>>>;

  beforeEach(() => {
    ensureMiniDom();
    previous = window.codeshell;
    loads = [];
    window.codeshell = {
      credentials: {
        list: (cwd: string) => {
          const next = { cwd, ...deferred<MaskedCredentialView[]>() };
          loads.push(next);
          return next.promise;
        },
      },
    } as typeof window.codeshell;
  });

  afterEach(async () => {
    await hook?.unmount();
    window.codeshell = previous;
  });

  test("initial failure is handled and retry returns the selected credential category", async () => {
    hook = await renderHook(() => useCredentialList("/owned", "token"));
    expect(hook.result.current.loading).toBe(true);
    await act(async () => {
      loads[0].reject(new Error("Owned read failed"));
      await flushMicrotasks();
    });
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.error).toBe("Owned read failed");
    await act(async () => {
      void hook.result.current.reload();
      await flushMicrotasks();
    });
    expect(hook.result.current.loading).toBe(true);
    await act(async () => {
      loads[1].resolve([credential("cookie"), credential("token", "token")]);
      await flushMicrotasks();
    });
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["token"]);
    expect(hook.result.current.error).toBe("");
  });

  test("a refresh failure keeps the last successful snapshot and an older success cannot clear it", async () => {
    hook = await renderHook(() => useCredentialList("/owned", "cookie"));
    await act(async () => {
      loads[0].resolve([credential("saved")]);
      await flushMicrotasks();
      void hook.result.current.reload();
      void hook.result.current.reload();
      await flushMicrotasks();
    });
    await act(async () => {
      loads[2].reject(new Error("Latest refresh failed"));
      await flushMicrotasks();
      loads[1].resolve([credential("outdated")]);
      await flushMicrotasks();
    });
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["saved"]);
    expect(hook.result.current.error).toBe("Latest refresh failed");
    expect(hook.result.current.loading).toBe(false);
  });

  test("project changes immediately hide prior items and fence late reads and old reload callbacks", async () => {
    let cwd = "/first";
    hook = await renderHook(() => useCredentialList(cwd, "cookie"));
    const firstReload = hook.result.current.reload;
    await act(async () => {
      loads[0].resolve([credential("first")]);
      await flushMicrotasks();
      void firstReload();
      await flushMicrotasks();
    });
    cwd = "/second";
    await hook.rerender();
    expect(hook.result.current.items).toEqual([]);
    expect(loads.map((load) => load.cwd)).toEqual(["/first", "/first", "/second"]);
    await act(async () => {
      loads[2].resolve([credential("second")]);
      loads[1].resolve([credential("first-late")]);
      await flushMicrotasks();
      expect(await firstReload()).toBe(false);
    });
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["second"]);
    expect(loads).toHaveLength(3);
    cwd = "/first";
    await hook.rerender();
    await act(async () => expect(await firstReload()).toBe(false));
    expect(loads).toHaveLength(4);
  });

  test("unmount invalidates pending reads and mutation-triggered reloads", async () => {
    hook = await renderHook(() => useCredentialList("/owned", "cookie"));
    const reload = hook.result.current.reload;
    await hook.unmount();
    loads[0].reject(new Error("Late failure"));
    await flushMicrotasks();
    expect(await reload()).toBe(false);
    expect(loads).toHaveLength(1);
  });
});
