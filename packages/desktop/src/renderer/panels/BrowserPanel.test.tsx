import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NEW_TAB } from "../browser/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { BrowserAddressField, BrowserPanel } from "./BrowserPanel";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

let root: Root | null = null;
let container: HTMLElement;
let url = "https://committed.example/path";
let draft = url;
let copyResult = true;
let rejectOpen = false;
const copied: string[] = [];
const opened: string[] = [];
const toasts: Array<{ message: string; variant?: string }> = [];

const runtime = {
  openExternal: async (value: string) => {
    opened.push(value);
    if (rejectOpen) throw new Error("OS rejected open");
  },
  copyText: async (value: string) => {
    copied.push(value);
    return copyResult;
  },
  toast: (value: { message: string; variant?: string }) => toasts.push(value),
};

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <BrowserAddressField
        url={url}
        draft={draft}
        onDraftChange={(value) => {
          draft = value;
        }}
        onNavigate={() => undefined}
        runtime={runtime}
      />,
    );
    await flushMicrotasks();
  });
}

async function openContextMenu(): Promise<any[]> {
  const input = findElements(container, "INPUT")[0];
  await act(async () => {
    reactPropsOf(input).onContextMenu({
      preventDefault() {},
      metaKey: false,
      ctrlKey: false,
      clientX: 10,
      clientY: 20,
    });
    await flushMicrotasks();
  });
  return findElements(document.body, "BUTTON").filter(
    (node) => reactPropsOf(node).role === "menuitem",
  );
}

beforeEach(async () => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 240 },
    offsetHeight: { configurable: true, get: () => 80 },
  });
  Object.assign(window, {
    innerWidth: 1200,
    innerHeight: 800,
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: () => undefined,
  });
  url = "https://committed.example/path";
  draft = url;
  copyResult = true;
  rejectOpen = false;
  copied.length = 0;
  opened.length = 0;
  toasts.length = 0;
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("BrowserPanel address actions", () => {
  test("right-click copies the committed URL rather than the editable draft and reports result", async () => {
    const input = findElements(container, "INPUT")[0];
    await act(async () => {
      reactPropsOf(input).onChange({ target: { value: "https://draft.example/not-loaded" } });
      await flushMicrotasks();
    });

    let items = await openContextMenu();
    await act(async () => {
      reactPropsOf(items[0]).onClick();
      await flushMicrotasks();
    });
    expect(copied).toEqual(["https://committed.example/path"]);
    expect(toasts.at(-1)?.variant).toBe("success");

    copyResult = false;
    items = await openContextMenu();
    await act(async () => {
      reactPropsOf(items[0]).onClick();
      await flushMicrotasks();
    });
    expect(toasts.at(-1)?.variant).toBe("error");
  });

  test("Cmd/Ctrl opens exactly once, normal click does nothing, and rejection toasts", async () => {
    const props = reactPropsOf(findElements(container, "INPUT")[0]);
    props.onClick({ metaKey: false, ctrlKey: false, preventDefault() {} });
    expect(opened).toEqual([]);

    await act(async () => {
      props.onClick({ metaKey: true, ctrlKey: false, preventDefault() {} });
      await flushMicrotasks();
    });
    expect(opened).toEqual(["https://committed.example/path"]);

    rejectOpen = true;
    await act(async () => {
      props.onClick({ metaKey: false, ctrlKey: true, preventDefault() {} });
      await flushMicrotasks();
    });
    expect(opened).toHaveLength(2);
    expect(toasts.at(-1)?.variant).toBe("error");
  });

  test("NEW_TAB disables both actions and file/javascript URLs never open externally", async () => {
    url = NEW_TAB;
    draft = "";
    await render();
    let items = await openContextMenu();
    reactPropsOf(items[0]).onClick();
    reactPropsOf(items[1]).onClick();
    expect(copied).toEqual([]);
    expect(opened).toEqual([]);

    for (const blocked of ["file:///tmp/secret", "javascript:alert(1)"]) {
      url = blocked;
      draft = blocked;
      await render();
      const props = reactPropsOf(findElements(container, "INPUT")[0]);
      props.onClick({ metaKey: true, ctrlKey: false, preventDefault() {} });
      items = await openContextMenu();
      reactPropsOf(items[1]).onClick();
    }
    expect(opened).toEqual([]);
  });
});

