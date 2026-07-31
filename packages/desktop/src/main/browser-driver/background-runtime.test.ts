import { describe, expect, test } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import type { WebContents } from "electron";
import type { BrowserHostHandle, BrowserHostOpenOptions } from "../browser-host/index.js";
import { CdpBrowserDriver } from "./cdp-driver.js";
import { BackgroundBrowserRuntime, backgroundBrowserPartition } from "./background-runtime.js";

interface Harness {
  runtime: BackgroundBrowserRuntime;
  openOptions: BrowserHostOpenOptions[];
  calls: string[];
  state: { url: string; visible: boolean; closed: boolean };
}

function harness(options?: {
  allowedDomains?: string[];
  overrides?: Partial<BrowserBridge>;
  maxTargets?: number;
  idleTtlMs?: number;
}): Harness {
  const openOptions: BrowserHostOpenOptions[] = [];
  const calls: string[] = [];
  const state = { url: "about:blank", visible: false, closed: false };
  const webContents = {
    id: 41,
    getURL: () => state.url,
    getTitle: () => "Background",
  } as unknown as WebContents;
  const host: BrowserHostHandle = {
    webContents,
    loadURL: async (url) => {
      state.url = url;
    },
    executeJavaScript: async () => undefined as never,
    getCookies: async () => [],
    close: () => {
      state.closed = true;
    },
    show: () => {
      state.visible = true;
    },
    hide: () => {
      state.visible = false;
    },
    isVisible: () => state.visible,
    onClosed: () => undefined,
  };
  const base: BrowserBridge & { resetDomains(): void } = {
    snapshot: async () => ({ url: state.url, title: "Background", elements: [] }),
    click: async (ref) => ({ ok: true, detail: ref }),
    type: async (ref, text) => ({ ok: true, detail: `${ref}:${text}` }),
    navigate: async (url) => {
      calls.push(`navigate:${url}`);
      state.url = url;
      return { ok: true };
    },
    scroll: async () => ({ ok: true }),
    readContent: async () => ({ ok: true, url: state.url, text: "page" }),
    extractLinks: async () => ({
      ok: true,
      url: state.url,
      links: [],
      images: [],
      videos: [],
    }),
    waitForLoad: async () => ({ ok: true }),
    hover: async () => ({ ok: true }),
    selectOption: async () => ({ ok: true }),
    pressKey: async () => ({ ok: true }),
    fetchImages: async (refs) => refs.map((ref) => ({ ok: true, ref })),
    screenshot: async () => ({
      ok: true,
      base64: "QUJD",
      mediaType: "image/jpeg",
    }),
    listTabs: async () => [],
    switchTab: async () => ({ ok: false }),
    resetDomains: () => calls.push("reset"),
    ...options?.overrides,
  };
  const runtime = new BackgroundBrowserRuntime({
    idleTtlMs: options?.idleTtlMs ?? 60_000,
    maxTargets: options?.maxTargets,
    deps: {
      openHost: async (open) => {
        openOptions.push(open);
        state.url = open.url;
        return host;
      },
      createDriver: () => base as CdpBrowserDriver,
      attach: () => {
        calls.push("attach");
        return true;
      },
      detach: () => calls.push("detach"),
      policy: () => ({ allowedDomains: options?.allowedDomains ?? [] }),
      now: () => 100,
    },
  });
  return { runtime, openOptions, calls, state };
}

