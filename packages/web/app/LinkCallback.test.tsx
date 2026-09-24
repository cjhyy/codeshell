import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { LinkCallbackPage } from "./LinkCallback.js";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { setApiProject, setApiWorkspace } from "./api-context.js";

test("StrictMode sends one callback exchange and an uncertain outcome is only queried", async () => {
  ensureMiniDom();
  const originalFetch = globalThis.fetch,
    originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "https://hub.example" },
  });
  setApiProject(null);
  setApiWorkspace(undefined);
  const calls: Array<{ method: string; path: string }> = [];
  globalThis.fetch = (async (path, init) => {
    calls.push({ method: init?.method ?? "GET", path: String(path) });
    if (init?.method === "POST") throw new Error("Response lost");
    return Response.json({ id: "one", providerId: "github", state: "connected" });
  }) as typeof fetch;
  const callback = {
    callbackUrl: "https://hub.example/link/callback?code=private&state=one",
    denied: false,
    pending: {
      target:
        "/p/22222222-2222-4222-8222-222222222222/api/v1/links/authorizations/11111111-1111-4111-8111-111111111111",
      state: "one",
      redirectUri: "https://hub.example/link/callback",
      returnUrl: "/?view=links",
      expiresAt: Date.now() + 10000,
    },
  };
  let tree!: React.ReactElement<any>;
  function Mounted() {
    tree = LinkCallbackPage({ callback });
    return tree;
  }
  const root = createRoot(document.createElement("div"));
  function elements(node: React.ReactNode): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const item = node as React.ReactElement<any>;
    return [item, ...elements(item.props.children)];
  }
  try {
    await act(async () => {
      root.render(
        <React.StrictMode>
          <Mounted />
        </React.StrictMode>,
      );
      await flushMicrotasks();
    });
    expect(calls).toEqual([{ method: "POST", path: callback.pending.target + "/complete" }]);
    const check = elements(tree).find((item) => item.type === "button")!;
    expect(check).toBeDefined();
    await act(async () => {
      check.props.onClick();
      await flushMicrotasks();
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(calls[1].path).toBe(callback.pending.target);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  }
});

test("normal startup does not read unavailable session storage and callback failure clears the code", async () => {
  const { readBrowserLinkCallback } = await import("./remote-link-authorization.js");
  ensureMiniDom();
  const keys = ["location", "history", "sessionStorage"] as const;
  const before = keys.map((key) => Object.getOwnPropertyDescriptor(window, key));
  let reads = 0,
    cleaned = "";
  const location = { pathname: "/", origin: "https://hub.example", href: "https://hub.example/" };
  Object.defineProperties(window, {
    location: { configurable: true, value: location },
    history: {
      configurable: true,
      value: {
        state: null,
        replaceState: (_state: unknown, _unused: string, value: string) => {
          cleaned = value;
        },
      },
    },
    sessionStorage: {
      configurable: true,
      get() {
        reads++;
        throw new Error("Storage denied");
      },
    },
  });
  try {
    expect(readBrowserLinkCallback()).toBeUndefined();
    expect(reads).toBe(0);
    location.pathname = "/link/callback";
    location.href += "link/callback?code=private";
    expect(readBrowserLinkCallback()).toHaveProperty("error");
    expect(cleaned).toBe("/link/callback");
  } finally {
    for (const [index, key] of keys.entries()) {
      if (before[index]) Object.defineProperty(window, key, before[index]!);
      else Reflect.deleteProperty(window, key);
    }
  }
});
