import { describe, expect, test, beforeEach } from "bun:test";
import { handleBrowserAction, releaseGuest, type AutomationDeps } from "./automation-host";
import type { WebContents } from "electron";

// The driver cache is module-level (keyed by guest id). Reset id:1 between tests
// so a snapshot's ref map from one test doesn't bleed into another.
beforeEach(() => releaseGuest(1));

/** Minimal fake guest webContents that drives a scriptable CDP map. */
function fakeGuest(opts: {
  url?: string;
  cdp?: Record<string, (p?: any) => any>;
  destroyed?: boolean;
}): WebContents {
  let attached = false;
  const cdp = opts.cdp ?? {};
  return {
    id: (opts as { id?: number }).id ?? 1,
    once: () => undefined,
    isDestroyed: () => opts.destroyed ?? false,
    getURL: () => opts.url ?? "https://www.xiaohongshu.com/explore",
    getTitle: () => "小红书",
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      sendCommand: async (method: string, params?: any) => (cdp[method] ? cdp[method](params) : {}),
    },
  } as unknown as WebContents;
}

const AX = {
  nodes: [
    { nodeId: "1", role: { value: "textbox" }, name: { value: "搜索" }, backendDOMNodeId: 10 },
    { nodeId: "2", role: { value: "button" }, name: { value: "搜索" }, backendDOMNodeId: 20 },
  ],
};
const BOX = { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };

function deps(over: Partial<AutomationDeps> = {}): AutomationDeps {
  return {
    activeGuest: () => fakeGuest({ cdp: { "Accessibility.getFullAXTree": () => AX, "DOM.getBoxModel": () => BOX } }),
    policy: () => ({ allowedDomains: [] }),
    ...over,
  };
}

describe("handleBrowserAction tabs", () => {
  test("listTabs returns the registry's tabs without needing an active guest", async () => {
    const tabs = [{ tabId: "1", url: "https://a", title: "A", active: true }];
    const out = await handleBrowserAction(
      { action: "listTabs" },
      deps({ activeGuest: () => null, listTabs: () => tabs }),
    );
    expect(JSON.parse(out)).toEqual(tabs);
  });

  test("switchTab routes to deps.switchTab (found / not found)", async () => {
    const okOut = await handleBrowserAction(
      { action: "switchTab", tabId: "2" },
      deps({ activeGuest: () => null, switchTab: (id) => id === "2" }),
    );
    expect(JSON.parse(okOut)).toMatchObject({ ok: true });
    const missOut = await handleBrowserAction(
      { action: "switchTab", tabId: "9" },
      deps({ activeGuest: () => null, switchTab: () => false }),
    );
    expect(JSON.parse(missOut)).toMatchObject({ ok: false });
  });
});

describe("handleBrowserAction", () => {
  test("no active guest, no openPanel → safe error", async () => {
    const out = await handleBrowserAction({ action: "snapshot" }, deps({ activeGuest: () => null }));
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(out).toContain("no active browser");
  });

  test("no guest but openPanel succeeds → auto-opens panel then proceeds", async () => {
    let opened = false;
    const guest = fakeGuest({ cdp: { "Accessibility.getFullAXTree": () => AX } });
    const out = await handleBrowserAction(
      { action: "snapshot" },
      deps({
        activeGuest: () => (opened ? guest : null), // null until openPanel runs
        openPanel: async () => {
          opened = true;
          return true;
        },
      }),
    );
    const r = JSON.parse(out);
    expect(r.elements).toHaveLength(2); // snapshot ran after auto-open
  });

  test("navigate with no guest → opens panel at the URL, returns ok early", async () => {
    let opened = false;
    const guest = fakeGuest({});
    let openedUrl: string | undefined;
    const out = await handleBrowserAction(
      { action: "navigate", url: "https://www.xiaohongshu.com/" },
      deps({
        activeGuest: () => (opened ? guest : null),
        openPanel: async (u) => {
          opened = true;
          openedUrl = u;
          return true;
        },
      }),
    );
    expect(JSON.parse(out)).toMatchObject({ ok: true });
    expect(openedUrl).toBe("https://www.xiaohongshu.com/"); // panel opened at target
  });

  test("snapshot drives the guest and returns elements", async () => {
    const out = await handleBrowserAction({ action: "snapshot" }, deps());
    const r = JSON.parse(out);
    expect(r.url).toContain("xiaohongshu");
    expect(r.elements).toHaveLength(2);
    expect(r.elements[0].ref).toBe("e1");
  });

  test("click after snapshot reuses the cached driver → ref resolves (persistent ref map)", async () => {
    const d = deps();
    const snap = JSON.parse(await handleBrowserAction({ action: "snapshot" }, d));
    expect(snap.elements[1].ref).toBe("e2");
    // The per-guest driver (id:1) persists across calls, so e2's ref map survives
    // into this separate click call — it must NOT be stale.
    const out = await handleBrowserAction({ action: "click", ref: "e2" }, d);
    expect(JSON.parse(out)).toMatchObject({ ok: true });
  });

  test("click an unknown ref (never snapshotted) → stale", async () => {
    const out = await handleBrowserAction({ action: "click", ref: "e99" }, deps());
    expect(JSON.parse(out)).toMatchObject({ ok: false, staleRef: true });
  });

  test("domain whitelist hard-blocks navigate to off-list host (no approve bypass)", async () => {
    let approveCalled = false;
    const d = deps({
      policy: () => ({ allowedDomains: ["xiaohongshu.com"] }),
      approve: async () => {
        approveCalled = true;
        return true; // even if approve says yes, whitelist still blocks
      },
    });
    const out = await handleBrowserAction({ action: "navigate", url: "https://evil.com" }, d);
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(out).toContain("domain not allowed");
    expect(approveCalled).toBe(false); // whitelist is hard, not approve-gated
  });

  test("navigate to whitelisted host proceeds", async () => {
    const d = deps({ policy: () => ({ allowedDomains: [".xiaohongshu.com"] }) });
    const out = await handleBrowserAction(
      { action: "navigate", url: "https://www.xiaohongshu.com/search?q=x" },
      d,
    );
    expect(JSON.parse(out)).toMatchObject({ ok: true });
  });

  test("sensitive type (card number) requires approval; declined → refused", async () => {
    const d = deps({ approve: async () => false });
    const out = await handleBrowserAction({ action: "type", ref: "e1", text: "4111111111111111" }, d);
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(out).toContain("declined");
  });
});
