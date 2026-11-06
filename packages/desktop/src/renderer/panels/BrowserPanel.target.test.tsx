import { afterEach, beforeEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BrowserPanelAccessPrompt } from "../../preload/browser-panel-access-api";
import type { BrowserRuntimeHandoffStatus } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ToastProvider, useToastHistory } from "../ui/ToastProvider";
import { BrowserPanel } from "./BrowserPanel";

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function elements(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => elements(child, tag)),
  ];
}

function textOf(node: any): string {
  return (node.nodeValue ?? node.textContent ?? "") + (node.childNodes ?? []).map(textOf).join("");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLElement;
let sessionId: string;
let partition: string;
let bucketPrefix: string;
let requestAccess: (prompt: BrowserPanelAccessPrompt) => void;
let accessAnswers: Array<[string, boolean]>;
let visible: boolean;
let statuses: Map<string, BrowserRuntimeHandoffStatus>;
let grants: Array<{ sessionId: string; guestId: number; lifetime?: string }>;
let revokes: string[];
let popupCount: number;
let toastCount: number;
let openTab: (payload: { url: string; bucket?: string }) => void;
let grantResult: ReturnType<typeof deferred<BrowserRuntimeHandoffStatus>> | null;
let statusResult: ReturnType<typeof deferred<BrowserRuntimeHandoffStatus>> | null;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const intervals = new Map<number, () => void>();
const evictionTimers = new Map<number, () => void>();
let timerId = 100_000;

function ToastObserver() {
  toastCount = useToastHistory()?.history.length ?? 0;
  return null;
}

async function render() {
  await act(async () => {
    root.render(
      <ToastProvider>
        <ToastObserver />
        <BrowserPanel
          cwd="/repo"
          engineSessionId={sessionId}
          bucket={`${bucketPrefix}::${sessionId}`}
          partition={partition}
          initialUrl="https://example.test/a"
          visible={visible}
        />
      </ToastProvider>,
    );
    await flushMicrotasks();
  });
}

function button(label: string) {
  return elements(container, "BUTTON").find(
    (node) => props(node)["aria-label"] === label || textOf(node) === label,
  );
}

async function click(node: any) {
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onClick();
    await flushMicrotasks();
  });
}

async function ready(index: number, id: number, title: string) {
  const view = elements(container, "WEBVIEW")[index];
  Object.assign(view, {
    canGoBack: () => false,
    canGoForward: () => false,
    getWebContentsId: () => id,
  });
  await act(async () => {
    view.dispatchEvent(new Event("dom-ready"));
    view.dispatchEvent(Object.assign(new Event("page-title-updated"), { title }));
    await flushMicrotasks();
  });
  return view;
}