test("a changed login partition remounts only the guest and retains the current tab URL", async () => {
  const registrations: Array<{ partition: string }> = [];
  Object.assign(window, {
    codeshell: {
      registerBrowserSessionBucket: (input: { partition: string }) => registrations.push(input),
      registerBrowserGuest: () => undefined,
      getBuiltInBrowserRuntimeHandoff: async () => ({ granted: false, sessionId: "session" }),
      getChromeBrowserRuntimeStatus: async () => ({ connected: false, sessionId: "session" }),
    },
  });
  const renderPanel = async (partition: string) => {
    await act(async () => {
      root?.render(
        <BrowserPanel
          cwd="/repo"
          bucket="project::session"
          engineSessionId="session"
          partition={partition}
          initialUrl="https://example.test/start"
        />,
      );
      await flushMicrotasks();
    });
  };
  const oldPartition = "persist:browser:project::session";
  const projectPartition = "persist:browser:p:project";
  const handoffButton = () =>
    findElements(container, "BUTTON").find(
      (button) => String(reactPropsOf(button)["aria-label"]) === "用于当前对话",
    );
  await renderPanel(oldPartition);
  const original = findElements(container, "WEBVIEW")[0];
  expect(original).toBeDefined();
  original.canGoBack = () => false;
  original.canGoForward = () => false;
  original.getWebContentsId = () => 42;
  await act(async () => {
    original.dispatchEvent(new Event("dom-ready"));
    original.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://example.test/current" }),
    );
    await flushMicrotasks();
  });
  await renderPanel(oldPartition);
  expect(findElements(container, "WEBVIEW")[0]).toBe(original);
  expect(reactPropsOf(handoffButton()).disabled).toBe(false);

  await renderPanel(projectPartition);
  const views = findElements(container, "WEBVIEW");
  expect(views).toHaveLength(1);
  expect(views[0]).not.toBe(original);
  expect(views[0].getAttribute("partition")).toBe(projectPartition);
  expect(views[0].getAttribute("src")).toBe("https://example.test/current");
  expect(registrations.at(-1)?.partition).toBe(projectPartition);
  expect(reactPropsOf(handoffButton()).disabled).toBe(true);

  views[0].canGoBack = () => false;
  views[0].canGoForward = () => false;
  views[0].getWebContentsId = () => 43;
  await act(async () => {
    views[0].dispatchEvent(new Event("dom-ready"));
    views[0].dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://example.test/new-profile" }),
    );
    await flushMicrotasks();
  });
  expect(reactPropsOf(handoffButton()).disabled).toBe(false);
  const address = () => reactPropsOf(findElements(container, "INPUT")[0]).value;
  expect(address()).toBe("https://example.test/new-profile");
  await act(async () => {
    original.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://example.test/stale" }),
    );
    await flushMicrotasks();
  });
  expect(address()).toBe("https://example.test/new-profile");
  await renderPanel(projectPartition);
  expect(findElements(container, "WEBVIEW")[0]).toBe(views[0]);
});

test("an agent's panel access request grants this tab only when the user allows it", async () => {
  let deliver!: (prompt: Record<string, unknown>) => void;
  const answers: Array<[string, boolean]> = [];
  const grants: Array<{ sessionId: string; guestId: number }> = [];
  Object.assign(window, {
    codeshell: {
      registerBrowserSessionBucket: () => undefined,
      registerBrowserGuest: () => undefined,
      getBuiltInBrowserRuntimeHandoff: async () => ({ granted: false, sessionId: "session" }),
      getChromeBrowserRuntimeStatus: async () => ({ connected: false, sessionId: "session" }),
      grantBuiltInBrowserToRuntime: async (input: { sessionId: string; guestId: number }) => {
        grants.push(input);
        return { granted: true, sessionId: input.sessionId, guestId: input.guestId };
      },
      browserPanelAccess: {
        onRequest: (cb: typeof deliver) => {
          deliver = cb;
          return () => undefined;
        },
        respond: (requestId: string, granted: boolean) => answers.push([requestId, granted]),
      },
    },
  });
  await act(async () => {
    root?.render(
      <BrowserPanel
        cwd="/repo"
        bucket="project::session"
        engineSessionId="session"
        partition="persist:browser:p:project"
        initialUrl="https://example.test/start"
      />,
    );
    await flushMicrotasks();
  });
  const view = findElements(container, "WEBVIEW")[0];
  view.canGoBack = () => false;
  view.canGoForward = () => false;
  view.getWebContentsId = () => 42;
  await act(async () => {
    view.dispatchEvent(new Event("dom-ready"));
    await flushMicrotasks();
  });
  const prompt = (requestId: string, sessionId = "session") => ({
    requestId,
    sessionId,
    guestId: 42,
    url: "https://example.test/start",
    title: "Start",
    expiresAt: Date.now() + 60_000,
  });
  const bar = () =>
    findElements(container, "DIV").find((d) => d.getAttribute?.("role") === "status");
  const button = (label: string) =>
    findElements(bar(), "BUTTON").find((b) => b.textContent === label);

  await act(async () => {
    deliver(prompt("other", "another-session"));
    await flushMicrotasks();
  });
  expect(bar()).toBeUndefined();

  await act(async () => {
    deliver(prompt("r1"));
    await flushMicrotasks();
  });
  expect(bar()).toBeDefined();
  await act(async () => {
    reactPropsOf(button("拒绝") ?? button("Deny")).onClick();
    await flushMicrotasks();
  });
  expect(answers).toEqual([["r1", false]]);
  expect(grants).toEqual([]);
  expect(bar()).toBeUndefined();

  await act(async () => {
    deliver(prompt("r2"));
    await flushMicrotasks();
  });
  await act(async () => {
    reactPropsOf(button("允许") ?? button("Allow")).onClick();
    await flushMicrotasks();
  });
  expect(grants).toEqual([{ sessionId: "session", guestId: 42, lifetime: "session" }]);
  expect(answers).toEqual([
    ["r1", false],
    ["r2", true],
  ]);
});
