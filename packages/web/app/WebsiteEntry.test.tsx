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
async function mount(
  address: string,
  mode: "passcode" | "cloud" | "offline",
  options: { role?: "admin" | "member"; cloudOffline?: boolean; cloudSessionMs?: number } = {},
) {
  ensureMiniDom();
  const redirects: string[] = [];
  const location = Object.assign(new URL(address), {
    replace: (destination: string) => redirects.push(destination),
  });
  const origin = location.origin;
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
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const account = { id, username: "fixture-user", displayName: "测试管理员", role: options.role };
  const overview = {
    account,
    security: { hasPassword: true, githubLinked: false },
    capabilities: {
      sessions: true,
      passwordChange: true,
      admin: options.role === "admin",
      links: false,
    },
    stats: { activeSessions: 1, loginMethods: 1 },
    features,
  };
  globalThis.fetch = (async (input) => {
    const path = String(input);
    calls.push(path);
    if (mode === "offline") return Response.json({ error: "owned offline" }, { status: 503 });
    if (options.cloudOffline && path.startsWith("/api/v1/cloud-browser/"))
      return Response.json({ error: "owned cloud offline" }, { status: 503 });
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
      return Response.json(
        options.role
          ? {
              authenticated: true,
              csrfToken: "C".repeat(43),
              account,
              overview,
              session: { id, expiresAt: Date.now() + 600000 },
              cloudTarget: {
                enabled: true,
                cloudOrigin: origin,
                accountOrigin: origin,
                installationId: id,
              },
            }
          : {
              authenticated: false,
              refreshRequired: false,
              cloudTarget: { enabled: false },
            },
      );
    if (path === "/api/v1/account/web/cloud-tickets")
      return Response.json({
        ticket: "T".repeat(43),
        expiresAt: Date.now() + 60000,
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId: id,
      });
    if (path === "/api/v1/cloud-browser/session")
      return Response.json({
        authenticated: true,
        mode: "cloud-account",
        session: {
          id,
          kind: "cloud-management",
          audience: origin,
          installationId: id,
          accountOrigin: origin,
          accountId: id,
          managementEpoch: id,
          expiresAt: Date.now() + (options.cloudSessionMs ?? 600000),
        },
      });
    if (path === "/api/v1/projects")
      return Response.json({ runtime: "docker", available: true, projects: [] });
    if (path === "/api/v1/cloud-browser/environment") return Response.json({}, { status: 404 });
    if (path === "/api/v1/account/web/overview") return Response.json(overview);
    if (path === "/api/v1/account/web/admin/summary")
      return Response.json({
        users: { total: 2, active: 2, disabled: 0, administrators: 1 },
        sessions: { active: 2 },
        auditEvents: 0,
      });
    if (path.startsWith("/api/v1/account/web/admin/audit?"))
      return Response.json({ events: [], nextCursor: null });
    if (path.startsWith("/api/v1/account/web/admin/users?"))
      return Response.json({ users: [], nextCursor: null });
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
  if (options.role)
    for (let i = 0; i < 5; i++)
      await act(async () => {
        await flushMicrotasks();
      });
  return { container, calls, redirects };
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

test("the official administrator landing page works with Cloud unavailable and never requests Cloud authority", async () => {
  const view = await mount("https://codeshell.site/admin", "cloud", {
    role: "admin",
    cloudOffline: true,
  });
  expect(text(view.container)).toContain("管理后台");
  expect(text(view.container)).toContain("账号管理");
  expect(view.calls).toContain("/api/v1/account/web/admin/summary");
  expect(view.calls.some((path) => path.startsWith("/api/v1/cloud-browser/"))).toBe(false);
  expect(view.calls).not.toContain("/api/v1/account/web/cloud-tickets");
});

test("account settings remain available without creating a Cloud session", async () => {
  const view = await mount("https://codeshell.site/settings/account/profile", "cloud", {
    role: "member",
    cloudOffline: true,
  });
  expect(text(view.container)).toContain("账号资料");
  expect(view.calls).toContain("/api/v1/account/web/overview");
  expect(view.calls.some((path) => path.startsWith("/api/v1/cloud-browser/"))).toBe(false);
  expect(view.calls).not.toContain("/api/v1/account/web/cloud-tickets");
});

test("a member opening the admin URL cannot read administrator data", async () => {
  const view = await mount("https://codeshell.site/admin/users", "cloud", { role: "member" });
  expect(text(view.container)).toContain("没有管理员权限");
  expect(view.calls.some((path) => path.startsWith("/api/v1/account/web/admin/"))).toBe(false);
  expect(view.calls).not.toContain("/api/v1/account/web/cloud-tickets");
});

test("anonymous administrator visits preserve the safe login destination", async () => {
  const view = await mount("https://codeshell.site/admin/?token=secret", "cloud");
  expect(view.redirects).toContain("/login?returnTo=%2Fadmin%2Fsummary");
  expect(view.calls.some((path) => path.startsWith("/api/v1/cloud-browser/"))).toBe(false);
  expect(view.calls.some((path) => path.startsWith("/api/v1/account/web/admin/"))).toBe(false);
});

test("a mounted workspace continues renewing while admin and account pages retain its draft", async () => {
  const view = await mount("https://codeshell.site/app", "cloud", {
    role: "admin",
    cloudSessionMs: 31000,
  });
  function all(node: any): any[] {
    return [node, ...Array.from(node.childNodes ?? []).flatMap(all)];
  }
  function props(node: any) {
    return node[Object.keys(node).find((key) => key.startsWith("__reactProps"))!];
  }
  const projectInput = () =>
    all(view.container).find(
      (node) => node.tagName === "INPUT" && props(node)?.placeholder === "例如：我的第一个工作区",
    );
  const input = projectInput();
  expect(input).toBeDefined();
  await act(async () => {
    props(input).onChange({ target: { value: "保留的工作区草稿" } });
    await flushMicrotasks();
  });
  for (const pathname of ["/admin", "/settings/account/profile"]) {
    await act(async () => {
      window.location.href = `https://codeshell.site${pathname}`;
      window.dispatchEvent({ type: "popstate" } as Event);
      await flushMicrotasks();
    });
    for (let i = 0; i < 5; i++)
      await act(async () => {
        await flushMicrotasks();
      });
    const admissionCount = view.calls.filter(
      (path) => path === "/api/v1/cloud-browser/session",
    ).length;
    expect(projectInput()).toBe(input);
    expect(props(input).value).toBe("保留的工作区草稿");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await flushMicrotasks();
    });
    expect(
      view.calls.filter((path) => path === "/api/v1/cloud-browser/session").length,
    ).toBeGreaterThan(admissionCount);
    expect(projectInput()).toBe(input);
    expect(props(input).value).toBe("保留的工作区草稿");
  }
});
