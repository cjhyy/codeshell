import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PanelAppHost } from "./PanelAppHost";

let root: Root | null = null;
let container: HTMLElement;
let attached = false;
let guestIdReads = 0;
let prepareError: Error | null = null;
let prepareCalls = 0;
const bindings: Array<Record<string, unknown>> = [];
const states: Array<{ tabId: string; state: string; error?: string }> = [];
let bindResult: () => Promise<boolean>;
const stateChanged = (tabId: string, state: string, error?: string) =>
  states.push({ tabId, state, error });
function props(node: HTMLElement): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

function findElement(node: unknown, tagName: string): HTMLElement | null {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  if (current.tagName === tagName.toUpperCase()) return current as unknown as HTMLElement;
  for (const child of current.childNodes ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return null;
}

const descriptor = {
  id: "panel-app:job-hunt-hq",
  appId: "job-hunt-hq",
  title: "Job Hunt HQ",
  version: "2.3.0",
  icon: "briefcase-business",
  singleton: true,
  hostId: "job-hunt-hq-host",
  revision: "revision-1",
  permissions: [],
} as const;

async function render(visible = true): Promise<void> {
  await act(async () => {
    root?.render(
      <PanelAppHost
        descriptor={descriptor}
        tabId="job-hunt-1"
        bucket="repo::session"
        busy={false}
        projectPath="/repo"
        cwd="/repo"
        engineSessionId="session-1"
        modelKey="codex/gpt-5.6-sol"
        permissionMode="acceptEdits"
        planMode={false}
        hasGoal={true}
        visible={visible}
        onStateChange={stateChanged}
      />,
    );
    await flushMicrotasks();
  });
}

beforeEach(() => {
  ensureMiniDom();
  // `writable` matters: this redefines a property on the shared
  // documentElement, so a later test in the same process that does
  // `Object.assign(document.documentElement, ...)` would otherwise throw on a
  // readonly property (see TerminalPanel.workspace.test.tsx).
  Object.defineProperty(document.documentElement, "classList", {
    configurable: true,
    writable: true,
    value: { contains: () => false },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  Object.defineProperty(HTMLElement.prototype, "getWebContentsId", {
    configurable: true,
    value() {
      guestIdReads += 1;
      if (!attached) {
        throw new Error(
          "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
        );
      }
      return 42;
    },
  });
  attached = false;
  guestIdReads = 0;
  prepareError = null;
  prepareCalls = 0;
  bindings.length = 0;
  states.length = 0;
  bindResult = async () => true;
  Object.assign(window, {
    codeshell: {
      preparePanelApp: async () => {
        prepareCalls += 1;
        if (prepareError) throw prepareError;
        return {
          id: descriptor.id,
          src: "cspanel://job-hunt-hq-host/app/index.html",
          partition: "cspanel:job-hunt-hq-host:project",
          revision: descriptor.revision,
        };
      },
      bindPanelApp: async (binding: Record<string, unknown>) => {
        bindings.push(binding);
        return bindResult();
      },
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
  delete (HTMLElement.prototype as HTMLElement & { getWebContentsId?: () => number })
    .getWebContentsId;
});

describe("PanelAppHost webview readiness", () => {
  test("does not read the guest id until dom-ready", async () => {
    await render();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bindings).toEqual([]);
    expect(guestIdReads).toBe(0);

    const webview = findElement(container, "webview");
    expect(webview).not.toBeNull();
    attached = true;
    await act(async () => {
      webview?.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });

    expect(bindings).toHaveLength(1);
    expect(guestIdReads).toBe(1);
    expect(bindings[0]).toMatchObject({
      guestId: 42,
      appDescriptorId: descriptor.id,
      projectPath: "/repo",
      visible: true,
      modelKey: "codex/gpt-5.6-sol",
      permissionMode: "acceptEdits",
      planMode: false,
      hasGoal: true,
    });
  });

  test("re-binds an already-ready guest when host context changes", async () => {
    await render(false);
    const webview = findElement(container, "webview");
    attached = true;
    await act(async () => {
      webview?.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });
    expect(bindings.at(-1)).toMatchObject({ visible: false });

    await render(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    });
    expect(bindings.at(-1)).toMatchObject({ visible: true });
  });

  test("renders an in-place retry after a transient prepare failure", async () => {
    prepareError = new Error("temporary prepare failure");
    await render();
    expect(prepareCalls).toBe(1);
    expect(findElement(container, "webview")).toBeNull();
    expect(findElement(container, "button")).not.toBeNull();
    expect(
      states.some(
        (event) => event.state === "error" && event.error === "temporary prepare failure",
      ),
    ).toBe(true);
  });

  test("reports ready only after Main accepts the attached source binding", async () => {
    let accept!: (value: boolean) => void;
    bindResult = () =>
      new Promise((resolve) => {
        accept = resolve;
      });
    await render();
    expect(states.some((event) => event.state === "ready")).toBe(false);
    attached = true;
    await act(async () => {
      findElement(container, "webview")!.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });
    expect(bindings).toHaveLength(1);
    expect(states.some((event) => event.state === "ready")).toBe(false);
    await act(async () => {
      accept(true);
      await flushMicrotasks();
    });
    expect(states.filter((event) => event.state === "ready")).toEqual([
      { tabId: "job-hunt-1", state: "ready", error: undefined },
    ]);
  });

  test("a refused binding reports failure and can become ready after the inline retry", async () => {
    bindResult = async () => false;
    await render();
    attached = true;
    await act(async () => {
      findElement(container, "webview")!.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });
    expect(states.some((event) => event.state === "ready")).toBe(false);
    expect(
      states.some((event) => event.state === "error" && /binding/.test(event.error ?? "")),
    ).toBe(true);
    bindResult = async () => true;
    await act(async () => {
      props(findElement(container, "button")!).onClick();
      await flushMicrotasks();
    });
    expect(prepareCalls).toBe(2);
    await act(async () => {
      findElement(container, "webview")!.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });
    expect(states.filter((event) => event.state === "ready")).toHaveLength(1);
  });

  test("superseded and unmounted bind completions cannot report a ready source", async () => {
    const accepts: Array<(value: boolean) => void> = [];
    bindResult = () => new Promise((resolve) => accepts.push(resolve));
    await render(false);
    attached = true;
    await act(async () => {
      findElement(container, "webview")!.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });
    await render(true);
    expect(accepts).toHaveLength(2);
    await act(async () => {
      accepts[0]!(true);
      await flushMicrotasks();
    });
    expect(states.some((event) => event.state === "ready")).toBe(false);
    await act(async () => {
      root?.unmount();
      root = null;
      accepts[1]!(true);
      await flushMicrotasks();
    });
    expect(states.some((event) => event.state === "ready")).toBe(false);
  });

  test("only a main-frame document navigation invalidates the ready source", async () => {
    await render();
    attached = true;
    const view = findElement(container, "webview")!;
    await act(async () => {
      view.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });
    const subframe = new Event("did-start-navigation");
    Object.assign(subframe, { isMainFrame: false, isInPlace: false });
    await act(async () => {
      view.dispatchEvent(subframe);
      await flushMicrotasks();
    });
    expect(states.at(-1)!.state).toBe("ready");
    const mainFrame = new Event("did-start-navigation");
    Object.assign(mainFrame, { isMainFrame: true, isInPlace: false });
    await act(async () => {
      view.dispatchEvent(mainFrame);
      await flushMicrotasks();
    });
    expect(states.at(-1)!.state).toBe("loading");
    await act(async () => {
      view.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });
    expect(states.at(-1)!.state).toBe("ready");
  });
});
