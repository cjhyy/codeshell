import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { AccountSessionProvider } from "./AccountSessionProvider.js";
import { DesktopRemoteAccessPage } from "./DesktopRemoteAccess.js";

const cleanup: Array<() => void | Promise<void>> = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  globalThis.fetch = originalFetch;
});
function install(target: object, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  cleanup.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else delete (target as any)[key];
  });
}
function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function text(node: any): string {
  return `${node.nodeValue ?? node.textContent ?? ""}${Array.from(node.childNodes ?? [])
    .map(text)
    .join("")}`;
}
function props(node: any) {
  return node[Object.keys(node).find((key) => key.startsWith("__reactProps"))!];
}
async function action(run: () => unknown) {
  await act(async () => {
    run();
    await flushMicrotasks();
  });
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 150; index++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
  throw new Error("Owned remote access state not reached");
}
async function fixture(initialError: string, status: number) {
  ensureMiniDom();
  const origin = "https://remote-access.fixture.invalid";
  const request = "R".repeat(43);
  install(window, "location", new URL(`/remote-access?request=${request}`, origin));
  install(globalThis, "navigator", {
    locks: { request: (_name: string, _options: unknown, operation: () => unknown) => operation() },
  });
  const state = { error: initialError, status, expired: false };
  const account = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    username: "fixture",
    displayName: "当前账号",
    role: "member",
  };
  const calls: Array<{ path: string; method?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), origin);
    expect(url.origin).toBe(origin);
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    calls.push({ path: url.pathname, method: init?.method });
    if (url.pathname === "/api/v1/account/status")
      return Response.json({ registrationAllowed: true, githubEnabled: false, features: {} });
    if (url.pathname === "/api/v1/account/web/session")
      return Response.json({
        authenticated: true,
        refreshRequired: false,
        csrfToken: "C".repeat(43),
        cloudTarget: null,
        account,
        session: { id: account.id, expiresAt: Date.now() + 900000 },
        overview: {
          account,
          security: { hasPassword: true, githubLinked: false },
          capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
          stats: { activeSessions: 1, loginMethods: 1 },
          features: {},
        },
      });
    if (url.pathname === "/api/v1/account/web/remote-access/request")
      return state.error
        ? Response.json({ error: state.error }, { status: state.status })
        : Response.json({
            deviceName: "发起电脑",
            target: { hostId: account.id, environmentId: account.id, name: "目标电脑" },
            expiresAt: Date.now() + (state.expired ? -1000 : 60000),
          });
    throw new Error(`Unexpected owned request ${url.pathname}`);
  }) as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  let live = true;
  const unmount = async () => {
    if (live) {
      live = false;
      await action(() => root.unmount());
    }
  };
  cleanup.push(unmount);
  await action(() =>
    root.render(
      <AccountSessionProvider>
        <DesktopRemoteAccessPage request={request} />
      </AccountSessionProvider>,
    ),
  );
  await until(() => calls.some((call) => call.path.endsWith("/remote-access/request")));
  const button = (name: string) =>
    nodes(container).find((node) => node.tagName === "BUTTON" && text(node).trim() === name);
  const link = (name: string) =>
    nodes(container).find((node) => node.tagName === "A" && text(node).trim() === name);
  return {
    container,
    calls,
    state,
    button,
    link,
    unmount,
    async click(name: string) {
      const node = button(name);
      expect(node).toBeDefined();
      expect(props(node).disabled).not.toBe(true);
      await action(() => props(node).onClick());
    },
  };
}

test("expired, completed and invalid requests provide recovery instead of an endless read retry", async () => {
  for (const [code, status, message] of [
    ["remote_access_expired", 404, "已失效，或不属于当前账号"],
    ["remote_access_expired", 401, "已失效，或不属于当前账号"],
    ["remote_access_completed", 409, "此连接请求已处理"],
    ["invalid_remote_access_request", 400, "远程连接链接无效"],
  ] as const) {
    const view = await fixture(code, status);
    await until(() => text(view.container).includes(message));
    expect(view.button("重试读取请求")).toBeUndefined();
    expect(view.button("用 Passkey 确认连接")).toBeUndefined();
    expect(view.link("在新页面设置 Passkey")).toBeUndefined();
    const recovery = view.link("打开电脑列表");
    expect(props(recovery).href).toBe("/app?target=choose");
    expect(props(recovery).target).toBe("_blank");
    expect(view.button("换个账号登录")).toBeDefined();
    expect(view.calls.filter((call) => call.path.endsWith("/remote-access/request"))).toHaveLength(
      1,
    );
    expect(view.calls.filter((call) => call.path.endsWith("/session"))).toHaveLength(1);
    expect(view.calls.some((call) => call.method === "POST")).toBe(false);
    await view.unmount();
  }
});

test("a temporary relay outage keeps an explicit read retry and never authorizes by itself", async () => {
  const view = await fixture("relay_unavailable", 503);
  await until(() => text(view.container).includes("电脑连接服务暂时不可用"));
  expect(view.button("重试读取请求")).toBeDefined();
  view.state.error = "";
  await view.click("重试读取请求");
  await until(() => !!view.button("用 Passkey 确认连接"));
  expect(text(view.container)).toContain("目标电脑");
  expect(view.calls.some((call) => call.method === "POST")).toBe(false);
});

test("an expired response cannot expose a confirmation action", async () => {
  const view = await fixture("relay_unavailable", 503);
  await until(() => !!view.button("重试读取请求"));
  view.state.error = "";
  view.state.expired = true;
  await view.click("重试读取请求");
  await until(() => !!view.link("打开电脑列表"));
  expect(text(view.container)).toContain("请求已过期");
  expect(view.button("用 Passkey 确认连接")).toBeUndefined();
  expect(view.calls.some((call) => call.method === "POST")).toBe(false);
});
