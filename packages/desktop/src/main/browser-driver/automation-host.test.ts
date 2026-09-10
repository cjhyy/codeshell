import { describe, expect, test, beforeEach } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import { handleBrowserAction, releaseGuest, type AutomationDeps } from "./automation-host";
import { CdpBrowserDriver } from "./cdp-driver.js";
import { captureElectronPage } from "./electron-screenshot.js";
import type { WebContents } from "electron";

// The driver cache is module-level (keyed by guest id). Reset id:1 between tests
// so a snapshot's ref map from one test doesn't bleed into another.
beforeEach(() => releaseGuest(1));

/** Minimal fake guest webContents that drives a scriptable CDP map. */
function fakeGuest(opts: {
  url?: string;
  cdp?: Record<string, (p?: any) => any>;
  destroyed?: boolean;
  debuggerState?: { attached: boolean; attaches: number; detaches: number };
  capturePage?: WebContents["capturePage"];
}): WebContents {
  const debuggerState = opts.debuggerState ?? { attached: false, attaches: 0, detaches: 0 };
  const cdp = opts.cdp ?? {};
  return {
    id: (opts as { id?: number }).id ?? 1,
    once: () => undefined,
    isDestroyed: () => opts.destroyed ?? false,
    getURL: () => opts.url ?? "https://www.xiaohongshu.com/explore",
    getTitle: () => "小红书",
    getZoomFactor: () => 1.25,
    capturePage: opts.capturePage,
    debugger: {
      isAttached: () => debuggerState.attached,
      attach: () => {
        debuggerState.attached = true;
        debuggerState.attaches++;
      },
      detach: () => {
        debuggerState.attached = false;
        debuggerState.detaches++;
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
    activeGuest: () =>
      fakeGuest({ cdp: { "Accessibility.getFullAXTree": () => AX, "DOM.getBoxModel": () => BOX } }),
    policy: () => ({ allowedDomains: [] }),
    createDriver: (guest) =>
      new CdpBrowserDriver(
        (method, params) => guest.debugger.sendCommand(method, params),
        () => ({ url: guest.getURL(), title: guest.getTitle() }),
        {
          captureScreenshot: guest.capturePage
            ? (request) => captureElectronPage(guest, request)
            : undefined,
        },
      ),
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

  test("uses background tab operations when no visible panel tabs exist", async () => {
    const backgroundBridge = {
      listTabs: async () => [
        { tabId: "background", url: "https://example.com", title: "Example", active: true },
      ],
      switchTab: async (tabId: string) => ({ ok: tabId === "background" }),
    } as BrowserBridge;

    const listed = await handleBrowserAction(
      { action: "listTabs" },
      deps({ activeGuest: () => null, backgroundBridge, listTabs: () => [] }),
    );
    expect(JSON.parse(listed)).toEqual([
      { tabId: "background", url: "https://example.com", title: "Example", active: true },
    ]);

    const switched = await handleBrowserAction(
      { action: "switchTab", tabId: "background" },
      deps({ activeGuest: () => null, backgroundBridge, switchTab: () => false }),
    );
    expect(JSON.parse(switched)).toEqual({ ok: true });
  });
});

describe("handleBrowserAction", () => {
  test("captures the cached guest through Electron and keeps snapshot refs isolated", async () => {
    const captures: unknown[] = [];
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 250, height: 100 }),
      toJPEG: () => Buffer.from("native-guest"),
    };
    const guest = fakeGuest({
      cdp: {
        "Accessibility.getFullAXTree": () => AX,
        "DOM.getBoxModel": () => BOX,
      },
      capturePage: (async (...args: unknown[]) => {
        captures.push(args);
        return image;
      }) as WebContents["capturePage"],
    });
    const dependencies = deps({ activeGuest: () => guest });
    const snapshot = JSON.parse(await handleBrowserAction({ action: "snapshot" }, dependencies));
    const ref = snapshot.elements[0].ref;
    const full = JSON.parse(await handleBrowserAction({ action: "screenshot" }, dependencies));
    const region = JSON.parse(
      await handleBrowserAction({ action: "screenshot", ref }, dependencies),
    );
    expect(full).toMatchObject({
      ok: true,
      base64: Buffer.from("native-guest").toString("base64"),
    });
    expect(region.ok).toBe(true);
    expect(captures).toEqual([
      [undefined, { stayHidden: true }],
      [{ x: 0, y: 0, width: 125, height: 50 }, { stayHidden: true }],
    ]);
    releaseGuest(guest.id);
    const stale = JSON.parse(
      await handleBrowserAction({ action: "screenshot", ref }, dependencies),
    );
    expect(stale.ok).toBe(false);
    expect(captures).toHaveLength(2);
  });

  test("no active guest, no openPanel → safe error", async () => {
    const out = await handleBrowserAction(
      { action: "snapshot" },
      deps({ activeGuest: () => null }),
    );
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(out).toContain("no active browser");
  });

  test("no active guest uses a background bridge without opening the panel", async () => {
    let openPanelCalled = false;
    const backgroundBridge = {
      navigate: async (url: string) => ({ ok: true, detail: `background:${url}` }),
    } as BrowserBridge;
    const out = await handleBrowserAction(
      { action: "navigate", url: "https://example.com/" },
      deps({
        activeGuest: () => null,
        backgroundBridge,
        openPanel: async () => {
          openPanelCalled = true;
          return true;
        },
      }),
    );

    expect(JSON.parse(out)).toEqual({
      ok: true,
      detail: "background:https://example.com/",
    });
    expect(openPanelCalled).toBe(false);
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
    expect(r.elements[0].ref).toBe(`${r.snapshotId}:e1`);
  });

  test("keeps a single target driver across consecutive actions", async () => {
    const debuggerState = { attached: false, attaches: 0, detaches: 0 };
    const guest = fakeGuest({
      debuggerState,
      cdp: { "Accessibility.getFullAXTree": () => AX, "DOM.getBoxModel": () => BOX },
    });
    const d = deps({ activeGuest: () => guest });
    const snap = JSON.parse(await handleBrowserAction({ action: "snapshot" }, d));
    expect(snap.elements[1].ref).toBe(`${snap.snapshotId}:e2`);
    expect(debuggerState).toMatchObject({ attached: false, attaches: 0, detaches: 0 });

    const out = await handleBrowserAction({ action: "click", ref: snap.elements[1].ref }, d);
    expect(JSON.parse(out)).toMatchObject({ ok: true });
    expect(debuggerState).toMatchObject({ attached: false, attaches: 0, detaches: 0 });
  });

  test("click after snapshot reuses the cached driver → ref resolves (persistent ref map)", async () => {
    const d = deps();
    const snap = JSON.parse(await handleBrowserAction({ action: "snapshot" }, d));
    expect(snap.elements[1].ref).toBe(`${snap.snapshotId}:e2`);
    // The per-guest driver (id:1) persists across calls, so e2's ref map survives
    // into this separate click call — it must NOT be stale.
    const out = await handleBrowserAction({ action: "click", ref: snap.elements[1].ref }, d);
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
    const out = await handleBrowserAction(
      { action: "type", ref: "e1", text: "4111111111111111" },
      d,
    );
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(out).toContain("declined");
  });

  test("snapshot-learned destructive ref requires approval before dispatch", async () => {
    let approvalRequests = 0;
    let mouseEvents = 0;
    const guest = fakeGuest({
      cdp: {
        "Accessibility.getFullAXTree": () => ({
          nodes: [
            {
              nodeId: "delete-account",
              role: { value: "button" },
              name: { value: "删除账号" },
              backendDOMNodeId: 30,
            },
          ],
        }),
        "DOM.getBoxModel": () => BOX,
        "Input.dispatchMouseEvent": () => {
          mouseEvents++;
          return {};
        },
      },
    });
    const d = deps({
      activeGuest: () => guest,
      approve: async () => {
        approvalRequests++;
        return false;
      },
    });

    const snapshot = JSON.parse(await handleBrowserAction({ action: "snapshot" }, d));
    const out = await handleBrowserAction({ action: "click", ref: snapshot.elements[0].ref }, d);

    expect(JSON.parse(out)).toMatchObject({ ok: false, detail: "sensitive action declined" });
    expect(approvalRequests).toBe(1);
    expect(mouseEvents).toBe(0);
  });
});

