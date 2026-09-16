import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { PanelAppExtensionSummary, PanelAppUpdateCheck } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { usePanelAppUpdates } from "./usePanelAppUpdates";

function app(id = "video-studio", version = "0.6.2"): PanelAppExtensionSummary {
  return {
    id: `panel-app:${id}`,
    appId: id,
    title: id,
    version,
    revision: `revision-${version}`,
    hostId: id,
    kind: "panel-app",
    icon: "panel",
    singleton: true,
    permissions: [],
    enabled: false,
    projectBound: false,
    updateSource: { kind: "git", label: "owner/panels", available: true },
  };
}

function result(id = "video-studio", currentVersion = "0.6.2"): PanelAppUpdateCheck {
  return {
    id,
    currentVersion,
    latestVersion: "0.6.3",
    status: currentVersion === "0.6.3" ? "up-to-date" : "update-available",
    checkedAt: "2026-09-16T10:00:00.000Z",
    sourceKind: "git",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Panel App update discovery", () => {
  let hook:
    | Awaited<ReturnType<typeof renderHook<ReturnType<typeof usePanelAppUpdates>>>>
    | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let apps: PanelAppExtensionSummary[] | null;
  let calls: Array<[string, boolean | undefined]>;
  let check: (id: string, force?: boolean) => Promise<PanelAppUpdateCheck>;

  beforeEach(() => {
    ensureMiniDom();
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    apps = [app()];
    calls = [];
    check = async (id) => result(id);
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        checkPanelAppUpdate: (id: string, force?: boolean) => {
          calls.push([id, force]);
          return check(id, force);
        },
      },
    });
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("checks on entry and exposes an available version without an install request", async () => {
    hook = await renderHook(() => usePanelAppUpdates(apps));
    expect(calls).toEqual([["video-studio", false]]);
    expect(hook.result.current.availableCount).toBe(1);
    expect(hook.result.current.results["video-studio"]).toEqual(result());
    expect(hook.result.current.checking).toBe(false);
  });

  test("bounds requests to two even while the installed catalog changes", async () => {
    const waiting = Array.from({ length: 4 }, () => deferred<PanelAppUpdateCheck>());
    apps = [app("one"), app("two"), app("three")];
    check = () => waiting[calls.length - 1]!.promise;
    hook = await renderHook(() => usePanelAppUpdates(apps));
    expect(calls.map(([id]) => id)).toEqual(["one", "two"]);

    apps = [app("replacement"), app("four")];
    await hook.rerender();
    expect(calls).toHaveLength(2);
    await act(async () => {
      waiting[0]!.resolve(result("one"));
      await flushMicrotasks();
    });
    expect(calls.map(([id]) => id)).toEqual(["one", "two", "replacement"]);
    expect(hook.result.current.results.one).toBeUndefined();

    await act(async () => {
      waiting[1]!.resolve(result("two"));
      waiting[2]!.resolve(result("replacement"));
      await flushMicrotasks();
    });
    expect(calls.map(([id]) => id)).toEqual(["one", "two", "replacement", "four"]);
    await act(async () => {
      waiting[3]!.resolve(result("four"));
      await flushMicrotasks();
    });
    expect(hook.result.current.availableCount).toBe(2);
  });

  test("keeps a network failure distinct from the latest-version state", async () => {
    check = async () => {
      throw new Error("Network unavailable");
    };
    hook = await renderHook(() => usePanelAppUpdates(apps));
    expect(hook.result.current.availableCount).toBe(0);
    expect(hook.result.current.results["video-studio"]).toMatchObject({
      status: "error",
      message: "Network unavailable",
    });
  });

  test("a new installed version clears the badge and ignores the older check response", async () => {
    const previous = deferred<PanelAppUpdateCheck>();
    check = () =>
      calls.length === 1 ? previous.promise : Promise.resolve(result(undefined, "0.6.3"));
    hook = await renderHook(() => usePanelAppUpdates(apps));
    apps = [app("video-studio", "0.6.3")];
    await hook.rerender();
    expect(hook.result.current.results["video-studio"]?.status).toBe("up-to-date");
    await act(async () => {
      previous.resolve(result());
      await flushMicrotasks();
    });
    expect(hook.result.current.availableCount).toBe(0);
    expect(hook.result.current.results["video-studio"]?.currentVersion).toBe("0.6.3");
  });

  test("invalidation rejects a pending result even for a same-version reinstall", async () => {
    const previous = deferred<PanelAppUpdateCheck>();
    check = () => previous.promise;
    hook = await renderHook(() => usePanelAppUpdates(apps));
    await act(async () => {
      hook!.result.current.invalidate();
      previous.resolve(result());
      await flushMicrotasks();
    });
    expect(hook.result.current.results).toEqual({});
    expect(hook.result.current.checking).toBe(false);
    check = async () => ({ ...result(), status: "up-to-date", latestVersion: "0.6.2" });
    apps = [...apps!];
    await hook.rerender();
    expect(hook.result.current.availableCount).toBe(0);
    expect(hook.result.current.results["video-studio"]?.status).toBe("up-to-date");
  });

  test("focus uses the shared cache while an explicit retry bypasses it", async () => {
    hook = await renderHook(() => usePanelAppUpdates(apps));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    await act(async () => {
      hook!.result.current.checkAll(true);
      await flushMicrotasks();
    });
    expect(calls).toEqual([
      ["video-studio", false],
      ["video-studio", false],
      ["video-studio", true],
    ]);
  });

  test("replacing the update source invalidates the former remote result", async () => {
    const previous = deferred<PanelAppUpdateCheck>();
    check = () =>
      calls.length === 1
        ? previous.promise
        : Promise.resolve({ ...result(), sourceKind: "zip", status: "unsupported" });
    hook = await renderHook(() => usePanelAppUpdates(apps));
    apps = [{ ...app(), updateSource: { kind: "zip", label: "panel.zip", available: true } }];
    await hook.rerender();
    await act(async () => {
      previous.resolve(result());
      await flushMicrotasks();
    });
    expect(hook.result.current.availableCount).toBe(0);
    expect(hook.result.current.results["video-studio"]?.sourceKind).toBe("zip");
  });
});
