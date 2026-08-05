import { describe, expect, test } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import type { BrowserRuntimeLike } from "./runtime.js";
import { dispatchInteractiveBrowserRuntimeAction } from "./dispatch.js";

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
