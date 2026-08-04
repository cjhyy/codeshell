import { describe, expect, test } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import {
  DesktopBrowserRuntime,
  browserRuntimePartition,
  type BrowserRuntimeVisibility,
} from "./runtime.js";
import type { BrowserRuntimeBackend } from "./backend.js";

function fakeBridge(): BrowserBridge {
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
  };
}

describe("DesktopBrowserRuntime", () => {
  test("uses a runtime-owned profile namespace, never the built-in browser partition", () => {
    expect(browserRuntimePartition("interactive:s-1")).toBe(
      "persist:browser-runtime:interactive:s-1",
    );
    expect(browserRuntimePartition("../../bad profile")).toBe(
      "persist:browser-runtime:.._.._bad_profile",
    );
    expect(browserRuntimePartition("interactive:s-1")).not.toStartWith("persist:browser:");
  });

  test("maps an execution lease onto the hidden target pool with explicit profile and visibility", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let released = 0;
    let shown = 0;
    let hidden = 0;
    const bridge = fakeBridge();
    const runtime = new DesktopBrowserRuntime({
      targetPool: {
        acquire: (options) => {
          calls.push(options);
          return {
            bridge,
            show: async () => {
              shown += 1;
            },
            hide: () => {
              hidden += 1;
            },
            release: () => {
              released += 1;
            },
          };
        },
        close: (ownerId) => calls.push({ close: ownerId }),
        closeAll: () => calls.push({ closeAll: true }),
      },
    });

    const visibility: BrowserRuntimeVisibility = "milestones";
    const lease = await runtime.acquire({
      ownerId: "interactive:s-1",
      profileId: "account:research",
      visibility,
    });

    expect(calls).toEqual([]);
    expect(lease.backendKind).toBe("pending");
    await lease.bridge.snapshot();
    expect(calls[0]).toEqual({
      ownerId: "interactive:s-1",
      partition: "persist:browser-runtime:account:research",
      initialUrl: undefined,
      title: "CodeShell Browser Runtime — 需要你接管",
    });
    expect(lease.bridge).not.toBe(bridge);
    expect(lease.visibility).toBe("milestones");
    expect(lease.backendKind).toBe("electron-cdp");
    expect(lease.canReveal).toBe(true);
    await lease.show();
    lease.hide();
    lease.release();
    expect(hidden).toBe(1);
    expect(released).toBe(1);
    expect(shown).toBe(1);
  });

  test("rejects missing owner and profile identity", async () => {
    const runtime = new DesktopBrowserRuntime({
      targetPool: {
        acquire: () => {
          throw new Error("should not acquire");
        },
        close: () => undefined,
        closeAll: () => undefined,
      },
    });

    await expect(
      runtime.acquire({ ownerId: "", profileId: "p", visibility: "hidden" }),
    ).rejects.toThrow("ownerId");
    await expect(
      runtime.acquire({ ownerId: "o", profileId: "", visibility: "hidden" }),
    ).rejects.toThrow("profileId");
  });

  test("stops a repeated read of the same cursor and allows real cursor progress", async () => {
    const targetBridge = fakeBridge();
    targetBridge.readContent = async (options) => ({
      ok: true,
      code: "OK",
      url: "https://example.test/article",
      documentId: "frame:loader-1",
      text: options?.cursor ? "second" : "first",
      cursor: options?.cursor ?? "start",
      nextCursor: options?.cursor ? undefined : "next",
      done: options?.cursor !== undefined,
      contentHash: "whole-document",
    });
    const runtime = new DesktopBrowserRuntime({
      targetPool: {
        acquire: () => ({
          bridge: targetBridge,
          show: async () => undefined,
          hide: () => undefined,
          release: () => undefined,
        }),
        close: () => undefined,
        closeAll: () => undefined,
      },
    });
    const acquire = () =>
      runtime.acquire({ ownerId: "interactive:s-1", profileId: "p", visibility: "hidden" });

    expect((await (await acquire()).bridge.readContent()).ok).toBe(true);
    expect(await (await acquire()).bridge.readContent()).toMatchObject({
      ok: false,
      code: "NO_PROGRESS",
    });
    expect(await (await acquire()).bridge.readContent({ cursor: "next" })).toMatchObject({
      ok: true,
      done: true,
      text: "second",
    });
  });

  test("stops identical structured scroll states across calls", async () => {
    const targetBridge = fakeBridge();
    targetBridge.scroll = async () => ({
      ok: true,
      code: "OK",
      documentId: "frame:loader-1",
      contentChanged: false,
      scroll: {
        x: 0,
        y: 1000,
        maxX: 0,
        maxY: 1000,
        viewportWidth: 800,
        viewportHeight: 600,
        atTop: false,
        atEnd: true,
      },
    });
    const runtime = new DesktopBrowserRuntime({
      targetPool: {
        acquire: () => ({
          bridge: targetBridge,
          show: async () => undefined,
          hide: () => undefined,
          release: () => undefined,
        }),
        close: () => undefined,
        closeAll: () => undefined,
      },
    });
    const first = await runtime.acquire({ ownerId: "o", profileId: "p", visibility: "hidden" });
    const second = await runtime.acquire({ ownerId: "o", profileId: "p", visibility: "hidden" });

    expect((await first.bridge.scroll("down")).ok).toBe(true);
    expect(await second.bridge.scroll("down")).toMatchObject({
      ok: false,
      code: "NO_PROGRESS",
      retryable: false,
    });
  });

  test("auto mode falls back from Playwright only when backend acquisition fails", async () => {
    const attempts: string[] = [];
    const backend = (
      kind: BrowserRuntimeBackend["kind"],
      acquire: BrowserRuntimeBackend["acquire"],
    ): BrowserRuntimeBackend => ({
      kind,
      isAvailable: () => true,
      acquire,
      close: (ownerId) => attempts.push(`close:${kind}:${ownerId}`),
      closeAll: () => undefined,
    });
    const runtime = new DesktopBrowserRuntime({
      backends: [
        backend("playwright", async () => {
          attempts.push("playwright");
          throw new Error("browser binary missing");
        }),
        backend("electron-cdp", async () => {
          attempts.push("electron-cdp");
          return {
            kind: "electron-cdp",
            bridge: fakeBridge(),
            canReveal: true,
            show: async () => undefined,
            hide: () => undefined,
            release: () => undefined,
          };
        }),
      ],
    });

    const lease = await runtime.acquire({
      ownerId: "interactive:fallback",
      profileId: "interactive:fallback",
      visibility: "hidden",
    });

    expect(lease.backendKind).toBe("pending");
    await lease.bridge.snapshot();
    expect(lease.backendKind).toBe("electron-cdp");
    expect(lease.canReveal).toBe(true);
    expect(attempts).toEqual([
      "playwright",
      "close:playwright:interactive:fallback",
      "electron-cdp",
    ]);
  });
});