describe("BackgroundBrowserRuntime", () => {
  test("is lazy, opens a hidden unthrottled BrowserWindow on first browser call", async () => {
    const h = harness();
    const lease = h.runtime.acquire({
      ownerId: "job-1",
      partition: backgroundBrowserPartition("job-1"),
    });

    expect(h.openOptions).toHaveLength(0);
    expect(h.runtime.stats()).toEqual({ entries: 1, liveTargets: 0, leased: 1 });

    expect(await lease.bridge.navigate("https://example.com/")).toMatchObject({ ok: true });
    expect(h.openOptions).toHaveLength(1);
    expect(h.openOptions[0]).toMatchObject({
      kind: "window",
      url: "about:blank",
      show: false,
      backgroundThrottling: false,
      partition: "persist:browser:automation:job-1",
    });
    expect(h.calls).toEqual(["attach", "navigate:https://example.com/", "detach", "reset"]);
    lease.release();
    h.runtime.closeAll();
  });

  test("reuses one target for overlapping leases and exposes the exact target for takeover", async () => {
    const h = harness();
    const options = { ownerId: "job-1", partition: backgroundBrowserPartition("job-1") };
    const first = h.runtime.acquire(options);
    const second = h.runtime.acquire(options);

    await first.bridge.snapshot();
    await second.show();

    expect(h.openOptions).toHaveLength(1);
    expect(h.runtime.stats()).toEqual({ entries: 1, liveTargets: 1, leased: 2 });
    expect(h.state.visible).toBe(true);
    second.hide();
    expect(h.state.visible).toBe(false);

    first.release();
    second.release();
    h.runtime.closeAll();
    expect(h.state.closed).toBe(true);
  });

  test("hard-blocks off-whitelist navigation before the driver sees it", async () => {
    const h = harness({ allowedDomains: ["example.com"] });
    const lease = h.runtime.acquire({
      ownerId: "job-1",
      partition: backgroundBrowserPartition("job-1"),
    });

    const result = await lease.bridge.navigate("https://evil.test/private");

    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("not allowed");
    expect(h.calls).not.toContain("navigate:https://evil.test/private");
    lease.release();
    h.runtime.closeAll();
  });

  test("refuses secret-shaped input even when the outer automation tier is permissive", async () => {
    let typed = false;
    const h = harness({
      overrides: {
        type: async () => {
          typed = true;
          return { ok: true };
        },
      },
    });
    const lease = h.runtime.acquire({
      ownerId: "job-1",
      partition: backgroundBrowserPartition("job-1"),
      initialUrl: "https://example.com/",
    });

    const result = await lease.bridge.type("e1", "4111 1111 1111 1111");

    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("interactive browser");
    expect(typed).toBe(false);
    lease.release();
    h.runtime.closeAll();
  });

  test("reveals login walls and gates sensitive refs learned from the snapshot", async () => {
    let clicked = false;
    let typed = false;
    const h = harness({
      overrides: {
        snapshot: async () => ({
          url: "https://example.com/checkout",
          elements: [
            { ref: "e1", role: "textbox", name: "密码", sensitive: true },
            { ref: "e2", role: "button", name: "确认订单" },
          ],
          needsHuman: "login required",
        }),
        click: async () => {
          clicked = true;
          return { ok: true };
        },
        type: async () => {
          typed = true;
          return { ok: true };
        },
      },
    });
    const lease = h.runtime.acquire({
      ownerId: "job-1",
      partition: backgroundBrowserPartition("job-1"),
      initialUrl: "https://example.com/checkout",
    });

    await lease.bridge.snapshot();
    expect(h.state.visible).toBe(true);

    lease.hide();
    const typedResult = await lease.bridge.type("e1", "ordinary-password");
    expect(typedResult).toMatchObject({ ok: false });
    expect(h.state.visible).toBe(true);
    expect(typed).toBe(false);

    lease.hide();
    const clickResult = await lease.bridge.click("e2");
    expect(clickResult).toMatchObject({ ok: false });
    expect(h.state.visible).toBe(true);
    expect(clicked).toBe(false);

    lease.release();
    h.runtime.closeAll();
  });

  test("bounds live owners and evicts an idle owner before admitting another", async () => {
    const h = harness({ maxTargets: 1 });
    const first = h.runtime.acquire({
      ownerId: "job-1",
      partition: backgroundBrowserPartition("job-1"),
    });
    await first.bridge.snapshot();
    first.release();

    const second = h.runtime.acquire({
      ownerId: "job-2",
      partition: backgroundBrowserPartition("job-2"),
    });
    await second.bridge.snapshot();

    expect(h.state.closed).toBe(true);
    expect(h.runtime.stats()).toEqual({ entries: 1, liveTargets: 1, leased: 1 });
    second.release();
    h.runtime.closeAll();
  });

  test("never evicts a visible human-takeover target to make capacity", async () => {
    const h = harness({ maxTargets: 1 });
    const first = h.runtime.acquire({
      ownerId: "interactive:session-1",
      partition: backgroundBrowserPartition("interactive:session-1"),
    });
    await first.show();
    first.release();

    const second = h.runtime.acquire({
      ownerId: "job-2",
      partition: backgroundBrowserPartition("job-2"),
    });
    const result = await second.bridge.snapshot();

    expect(result.detail).toContain("target limit reached");
    expect(h.state.visible).toBe(true);
    expect(h.state.closed).toBe(false);
    second.release();
    h.runtime.closeAll();
  });

  test("does not spend target capacity for jobs that never call a browser tool", () => {
    const h = harness({ maxTargets: 1 });
    const first = h.runtime.acquire({
      ownerId: "job-1",
      partition: backgroundBrowserPartition("job-1"),
    });
    const second = h.runtime.acquire({
      ownerId: "job-2",
      partition: backgroundBrowserPartition("job-2"),
    });

    expect(h.openOptions).toHaveLength(0);
    expect(h.runtime.stats()).toEqual({ entries: 2, liveTargets: 0, leased: 2 });
    first.release();
    second.release();
    h.runtime.closeAll();
  });

  test("keeps a revealed target alive until the human hides it", async () => {
    const h = harness({ idleTtlMs: 10 });
    const first = h.runtime.acquire({
      ownerId: "interactive:session-1",
      partition: backgroundBrowserPartition("interactive:session-1"),
    });

    await first.show();
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(h.state.visible).toBe(true);
    expect(h.state.closed).toBe(false);
    expect(h.runtime.stats()).toEqual({ entries: 1, liveTargets: 1, leased: 0 });

    const second = h.runtime.acquire({
      ownerId: "interactive:session-1",
      partition: backgroundBrowserPartition("interactive:session-1"),
    });
    second.hide();
    second.release();
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(h.state.closed).toBe(true);
    expect(h.runtime.stats()).toEqual({ entries: 0, liveTargets: 0, leased: 0 });
  });
});