beforeEach(async () => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem() {} },
  });
  sessionId = "session-a";
  partition = "persist:browser:p:project";
  bucketPrefix = "project";
  accessAnswers = [];
  visible = true;
  statuses = new Map();
  grants = [];
  revokes = [];
  popupCount = toastCount = 0;
  grantResult = statusResult = null;
  intervals.clear();
  evictionTimers.clear();
  globalThis.setInterval = ((callback: () => void) => {
    const id = ++timerId;
    intervals.set(id, callback);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    intervals.delete(id);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 300_000) return originalSetTimeout(callback, delay, ...args);
    const id = ++timerId;
    evictionTimers.set(id, callback);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (!evictionTimers.delete(id as unknown as number)) originalClearTimeout(id);
  }) as typeof clearTimeout;
  Object.assign(window, {
    confirm: () => {
      popupCount++;
      return true;
    },
    alert: () => {
      popupCount++;
    },
    codeshell: {
      browserPanelAccess: {
        onRequest(callback: typeof requestAccess) {
          requestAccess = callback;
          return () => {};
        },
        respond(id: string, granted: boolean) {
          accessAnswers.push([id, granted]);
        },
      },
      probeLocalhostPorts: async () => [],
      registerBrowserSessionBucket() {},
      registerBrowserGuest() {},
      onBrowserOpenTab(callback: typeof openTab) {
        openTab = callback;
        return () => {};
      },
      getBuiltInBrowserRuntimeHandoff: async (id: string) =>
        statusResult?.promise ?? statuses.get(id) ?? { sessionId: id, granted: false },
      getChromeBrowserRuntimeStatus: async () => {
        throw new Error("unavailable Chrome");
      },
      grantBuiltInBrowserToRuntime: async (input: (typeof grants)[number]) => {
        grants.push(input);
        if (grantResult) return grantResult.promise;
        const status = {
          sessionId: input.sessionId,
          guestId: input.guestId,
          granted: true,
          title: `Page ${input.guestId}`,
          url: `https://example.test/${input.guestId}`,
        };
        statuses.set(input.sessionId, status);
        return status;
      },
      revokeBuiltInBrowserFromRuntime: async (id: string) => {
        revokes.push(id);
        const status = { sessionId: id, granted: false };
        statuses.set(id, status);
        return status;
      },
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
  });
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

test("selecting the exact tab is quiet and reused across rerenders and Chrome status failures", async () => {
  const view = await ready(0, 42, "A");
  await click(button("用于当前对话"));
  expect(grants).toEqual([{ sessionId: "session-a", guestId: 42, lifetime: "session" }]);
  expect(props(button("当前对话正在使用")).disabled).toBe(true);
  // Even an already queued click on the selected button is idempotent.
  await click(button("当前对话正在使用"));
  await render();
  await act(async () => {
    intervals.forEach((callback) => callback());
    await flushMicrotasks();
  });
  expect(grants).toHaveLength(1);
  expect(revokes).toEqual([]);
  expect(textOf(container)).toContain("当前对话使用：Page 42");
  expect(popupCount).toBe(0);
  expect(toastCount).toBe(0);

  visible = false;
  await render();
  expect(evictionTimers.size).toBe(0);
  expect(elements(container, "WEBVIEW")[0]).toBe(view);
  await click(button("停止使用"));
  expect(evictionTimers.size).toBe(1);
  await act(async () => {
    evictionTimers.forEach((callback) => callback());
    await flushMicrotasks();
  });
  expect(elements(container, "WEBVIEW")).toHaveLength(0);
});

test("another tab replaces the target directly; switching back preserves readiness and blank tabs permit stop", async () => {
  await ready(0, 42, "A");
  await click(button("用于当前对话"));
  await act(async () => {
    openTab({ url: "https://example.test/b", bucket: "project::session-a" });
    await flushMicrotasks();
  });
  await ready(1, 43, "B");
  expect(props(button("用于当前对话")).disabled).toBe(false);
  expect(textOf(container)).toContain("当前对话使用：Page 42");
  await click(button("用于当前对话"));
  expect(grants.map((input) => input.guestId)).toEqual([42, 43]);
  expect(revokes).toEqual([]);
  await click(button("A"));
  expect(props(button("用于当前对话")).disabled).toBe(false);
  await click(button("B"));
  expect(props(button("当前对话正在使用")).disabled).toBe(true);
  await click(button("新选项卡"));
  expect(props(button("用于当前对话")).disabled).toBe(true);
  expect(props(button("停止使用")).disabled).toBe(false);
  await click(button("停止使用"));
  expect(revokes).toEqual(["session-a"]);
  expect(grants).toHaveLength(2);
  expect(button("停止使用")).toBeUndefined();
  expect(popupCount).toBe(0);
  expect(toastCount).toBe(0);
});

test("a pending selection cannot populate a different session or an A→B→A remount", async () => {
  await ready(0, 42, "A");
  grantResult = deferred();
  await click(button("用于当前对话"));
  sessionId = "session-b";
  await render();
  expect(button("停止使用")).toBeUndefined();
  sessionId = "session-a";
  await render();
  await act(async () => {
    grantResult!.resolve({
      sessionId: "session-a",
      guestId: 42,
      granted: true,
      title: "Stale grant",
    });
    await flushMicrotasks();
  });
  expect(button("停止使用")).toBeUndefined();
  expect(textOf(container)).not.toContain("Stale grant");
});

test("an older status request cannot undo a completed explicit selection", async () => {
  await ready(0, 42, "A");
  statusResult = deferred();
  await act(async () => {
    intervals.forEach((callback) => callback());
    await flushMicrotasks();
  });
  await click(button("用于当前对话"));
  await act(async () => {
    statusResult!.resolve({ sessionId: "session-a", granted: false });
    await flushMicrotasks();
  });
  expect(props(button("当前对话正在使用")).disabled).toBe(true);
  expect(textOf(container)).toContain("当前对话使用：Page 42");
});

test("an old timed grant is upgraded once, while another session never inherits the selection", async () => {
  await ready(0, 42, "A");
  statuses.set("session-a", {
    sessionId: "session-a",
    guestId: 42,
    granted: true,
    expiresAt: Date.now() + 1_800_000,
  });
  await act(async () => {
    intervals.forEach((callback) => callback());
    await flushMicrotasks();
  });
  expect(props(button("用于当前对话")).disabled).toBe(false);
  await click(button("用于当前对话"));
  expect(grants).toEqual([{ sessionId: "session-a", guestId: 42, lifetime: "session" }]);
  sessionId = "session-b";
  await render();
  expect(button("停止使用")).toBeUndefined();
  expect(props(button("用于当前对话")).disabled).toBe(false);
  expect(grants).toHaveLength(1);
  sessionId = "session-a";
  await render();
  expect(props(button("当前对话正在使用")).disabled).toBe(true);
  expect(grants).toHaveLength(1);
});

test("a failed selection reports an inline error and permits retry without any popup", async () => {
  await ready(0, 42, "A");
  grantResult = deferred();
  await click(button("用于当前对话"));
  await act(async () => {
    grantResult!.reject(new Error("guest closed"));
    await flushMicrotasks();
  });
  expect(textOf(container)).toContain("无法使用此标签: guest closed");
  expect(props(button("用于当前对话")).disabled).toBe(false);
  expect(popupCount).toBe(0);
  expect(toastCount).toBe(0);
  grantResult = null;
  await click(button("用于当前对话"));
  expect(props(button("当前对话正在使用")).disabled).toBe(true);
  expect(textOf(container)).not.toContain("guest closed");
});

test("a failed status check preserves the selected guest until an explicit ungranted response", async () => {
  const view = await ready(0, 42, "A");
  await click(button("用于当前对话"));
  visible = false;
  await render();
  statusResult = deferred();
  await act(async () => {
    intervals.forEach((callback) => callback());
    statusResult!.reject(new Error("status temporarily unavailable"));
    await flushMicrotasks();
  });
  expect(textOf(container)).toContain("暂时无法核对标签状态，正在重试");
  expect(evictionTimers.size).toBe(0);
  expect(elements(container, "WEBVIEW")[0]).toBe(view);
  statusResult = null;
  statuses.set("session-a", { sessionId: "session-a", granted: false });
  await act(async () => {
    intervals.forEach((callback) => callback());
    await flushMicrotasks();
  });
  expect(button("停止使用")).toBeUndefined();
  expect(evictionTimers.size).toBe(1);
  expect(grants).toHaveLength(1);
});

test("late inactive guest readiness never substitutes the currently visible guest identity", async () => {
  const a = await ready(0, 42, "A");
  await act(async () => {
    openTab({ url: "https://example.test/b" });
    await flushMicrotasks();
  });
  await ready(1, 43, "B");
  await act(async () => {
    a.dispatchEvent(new Event("dom-ready"));
    await flushMicrotasks();
  });
  await click(button("用于当前对话"));
  expect(grants.at(-1)?.guestId).toBe(43);
  await click(button("A"));
  await click(button("用于当前对话"));
  expect(grants.at(-1)?.guestId).toBe(42);
  visible = false;
  await render();
  // Only B may be evicted; the selected A remains pinned.
  await act(async () => {
    evictionTimers.forEach((callback) => callback());
    await flushMicrotasks();
  });
  expect(elements(container, "WEBVIEW")).toEqual([a]);
});

test("a late Chrome pairing response cannot populate another session or show a success popup", async () => {
  const pairing =
    deferred<Awaited<ReturnType<typeof window.codeshell.beginChromeBrowserRuntimePairing>>>();
  window.codeshell.beginChromeBrowserRuntimePairing = async () => pairing.promise;
  window.codeshell.getChromeBrowserRuntimeInstallation = async () =>
    ({
      extensionPath: "/test/extension",
    }) as Awaited<ReturnType<typeof window.codeshell.getChromeBrowserRuntimeInstallation>>;
  await click(button("连接已登录的 Chrome 标签"));
  sessionId = "session-b";
  await render();
  await act(async () => {
    pairing.resolve({
      sessionId: "session-a",
      connected: false,
      pairing: { code: "TEST", label: "Test", expiresAt: 123 },
    });
    await flushMicrotasks();
  });
  expect(button("断开 Chrome Runtime")).toBeUndefined();
  expect(button("连接已登录的 Chrome 标签")).toBeDefined();
  expect(textOf(container)).not.toContain("TEST");
  expect(toastCount).toBe(0);
});

const accessRequest = (
  overrides: Partial<BrowserPanelAccessPrompt> = {},
): BrowserPanelAccessPrompt => ({
  requestId: "request-a",
  sessionId: "session-a",
  guestId: 42,
  url: "https://example.test/a",
  title: "Page A",
  expiresAt: Date.now() + 60_000,
  ...overrides,
});
async function deliverAccess(prompt = accessRequest()) {
  await act(async () => {
    requestAccess(prompt);
    await flushMicrotasks();
  });
}

test("agent requests use only the exact guest and direct selection also answers quietly", async () => {
  await ready(0, 42, "A");
  await deliverAccess(accessRequest({ guestId: 99 }));
  expect(button("允许")).toBeUndefined();
  expect(accessAnswers).toEqual([]);
  await deliverAccess();
  expect(button("允许")).toBeDefined();
  expect(elements(container, "DIV").some((node) => props(node).role === "alertdialog")).toBe(false);
  await click(button("用于当前对话"));
  expect(grants).toEqual([{ sessionId: "session-a", guestId: 42, lifetime: "session" }]);
  expect(accessAnswers).toEqual([["request-a", true]]);
  expect(button("允许")).toBeUndefined();
  expect(popupCount).toBe(0);
  expect(toastCount).toBe(0);
  await deliverAccess(accessRequest({ requestId: "already-selected" }));
  await click(button("允许"));
  expect(grants).toHaveLength(1);
  expect(accessAnswers.at(-1)).toEqual(["already-selected", true]);
});

test("failed grants answer false instead of reporting a successful request", async () => {
  await ready(0, 42, "A");
  grantResult = deferred<BrowserRuntimeHandoffStatus>();
  await deliverAccess();
  await click(button("允许"));
  expect(props(button("拒绝")).disabled).toBe(true);
  await act(async () => {
    grantResult!.reject(new Error("grant refused"));
    await flushMicrotasks();
  });
  expect(accessAnswers).toEqual([["request-a", false]]);
  expect(textOf(container)).toContain("grant refused");
  expect(popupCount).toBe(0);
  expect(toastCount).toBe(0);
});

test.each(["session", "bucket", "profile", "tab", "guest"])(
  "changing %s invalidates the pending exact-target request and queued click",
  async (change) => {
    await ready(0, 42, "A");
    await deliverAccess();
    const allow = props(button("允许")).onClick;
    const oldListener = requestAccess;
    if (change === "session") sessionId = "session-b";
    if (change === "bucket") bucketPrefix = "other-project";
    if (change === "profile") partition = "persist:browser:p:other";
    if (change === "tab") await click(button("新选项卡"));
    else if (change === "guest") await ready(0, 43, "Replacement");
    else await render();
    expect(accessAnswers).toEqual([["request-a", false]]);
    expect(button("允许")).toBeUndefined();
    await act(async () => {
      allow();
      oldListener(accessRequest({ requestId: "late" }));
      await flushMicrotasks();
    });
    expect(grants).toEqual([]);
    expect(button("允许")).toBeUndefined();
  },
);

test("an expired queued Allow cannot grant the tab", async () => {
  await ready(0, 42, "A");
  const deadline = Date.now() + 60_000;
  await deliverAccess(accessRequest({ expiresAt: deadline }));
  const allow = props(button("允许")).onClick;
  const original = Date.now;
  try {
    Date.now = () => deadline + 1;
    await act(async () => {
      allow();
      await flushMicrotasks();
    });
  } finally {
    Date.now = original;
  }
  expect(accessAnswers).toEqual([["request-a", false]]);
  expect(grants).toEqual([]);
});

test("a grant finishing after scope changes never answers a different session's request", async () => {
  await ready(0, 42, "A");
  grantResult = deferred<BrowserRuntimeHandoffStatus>();
  await deliverAccess();
  await click(button("允许"));
  sessionId = "session-b";
  await render();
  expect(accessAnswers).toEqual([["request-a", false]]);
  await act(async () => {
    grantResult!.resolve({ sessionId: "session-a", guestId: 42, granted: true });
    await flushMicrotasks();
  });
  expect(accessAnswers).toEqual([["request-a", false]]);
  expect(textOf(container)).not.toContain("当前对话使用：");
});

test.each([{ granted: false }, { granted: true, guestId: 99 }])(
  "an ungranted or mismatched status cannot answer Allow as success: %j",
  async (result) => {
    await ready(0, 42, "A");
    grantResult = deferred<BrowserRuntimeHandoffStatus>();
    await deliverAccess();
    await click(button("允许"));
    await act(async () => {
      grantResult!.resolve({ sessionId: "session-a", ...result });
      await flushMicrotasks();
    });
    expect(accessAnswers).toEqual([["request-a", false]]);
  },
);
