import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import type { PanelAppDescriptor } from "../../shared/panel-apps";
import { getEnabledPanelEntries, getPanelEntry, replacePanelApps } from "../panels/PanelRegistry";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { usePanelAppCatalog } from "./usePanelAppCatalog";

type Snapshot = Awaited<ReturnType<typeof window.codeshell.listPanelAppsForProjects>>;
type Api = Partial<
  Pick<typeof window.codeshell, "listPanelApps" | "listPanelAppsForProjects" | "onPanelAppsChanged">
>;

function descriptor(hostId = "studio-v1"): PanelAppDescriptor {
  return {
    id: "panel-app:studio",
    appId: "studio",
    title: hostId,
    version: hostId,
    icon: "palette",
    singleton: true,
    permissions: [],
    hostId,
    revision: hostId,
  };
}

function snapshot(paths: string[], hostId = "studio-v1"): Snapshot {
  return {
    descriptors: [{ ...descriptor(hostId), projectPaths: paths }],
    boundProjectPathsByAppId: { studio: paths },
  };
}

function enabled(projectPath: string): string[] {
  return getEnabledPanelEntries({ projectPath })
    .filter((entry) => entry.owner.kind === "panel-app")
    .map((entry) => (entry.title.kind === "literal" ? entry.title.value : entry.key));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Panel App catalog loading", () => {
  let savedBridge: PropertyDescriptor | undefined;
  let api: Api;
  let paths: string[];
  let activePath: string | null;
  let locale: string;
  let listeners: Set<() => void>;
  let hook:
    | Awaited<ReturnType<typeof renderHook<ReturnType<typeof usePanelAppCatalog>>>>
    | undefined;

  beforeEach(() => {
    ensureMiniDom();
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    paths = ["/a"];
    activePath = "/a";
    locale = "zh-CN";
    listeners = new Set();
    api = {
      listPanelAppsForProjects: mock(async (projectPaths) => snapshot(projectPaths)),
      onPanelAppsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    Object.defineProperty(window, "codeshell", { configurable: true, value: api });
    replacePanelApps([], null);
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    replacePanelApps([], null);
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  async function mount() {
    hook = await renderHook(() =>
      usePanelAppCatalog({
        projectPaths: paths,
        activeProjectPath: activePath,
        locale,
      }),
    );
  }

  test("keeps a successful batch's exact project and version selection", async () => {
    paths = ["/a", "/b"];
    api.listPanelAppsForProjects = async () => ({
      descriptors: [
        { ...descriptor("v1"), projectPaths: ["/a", "/canonical-a"] },
        { ...descriptor("v2"), projectPaths: ["/b"] },
      ],
      boundProjectPathsByAppId: { studio: ["/a", "/canonical-a", "/b"] },
    });
    await mount();
    expect(enabled("/a")).toEqual(["v1"]);
    expect(enabled("/canonical-a")).toEqual(["v1"]);
    expect(enabled("/b")).toEqual(["v2"]);
    expect(enabled("/unknown")).toEqual([]);
    expect(hook!.result.current).toMatchObject({ loading: false, error: null });
  });

  test("isolates a rejected project after a batch failure and merges shared and distinct variants", async () => {
    paths = ["/a", "/alias", "/bad", "/b"];
    replacePanelApps([descriptor("stale")], "/bad");
    const read = mock(async (requested: string[]) => {
      if (requested.length > 1) throw new Error("batch contains a stale project");
      const [path] = requested;
      if (path === "/bad") throw new Error("project is not registered");
      // Omitted per-variant projectPaths must be captured before the app-wide
      // binding maps merge, or v1 and v2 would both become enabled everywhere.
      return {
        descriptors: [descriptor(path === "/b" ? "v2" : "v1")],
        boundProjectPathsByAppId: { studio: [path!] },
      };
    });
    api.listPanelAppsForProjects = read;
    await mount();
    expect(read).toHaveBeenCalledTimes(5);
    expect(enabled("/a")).toEqual(["v1"]);
    expect(enabled("/alias")).toEqual(["v1"]);
    expect(enabled("/b")).toEqual(["v2"]);
    expect(enabled("/bad")).toEqual([]);
    expect(hook!.result.current.loading).toBe(false);
    expect(hook!.result.current.error).toContain("/bad: project is not registered");
  });

  test("keeps entries only while retrying, clears them on total failure, then recovers", async () => {
    await mount();
    const pending = deferred<Snapshot>();
    api.listPanelAppsForProjects = mock(() => pending.promise);
    // The hook captures the bridge object, so implementations may be updated
    // without reconstructing the mounted application.
    await act(async () => hook!.result.current.refresh());
    // A healthy catalog refreshes in the background instead of re-entering loading.
    expect(hook!.result.current).toMatchObject({ loading: false, refreshing: true });
    expect(enabled("/a")).toEqual(["studio-v1"]);
    await act(async () => pending.resolve(snapshot(["/a"], "v2")));
    expect(enabled("/a")).toEqual(["v2"]);
    expect(hook!.result.current).toMatchObject({ loading: false, refreshing: false });

    api.listPanelAppsForProjects = async () => {
      throw new Error("host unavailable");
    };
    await act(async () => hook!.result.current.refresh());
    expect(enabled("/a")).toEqual([]);
    expect(getPanelEntry("panel-app:studio")).toBeUndefined();
    expect(hook!.result.current).toMatchObject({ loading: false });
    expect(hook!.result.current.error).toContain("host unavailable");

    const retry = deferred<Snapshot>();
    api.listPanelAppsForProjects = mock(() => retry.promise);
    await act(async () => window.dispatchEvent(new Event("focus")));
    // After a failure there is no trustworthy catalog, so the retry is a real load.
    expect(hook!.result.current).toMatchObject({ loading: true, refreshing: false, error: null });
    await act(async () => retry.resolve(snapshot(["/a"], "recovered")));
    expect(enabled("/a")).toEqual(["recovered"]);
    expect(hook!.result.current.error).toBeNull();
  });

  test("loads legacy array responses without treating a missing binding map as deny-all", async () => {
    paths = ["/a", "/b"];
    delete api.listPanelAppsForProjects;
    api.listPanelApps = mock(async (path) => [descriptor(path === "/a" ? "v1" : "v2")]);
    await mount();
    expect(api.listPanelApps).toHaveBeenCalledTimes(2);
    expect(enabled("/a")).toEqual(["v1"]);
    expect(enabled("/b")).toEqual(["v2"]);
    expect(enabled("/other")).toEqual([]);
    expect(hook!.result.current.error).toBeNull();
  });

  test("loads with only the batch read API and no change subscription", async () => {
    delete api.onPanelAppsChanged;
    await mount();
    expect(enabled("/a")).toEqual(["studio-v1"]);
    expect(hook!.result.current).toMatchObject({ loading: false, error: null });
  });

  test("coalesces refreshes in flight and does not retry healthy catalogs on focus", async () => {
    const first = deferred<Snapshot>();
    const read = mock(async () => snapshot(["/a"], "latest"));
    read.mockImplementationOnce(() => first.promise);
    api.listPanelAppsForProjects = read;
    await mount();
    expect(hook!.result.current.loading).toBe(true);
    await act(async () => {
      hook!.result.current.refresh();
      hook!.result.current.refresh();
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(snapshot(["/a"], "initial")));
    expect(enabled("/a")).toEqual(["initial"]);
    await act(async () => hook!.result.current.refresh());
    expect(enabled("/a")).toEqual(["latest"]);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("ignores a pending result after project scope changes or unmount", async () => {
    const first = deferred<Snapshot>();
    const last = deferred<Snapshot>();
    const read = mock(async (requested: string[]) => {
      if (requested[0] === "/a") return first.promise;
      if (requested[0] === "/last") return last.promise;
      return snapshot(requested, "current-project");
    });
    api.listPanelAppsForProjects = read;
    await mount();
    await act(async () => {
      for (const listener of listeners) listener();
    });
    paths = ["/b"];
    activePath = "/b";
    await hook!.rerender();
    await act(async () => first.resolve(snapshot(["/a"], "old-project")));
    expect(enabled("/a")).toEqual([]);
    expect(enabled("/b")).toEqual(["current-project"]);
    paths = ["/last"];
    activePath = "/last";
    await hook!.rerender();
    await act(async () => {
      for (const listener of listeners) listener();
    });
    await hook!.unmount();
    hook = undefined;
    replacePanelApps([], null);
    await act(async () => last.resolve(snapshot(["/last"], "late")));
    expect(enabled("/last")).toEqual([]);
    expect(listeners.size).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  test("re-reads once after host changes during loading so updates and revocations win", async () => {
    const first = deferred<Snapshot>();
    const third = deferred<Snapshot>();
    const read = mock(async () => ({ descriptors: [], boundProjectPathsByAppId: {} }) as Snapshot);
    read.mockImplementationOnce(() => first.promise);
    read.mockImplementationOnce(async () => snapshot(["/a"], "updated"));
    read.mockImplementationOnce(() => third.promise);
    api.listPanelAppsForProjects = read;
    await mount();
    await act(async () => {
      for (const listener of listeners) {
        listener();
        listener();
      }
      hook!.result.current.refresh();
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(snapshot(["/a"], "stale")));
    expect(read).toHaveBeenCalledTimes(2);
    expect(enabled("/a")).toEqual(["updated"]);

    await act(async () => hook!.result.current.refresh());
    await act(async () => {
      for (const listener of listeners) {
        listener();
        listener();
      }
    });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => third.resolve(snapshot(["/a"], "revoked")));
    expect(read).toHaveBeenCalledTimes(4);
    expect(enabled("/a")).toEqual([]);
    expect(hook!.result.current).toMatchObject({ loading: false, error: null });
  });

  test("restarts on locale changes and rejects the previous locale's late response", async () => {
    const pending = deferred<Snapshot>();
    const read = mock(async (_paths: string[], requestedLocale: string) => {
      if (requestedLocale === "zh-CN") return pending.promise;
      return snapshot(["/a"], "English title");
    });
    api.listPanelAppsForProjects = read;
    await mount();
    locale = "en";
    await hook!.rerender();
    expect(read).toHaveBeenCalledTimes(2);
    expect(enabled("/a")).toEqual(["English title"]);
    await act(async () => pending.resolve(snapshot(["/a"], "Previous title")));
    expect(enabled("/a")).toEqual(["English title"]);
    expect(hook!.result.current).toMatchObject({ loading: false, error: null });
  });

  test("refreshes on host changes and allows manual refresh of a successful empty catalog", async () => {
    api.listPanelAppsForProjects = async () => ({ descriptors: [], boundProjectPathsByAppId: {} });
    await mount();
    expect(hook!.result.current.error).toBeNull();
    expect(enabled("/a")).toEqual([]);
    api.listPanelAppsForProjects = async () => snapshot(["/a"], "manual");
    await act(async () => hook!.result.current.refresh());
    expect(enabled("/a")).toEqual(["manual"]);
    api.listPanelAppsForProjects = async () => snapshot(["/a"], "changed");
    await act(async () => {
      for (const listener of listeners) listener();
    });
    expect(enabled("/a")).toEqual(["changed"]);
  });

  test("reports a missing read API and clears previously registered entries", async () => {
    replacePanelApps([descriptor()], "/a");
    delete api.listPanelAppsForProjects;
    await mount();
    expect(enabled("/a")).toEqual([]);
    expect(hook!.result.current.loading).toBe(false);
    expect(hook!.result.current.error).toContain("catalog is unavailable");
  });
});
