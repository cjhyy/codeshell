import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PanelAppHost } from "./PanelAppHost";

let root: Root | null = null;
let container: HTMLElement;
let attached = false;
const bindings: Array<Record<string, unknown>> = [];

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
        visible={visible}
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
      if (!attached) {
        throw new Error(
          "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
        );
      }
      return 42;
    },
  });
  attached = false;
  bindings.length = 0;
  Object.assign(window, {
    codeshell: {
      preparePanelApp: async () => ({
        id: descriptor.id,
        src: "cspanel://job-hunt-hq-host/app/index.html",
        partition: "cspanel:job-hunt-hq-host:project",
        revision: descriptor.revision,
      }),
      bindPanelApp: async (binding: Record<string, unknown>) => {
        bindings.push(binding);
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
  test("waits for dom-ready when Electron rejects the early guest-id lookup", async () => {
    await render();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bindings).toEqual([]);

    const webview = findElement(container, "webview");
    expect(webview).not.toBeNull();
    attached = true;
    await act(async () => {
      webview?.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      guestId: 42,
      appDescriptorId: descriptor.id,
      projectPath: "/repo",
      visible: true,
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
});
