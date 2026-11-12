import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { WebsiteEntry } from "./WebsiteShell.js";

const originalFetch = globalThis.fetch;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  globalThis.fetch = originalFetch;
});
function text(node: any): string {
  return `${node.nodeValue ?? node.textContent ?? ""}${Array.from(node.childNodes ?? [])
    .map(text)
    .join("")}`;
}
async function mount(origin: string, mode: "passcode" | "cloud" | "offline") {
  ensureMiniDom();
  const location = new URL(origin);
  const descriptor = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", { configurable: true, value: location });
  cleanup.push(() =>
    descriptor
      ? Object.defineProperty(window, "location", descriptor)
      : delete (window as any).location,
  );
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: (_name: string, _options: unknown, operation: () => Promise<unknown>) =>
          operation(),
      },
    },
  });
  cleanup.push(() =>
    navigatorDescriptor
      ? Object.defineProperty(globalThis, "navigator", navigatorDescriptor)
      : delete (globalThis as any).navigator,
  );
  const calls: string[] = [];
  const features = {
    "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin: origin } },
  };
  globalThis.fetch = (async (input) => {
    const path = String(input);
    calls.push(path);
    if (mode === "offline") return Response.json({ error: "owned offline" }, { status: 503 });
    if (path === "/api/v1/cloud-browser/capabilities")
      return mode === "passcode"
        ? Response.json({}, { status: 404 })
        : Response.json({
            version: 1,
            mode: "cloud-browser",
            cloudOrigin: origin,
            accountOrigin: origin,
            installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          });
    if (path === "/api/v1/auth/status")
      return Response.json({ initialized: true, authenticated: false, host: "hub" });
    if (path === "/api/v1/environment") return Response.json({}, { status: 404 });
    if (path === "/api/v1/account/status")
      return Response.json({ registrationAllowed: true, githubEnabled: false, features });
    if (path === "/api/v1/account/web/session")
      return Response.json({
        authenticated: false,
        refreshRequired: false,
        cloudTarget: { enabled: false },
      });
    throw new Error(`Unexpected owned request ${path}`);
  }) as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => {
    root.render(<WebsiteEntry setupToken="" />);
    await flushMicrotasks();
  });
  for (let i = 0; i < 30 && !/登录|把它做下去/.test(text(container)); i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  return { container, calls };
}

test("a local Host root still discovers and renders its passcode gate", async () => {
  const view = await mount("http://localhost", "passcode");
  expect(view.calls).toContain("/api/v1/auth/status");
  expect(text(view.container)).toContain("登录");
  expect(text(view.container)).not.toContain("把它做下去");
  expect(view.calls.some((path) => path.startsWith("/api/v1/account/"))).toBe(false);
});

test("a private multi-account Cloud root keeps its inline account login", async () => {
  const view = await mount("https://private-cloud.fixture.invalid", "cloud");
  expect(text(view.container)).toContain("继续你的工作");
  expect(text(view.container)).toContain("没有账号？创建账号");
  expect(view.calls).toContain("/api/v1/account/web/session");
  expect(window.location.pathname).toBe("/");
});

test("the official homepage renders independently of unavailable Account and Cloud services", async () => {
  const view = await mount("https://codeshell.site", "offline");
  expect(text(view.container)).toContain("把它做下去");
  expect(text(view.container)).toContain("沪ICP备2026060456号-1");
  expect(text(view.container)).not.toContain("正在连接工作台");
  expect(view.calls).toEqual(["/api/v1/account/web/session"]);
});