// The reveal decision is owned by BackgroundBrowserRuntime, which calls
// host.show() at each takeover point; see background-runtime.test.ts.

describe("tab control gate", () => {
  /** A snapshot first: refs only resolve against the latest snapshot. */
  async function clickWith(over: Partial<AutomationDeps>): Promise<string> {
    const d = deps(over);
    const snap = JSON.parse(await handleBrowserAction({ action: "snapshot" }, d)) as {
      elements: Array<{ ref: string }>;
    };
    return handleBrowserAction({ action: "click", ref: snap.elements[1].ref }, d);
  }

  test("refuses a write when control validation fails", async () => {
    // The gate chain already checks domain and sensitivity per action; this
    // adds "may this Session write THIS tab, still showing THIS page".
    const parsed = JSON.parse(
      await clickWith({ validateTabControl: async () => ({ ok: false, reason: "navigated" }) }),
    ) as { ok: boolean; detail?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toContain("navigated");
  });

  test("lets reads through even when control is unavailable", async () => {
    // Observation must not contend for a writer lock, or ordinary reading
    // breaks whenever another Session holds the tab.
    const out = await handleBrowserAction(
      { action: "snapshot" },
      deps({ validateTabControl: async () => ({ ok: false, reason: "held" }) }),
    );
    expect(JSON.parse(out).elements).toBeDefined();
  });

  test("allows writes when validation passes", async () => {
    const out = await clickWith({ validateTabControl: async () => ({ ok: true }) });
    expect(JSON.parse(out)).toMatchObject({ ok: true });
  });

  test("stays permissive when the host installs no validator", async () => {
    // Desktop today has no lease wiring; adding the seam must not break it.
    expect(JSON.parse(await clickWith({}))).toMatchObject({ ok: true });
  });
});

describe("approval strictness by browser source", () => {
  async function clickIn(over: Partial<AutomationDeps>): Promise<string> {
    const d = deps(over);
    const snap = JSON.parse(await handleBrowserAction({ action: "snapshot" }, d)) as {
      elements: Array<{ ref: string }>;
    };
    return handleBrowserAction({ action: "click", ref: snap.elements[1].ref }, d);
  }

  test("every write in the user's own browser needs approval", async () => {
    // Inside the sandbox an ordinary click is not sensitive. In the user's real
    // Chrome the same click can be a real purchase, so it must be approved even
    // though isSensitiveAction() says no.
    const asked: string[] = [];
    const out = await clickIn({
      strictApproval: () => true,
      approve: async (reason: string) => {
        asked.push(reason);
        return false;
      },
    });
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(asked).toHaveLength(1);
  });

  test("an approved write in the user's browser proceeds", async () => {
    const out = await clickIn({ strictApproval: () => true, approve: async () => true });
    expect(JSON.parse(out)).toMatchObject({ ok: true });
  });

  test("reads in the user's browser are not gated", async () => {
    // Observing cannot change anything, and prompting on every snapshot would
    // train the user to click through approvals.
    const asked: string[] = [];
    const out = await handleBrowserAction(
      { action: "snapshot" },
      deps({
        strictApproval: () => true,
        approve: async (reason: string) => {
          asked.push(reason);
          return true;
        },
      }),
    );
    expect(JSON.parse(out).elements).toBeDefined();
    expect(asked).toEqual([]);
  });

  test("built-in sources keep the existing behavior", async () => {
    // No strictApproval installed: an ordinary click stays unprompted.
    const asked: string[] = [];
    const out = await clickIn({
      approve: async (reason: string) => {
        asked.push(reason);
        return true;
      },
    });
    expect(JSON.parse(out)).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
  });
});
