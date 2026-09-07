import { describe, expect, test } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import type { BrowserRuntimeLike } from "./runtime.js";
import {
  dispatchInteractiveBrowserRuntimeAction,
  releaseChildBrowserRuntime,
  activateChildBrowserRuntime,
} from "./dispatch.js";

function runtimeDispatchTestBridge(overrides: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    snapshot: async () => ({ url: "about:blank", elements: [] }),
    click: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    readContent: async () => ({ ok: true, url: "about:blank", text: "" }),
    extractLinks: async () => ({
      ok: true,
      url: "about:blank",
      links: [],
      images: [],
      videos: [],
    }),
    waitForLoad: async () => ({ ok: true }),
    hover: async () => ({ ok: true }),
    selectOption: async () => ({ ok: true }),
    pressKey: async () => ({ ok: true }),
    fetchImages: async () => [],
    screenshot: async () => ({ ok: true }),
    listTabs: async () => [],
    switchTab: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("interactive Browser Runtime dispatch", () => {
  test("reveals the exact task-owned runtime target for human takeover", async () => {
    let shown = 0;
    let released = 0;
    const acquisitions: Array<Record<string, unknown>> = [];
    const runtime: BrowserRuntimeLike = {
      acquire: async (options) => {
        acquisitions.push(options);
        return {
          ...options,
          backendKind: "in-app",
          canReveal: true,
          bridge: runtimeDispatchTestBridge(),
          show: async () => {
            shown += 1;
          },
          hide: () => undefined,
          release: () => {
            released += 1;
          },
        };
      },
      close: () => undefined,
      closeAll: () => undefined,
    };

    const result = JSON.parse(
      await dispatchInteractiveBrowserRuntimeAction(
        "s-visible",
        { action: "requestTakeover" },
        runtime,
      ),
    );

    expect(acquisitions).toEqual([
      {
        ownerId: "interactive:s-visible",
        profileId: "s-visible",
        visibility: "full",
        title: "CodeShell Browser Runtime — 需要你接管",
      },
    ]);
    expect(shown).toBe(1);
    expect(released).toBe(1);
    expect(result).toMatchObject({ ok: true, code: "NEEDS_HUMAN" });
  });

  test("targets a task-owned in-app runtime tab, including tab operations", async () => {
    const acquisitions: Array<Record<string, unknown>> = [];
    let released = 0;
    let runtimeTabsRead = 0;
    const runtime: BrowserRuntimeLike = {
      acquire: async (options) => {
        acquisitions.push(options);
        return {
          ...options,
          backendKind: "in-app",
          canReveal: true,
          bridge: runtimeDispatchTestBridge({
            listTabs: async () => {
              runtimeTabsRead += 1;
              return [
                {
                  tabId: "runtime-tab",
                  url: "https://runtime.test/",
                  title: "Runtime",
                  active: true,
                },
              ];
            },
          }),
          show: async () => undefined,
          hide: () => undefined,
          release: () => {
            released += 1;
          },
        };
      },
      close: () => undefined,
      closeAll: () => undefined,
    };

    const result = JSON.parse(
      await dispatchInteractiveBrowserRuntimeAction("s-1", { action: "listTabs" }, runtime),
    );

    expect(acquisitions).toEqual([
      {
        ownerId: "interactive:s-1",
        profileId: "s-1",
        visibility: "milestones",
        title: "CodeShell Browser Runtime — 需要你接管",
      },
    ]);
    expect(result).toEqual([
      {
        tabId: "runtime-tab",
        url: "https://runtime.test/",
        title: "Runtime",
        active: true,
      },
    ]);
    expect(runtimeTabsRead).toBe(1);
    expect(released).toBe(1);
  });

  test("releases the runtime lease after a dispatch failure", async () => {
    let released = 0;
    const runtime: BrowserRuntimeLike = {
      acquire: async (options) => ({
        ...options,
        backendKind: "in-app",
        canReveal: true,
        bridge: runtimeDispatchTestBridge({
          snapshot: async () => {
            throw new Error("runtime target crashed");
          },
        }),
        show: async () => undefined,
        hide: () => undefined,
        release: () => {
          released += 1;
        },
      }),
      close: () => undefined,
      closeAll: () => undefined,
    };

    const result = JSON.parse(
      await dispatchInteractiveBrowserRuntimeAction("s-1", { action: "snapshot" }, runtime),
    );

    expect(result).toMatchObject({ ok: false, detail: "runtime target crashed" });
    expect(released).toBe(1);
  });
});

test("child targets share the parent profile while isolating owners and resumed bindings", async () => {
  const acquired: Array<{ ownerId: string; profileId?: string }> = [];
  const closed: string[] = [];
  const runtime: BrowserRuntimeLike = {
    async acquire(options) {
      acquired.push(options);
      return {
        ...options,
        backendKind: "in-app",
        canReveal: true,
        bridge: runtimeDispatchTestBridge(),
        show: async () => {},
        hide() {},
        release() {},
      };
    },
    close: (owner) => {
      closed.push(owner);
    },
    closeAll() {},
  };
  const unknown = { sourceSessionId: "child-unknown", bindingId: "never-activated" };
  expect(
    JSON.parse(
      await dispatchInteractiveBrowserRuntimeAction(
        "parent",
        { action: "navigate", url: "https://example.com" },
        runtime,
        unknown,
      ),
    ),
  ).toMatchObject({ ok: false, code: "TARGET_CLOSED" });
  expect(acquired).toHaveLength(0);
  const a = { sourceSessionId: "child-a", bindingId: "run-1" };
  const b = { sourceSessionId: "child-b", bindingId: "run-2" };
  for (const child of [a, b]) {
    activateChildBrowserRuntime("parent", child);
    await dispatchInteractiveBrowserRuntimeAction(
      "parent",
      { action: "navigate", url: "https://example.com" },
      runtime,
      child,
    );
  }
  expect(acquired.map((o) => o.profileId)).toEqual(["parent", "parent"]);
  expect(acquired[0].ownerId).not.toBe(acquired[1].ownerId);
  expect(acquired[0].ownerId).not.toBe("interactive:parent");
  releaseChildBrowserRuntime("parent", a, runtime);
  expect(closed).toEqual([acquired[0].ownerId]);
  expect(
    JSON.parse(
      await dispatchInteractiveBrowserRuntimeAction("parent", { action: "snapshot" }, runtime, a),
    ),
  ).toMatchObject({ ok: false, code: "TARGET_CLOSED" });
  expect(acquired).toHaveLength(2);
  const resumed = { ...a, bindingId: "resumed" };
  activateChildBrowserRuntime("parent", resumed);
  await dispatchInteractiveBrowserRuntimeAction("parent", { action: "snapshot" }, runtime, resumed);
  expect(acquired).toHaveLength(3);
  expect(acquired[2].ownerId).not.toBe(acquired[0].ownerId);
  releaseChildBrowserRuntime("parent", b, runtime);
  releaseChildBrowserRuntime("parent", resumed, runtime);
});

test("a released child cannot navigate when its pending acquire finishes late", async () => {
  let resolveAcquire!: () => void;
  let navigations = 0;
  const closed: string[] = [];
  const runtime: BrowserRuntimeLike = {
    async acquire(options) {
      await new Promise<void>((resolve) => {
        resolveAcquire = resolve;
      });
      return {
        ...options,
        backendKind: "in-app",
        canReveal: true,
        bridge: runtimeDispatchTestBridge({
          navigate: async () => {
            navigations++;
            return { ok: true };
          },
        }),
        show: async () => {},
        hide() {},
        release() {},
      };
    },
    close(owner) {
      closed.push(owner);
    },
    closeAll() {},
  };
  const child = { sourceSessionId: "child-late", bindingId: "run-late" };
  activateChildBrowserRuntime("parent", child);
  const pending = dispatchInteractiveBrowserRuntimeAction(
    "parent",
    { action: "navigate", url: "https://example.com" },
    runtime,
    child,
  );
  releaseChildBrowserRuntime("parent", child, runtime);
  // A long-lived pending acquire stays cancelled regardless of later child lifecycles.
  for (let index = 0; index < 2050; index++) {
    releaseChildBrowserRuntime(
      "parent",
      { sourceSessionId: "other-child", bindingId: `run-${index}` },
      { ...runtime, close() {} },
    );
  }
  resolveAcquire();
  expect(JSON.parse(await pending)).toMatchObject({ ok: false, code: "TARGET_CLOSED" });
  expect(navigations).toBe(0);
  expect(closed).toHaveLength(2);
});
