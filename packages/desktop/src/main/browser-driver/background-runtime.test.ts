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
  continuityTtlMs?: number;
  maxRememberedTargets?: number;
  now?: () => number;
  beforeOpen?: () => Promise<void>;
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
    continuityTtlMs: options?.continuityTtlMs,
    maxRememberedTargets: options?.maxRememberedTargets,
    deps: {
      openHost: async (open) => {
        openOptions.push(open);
        await options?.beforeOpen?.();
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
      now: options?.now ?? (() => 100),
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

describe("BackgroundBrowserRuntime continuity", () => {
  const owner = { ownerId: "task-1", partition: "persist:workspace-1" };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  test("idle reclamation retains only a closed logical handle and requires explicit navigation", async () => {
    const h = harness({ idleTtlMs: 5 });
    const first = h.runtime.acquire(owner);
    await first.bridge.navigate("https://example.com/work");
    const [before] = await first.bridge.listTabs();
    first.release();
    await tick();
    expect(h.runtime.stats().liveTargets).toBe(0);

    const resumed = h.runtime.acquire(owner);
    expect(await resumed.bridge.listTabs()).toEqual([
      { ...before!, active: false, status: "closed" },
    ]);
    const stale = await resumed.bridge.switchTab(before!.tabId);
    expect(stale).toMatchObject({ ok: false, code: "TARGET_CLOSED", retryable: false });
    expect(stale.detail).toContain("browser_navigate");
    expect(stale.detail).toContain("https://example.com/work");
    expect(await resumed.bridge.click("old:e1")).toMatchObject({ code: "TARGET_CLOSED" });
    expect((await resumed.bridge.readContent()).detail).toContain("old element refs");
    expect(h.openOptions).toHaveLength(1);

    expect(await resumed.bridge.navigate("https://example.com/work")).toMatchObject({ ok: true });
    expect(await resumed.bridge.listTabs()).toEqual([{ ...before!, status: "open" }]);
    expect(await resumed.bridge.switchTab(before!.tabId)).toMatchObject({ ok: true });
    expect(h.openOptions).toHaveLength(2);
    expect(h.openOptions[1]).toMatchObject({
      partition: owner.partition,
      show: false,
      url: "about:blank",
    });
    resumed.release();
    h.runtime.closeAll();
  });

  test("capacity reclamation never redirects an old handle to another task", async () => {
    const h = harness({ maxTargets: 1 });
    const first = h.runtime.acquire(owner);
    const [before] = await first.bridge.listTabs();
    first.release();
    const second = h.runtime.acquire({ ownerId: "task-2", partition: "persist:workspace-2" });
    await second.bridge.navigate("https://other.example/");
    expect(await second.bridge.switchTab(before!.tabId)).toMatchObject({
      ok: false,
      code: "FAILED",
      retryable: false,
    });
    const resumed = h.runtime.acquire(owner);
    const result = await resumed.bridge.switchTab(before!.tabId);
    expect(result.code).toBe("TARGET_CLOSED");
    expect(result.detail).toContain("capacity");
    expect(h.openOptions).toHaveLength(2);
    expect(h.state.url).toBe("https://other.example/");
    resumed.release();
    second.release();
    h.runtime.closeAll();
  });

  test("remembered handles remain bound to their original workspace partition", async () => {
    const h = harness({ idleTtlMs: 5 });
    const first = h.runtime.acquire(owner);
    await first.bridge.snapshot();
    first.release();
    await tick();
    expect(() => h.runtime.acquire({ ...owner, partition: "persist:other-workspace" })).toThrow(
      "another partition",
    );
    h.runtime.closeAll();
  });

  test("explicit owner close forgets continuity and revokes old leases", async () => {
    const h = harness();
    const first = h.runtime.acquire(owner);
    const [before] = await first.bridge.listTabs();
    h.runtime.close(owner.ownerId);
    expect(await first.bridge.navigate("https://example.com/")).toMatchObject({ ok: false });
    const replacement = h.runtime.acquire(owner);
    expect(await replacement.bridge.switchTab(before!.tabId)).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(h.openOptions).toHaveLength(1);
    const [after] = await replacement.bridge.listTabs();
    expect(after!.tabId).not.toBe(before!.tabId);
    first.release();
    replacement.release();
    h.runtime.closeAll();
  });

  test("released leases cannot open a target again", async () => {
    const h = harness();
    const lease = h.runtime.acquire(owner);
    lease.release();
    const result = await lease.bridge.navigate("https://example.com/");
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("released");
    expect(h.openOptions).toHaveLength(0);
    h.runtime.closeAll();
  });

  test("continuity metadata expires and old IDs fail without opening a page", async () => {
    let now = 100;
    const h = harness({ idleTtlMs: 5, continuityTtlMs: 50, now: () => now });
    const lease = h.runtime.acquire(owner);
    const [before] = await lease.bridge.listTabs();
    lease.release();
    await tick();
    now += 51;
    const next = h.runtime.acquire(owner);
    expect(await next.bridge.switchTab(before!.tabId)).toMatchObject({
      code: "FAILED",
      retryable: false,
    });
    expect(h.openOptions).toHaveLength(1);
    next.release();
    h.runtime.closeAll();
  });

  test("caps remembered metadata while retaining the newest task", async () => {
    const h = harness({ maxTargets: 1, maxRememberedTargets: 1 });
    const first = h.runtime.acquire(owner);
    const [firstTab] = await first.bridge.listTabs();
    first.release();
    const secondOwner = { ownerId: "task-2", partition: owner.partition };
    const second = h.runtime.acquire(secondOwner);
    const [secondTab] = await second.bridge.listTabs();
    second.release();
    const third = h.runtime.acquire({ ownerId: "task-3", partition: owner.partition });
    await third.bridge.snapshot();
    const forgotten = h.runtime.acquire(owner);
    expect(await forgotten.bridge.switchTab(firstTab!.tabId)).toMatchObject({ code: "FAILED" });
    const remembered = h.runtime.acquire(secondOwner);
    expect(await remembered.bridge.switchTab(secondTab!.tabId)).toMatchObject({
      code: "TARGET_CLOSED",
    });
    expect(h.openOptions).toHaveLength(3);
    forgotten.release();
    remembered.release();
    third.release();
    h.runtime.closeAll();
  });

  test("an in-flight action survives lease release and idle/capacity reclamation", async () => {
    let finish!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = harness({
      idleTtlMs: 5,
      maxTargets: 1,
      overrides: {
        click: async () => {
          started();
          await pending;
          return { ok: true };
        },
      },
    });
    const first = h.runtime.acquire(owner);
    const action = first.bridge.click("e1");
    await running;
    first.release();
    await tick();
    const second = h.runtime.acquire({ ownerId: "task-2", partition: owner.partition });
    expect((await second.bridge.snapshot()).detail).toContain("target limit reached");
    expect(h.runtime.stats().liveTargets).toBe(1);
    finish();
    expect(await action).toMatchObject({ ok: true });
    await tick();
    expect(h.runtime.stats().liveTargets).toBe(0);
    second.release();
    h.runtime.closeAll();
  });
});

test("closing an owner during target creation closes the late host without resurrecting the lease", async () => {
  let finish!: () => void;
  let started!: () => void;
  const opening = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const h = harness({
    beforeOpen: async () => {
      started();
      await pending;
    },
  });
  const lease = h.runtime.acquire({
    ownerId: "child-binding-1",
    partition: "persist:parent-profile",
  });
  const snapshot = lease.bridge.snapshot();
  await opening;
  h.runtime.close("child-binding-1");
  finish();
  expect((await snapshot).detail).toContain("released while opening");
  expect(h.state.closed).toBe(true);
  expect(h.runtime.stats()).toEqual({ entries: 0, liveTargets: 0, leased: 0 });
  expect(await lease.bridge.navigate("https://example.com/")).toMatchObject({ ok: false });
  expect(h.openOptions).toHaveLength(1);
  lease.release();
  h.runtime.closeAll();
});
