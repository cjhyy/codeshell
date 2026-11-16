import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { WebsiteEntry } from "./WebsiteShell.js";
import { desktopLoginRequest } from "./DesktopLogin.js";

const originalFetch = globalThis.fetch;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  globalThis.fetch = originalFetch;
});
const origin = "https://desktop-login.fixture.invalid";
const ticket = "T".repeat(43);
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
  throw new Error("Controlled desktop login boundary not reached");
}
function install(target: object, name: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  cleanup.push(() => {
    if (previous) Object.defineProperty(target, name, previous);
    else delete (target as any)[name];
  });
}

async function fixture({
  signedIn = true,
  query = `request=${ticket}`,
  detail = () => Response.json({ deviceName: "我的 Mac", expiresAt: Date.now() + 600000 }),
  decide = async (_path: string, _init?: RequestInit) =>
    Response.json({ approved: true, denied: true }),
  passkey = "ok",
} = {}) {
  ensureMiniDom();
  const url = new URL(`/desktop-login?${query}`, origin);
  const navigations: string[] = [];
  Object.assign(url, { replace: (destination: string) => navigations.push(destination) });
  install(window, "location", { get: () => url });
  install(globalThis, "location", { get: () => url });
  install(window, "isSecureContext", { value: true });
  install(globalThis, "PublicKeyCredential", { value: function PublicKeyCredential() {} });
  let queue = Promise.resolve();
  install(globalThis, "navigator", {
    value: {
      credentials: {
        async get() {
          if (passkey === "cancel") throw new DOMException("Cancelled", "NotAllowedError");
          const bytes = new Uint8Array([1, 2, 3]).buffer;
          return {
            id: "AQID",
            rawId: bytes,
            type: "public-key",
            response: {
              authenticatorData: bytes,
              clientDataJSON: bytes,
              signature: bytes,
            },
            getClientExtensionResults: () => ({}),
          };
        },
      },
      locks: {
        request(_name: string, _options: unknown, operation: () => Promise<unknown>) {
          const value = queue.then(operation);
          queue = value.then(
            () => {},
            () => {},
          );
          return value;
        },
      },
    },
  });
  let currentAccount = userA;
  const state = { signedIn };
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const session = () => {
    const account = {
      id: currentAccount,
      username: currentAccount === userA ? "account-a" : "account-b",
      displayName: currentAccount === userA ? "用户 A" : "用户 B",
      role: "member",
    };
    return {
      authenticated: state.signedIn,
      refreshRequired: false,
      cloudTarget: null,
      ...(state.signedIn
        ? {
            account,
            session: { id: currentAccount, expiresAt: Date.now() + 900000 },
            csrfToken: "C".repeat(43),
            overview: {
              account,
              security: { hasPassword: true, githubLinked: false },
              capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
              stats: { activeSessions: 1, loginMethods: 1 },
              features: {},
            },
          }
        : {}),
    };
  };
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    expect(path.startsWith("/api/v1/account/")).toBe(true);
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    if (path === "/api/v1/account/status")
      return Response.json({ registrationAllowed: true, githubEnabled: false, features: {} });
    if (path === "/api/v1/account/web/session") return Response.json(session());
    if (path === "/api/v1/account/web/passkeys/authentication/options") {
      expect(JSON.parse(String(init?.body))).toEqual({ purpose: "desktop-login", target: ticket });
      return Response.json({
        ceremonyId: "K".repeat(43),
        optionsJSON: {
          rpId: new URL(origin).hostname,
          challenge: "Q".repeat(43),
          userVerification: passkey === "weak" ? "preferred" : "required",
        },
      });
    }
    if (path === "/api/v1/account/web/passkeys/authentication/verify")
      return Response.json({ stepUpToken: "S".repeat(43), expiresAt: Date.now() + 60000 });
    if (path === `/api/v1/account/web/browser/request?request=${ticket}`) return detail();
    if (["/api/v1/account/web/browser/approve", "/api/v1/account/web/browser/deny"].includes(path))
      return decide(path, init);
    if (path === "/api/v1/account/web/logout") {
      state.signedIn = false;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected controlled desktop request ${path}`);
  }) as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  let live = true;
  const unmount = async () => {
    if (!live) return;
    live = false;
    await action(() => root.unmount());
  };
  cleanup.push(unmount);
  await action(() => root.render(<WebsiteEntry setupToken="" />));
  await until(() => calls.some((call) => call.path === "/api/v1/account/web/session"));
  const button = (name: string) =>
    nodes(container).find((node) => node.tagName === "BUTTON" && text(node) === name);
  return {
    container,
    calls,
    url,
    navigations,
    button,
    unmount,
    async click(name: string) {
      const node = button(name);
      expect(node).toBeDefined();
      expect(props(node).disabled).not.toBe(true);
      await action(() => props(node).onClick());
    },
    async switchAccount() {
      currentAccount = userB;
      await action(() => window.dispatchEvent({ type: "focus" } as Event));
      await until(() => text(container).includes("用户 B"));
    },
  };
}

test("desktop login accepts one bounded request and no external navigation inputs", () => {
  expect(desktopLoginRequest(new URL(`/desktop-login?request=${ticket}`, origin))).toBe(ticket);
  for (const path of [
    "/desktop-login",
    "/desktop-login?request=short",
    `/desktop-login?request=${ticket}&request=${ticket}`,
    `/desktop-login?request=${ticket}&redirect=https://outside.invalid`,
    `/desktop-login?request=${ticket}#token=ignored`,
    `/?request=${ticket}`,
  ])
    expect(desktopLoginRequest(new URL(path, origin))).toBeUndefined();
});

test("a signed-out browser keeps the desktop request while presenting normal account login", async () => {
  const view = await fixture({ signedIn: false });
  await until(() => text(view.container).includes("登录 CodeShell 电脑端"));
  expect(view.url.searchParams.get("request")).toBe(ticket);
  expect(view.calls.some((call) => call.path.includes("/browser/"))).toBe(false);
  expect(view.calls.some((call) => call.path.includes("cloud"))).toBe(false);
  expect(view.navigations).toEqual([]);
});

test("restoring a browser account never approves a computer until explicitly confirmed", async () => {
  const view = await fixture();
  await until(() => !!view.button("登录这台电脑"));
  expect(text(view.container)).toContain("用户 A");
  expect(text(view.container)).toContain("我的 Mac");
  expect(view.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
  expect(view.navigations).toEqual([]);
  await view.click("登录这台电脑");
  await until(() => view.navigations.length === 1);
  const approved = view.calls.filter((call) => call.path.endsWith("/approve"));
  expect(approved).toHaveLength(1);
  expect(JSON.parse(String(approved[0].init?.body))).toEqual({
    request: ticket,
    stepUpToken: "S".repeat(43),
  });
  expect(new Headers(approved[0].init?.headers).get("X-CodeShell-CSRF")).toBe("C".repeat(43));
  expect(view.navigations).toEqual(["/app"]);
  expect(text(view.container)).toContain("选择云端工作区或账号下的电脑");
  const workbench = nodes(view.container).find(
    (node) => node.tagName === "A" && text(node) === "进入远程工作台",
  );
  expect(props(workbench).href).toBe("/app");
  expect(view.button("登录这台电脑")).toBeUndefined();
});

test("a cancelled or weakened Passkey ceremony never approves a new Desktop session", async () => {
  for (const passkey of ["cancel", "weak"]) {
    const view = await fixture({ passkey });
    await until(() => !!view.button("登录这台电脑"));
    await view.click("登录这台电脑");
    await until(() =>
      text(view.container).includes(passkey === "cancel" ? "已取消或超时" : "验证请求无效"),
    );
    expect(
      view.calls.some(
        (call) => call.path.endsWith("/approve") || call.path.endsWith("/authentication/verify"),
      ),
    ).toBe(false);
    expect(view.navigations).toEqual([]);
    await view.unmount();
  }
});

test("cancelling a computer request leaves the browser account signed in", async () => {
  const view = await fixture();
  await until(() => !!view.button("取消电脑登录"));
  await view.click("取消电脑登录");
  await until(() => text(view.container).includes("已取消电脑登录"));
  expect(view.calls.filter((call) => call.path.endsWith("/deny"))).toHaveLength(1);
  expect(view.calls.some((call) => call.path.endsWith("/logout"))).toBe(false);
  expect(view.navigations).toEqual([]);
});

test("an unconfirmed approval stays on the request instead of navigating to the workbench", async () => {
  const view = await fixture({ decide: async () => Response.json({ approved: false }) });
  await until(() => !!view.button("登录这台电脑"));
  await view.click("登录这台电脑");
  await until(() => text(view.container).includes("服务器尚未确认操作结果"));
  expect(view.navigations).toEqual([]);
  expect(view.button("登录这台电脑")).toBeDefined();
});

test("expired and malformed requests cannot display an approval action", async () => {
  const expired = await fixture({
    detail: () => Response.json({ error: "browser_login_expired" }, { status: 404 }),
  });
  await until(() => text(expired.container).includes("已过期或不存在"));
  expect(expired.button("登录这台电脑")).toBeUndefined();
  await expired.unmount();
  const malformed = await fixture({ query: "request=short" });
  expect(text(malformed.container)).toContain("电脑登录链接无效");
  expect(malformed.calls.some((call) => call.path.includes("/browser/"))).toBe(false);
});

test("an unauthorized approval is not automatically retried after session refresh", async () => {
  const view = await fixture({
    decide: async () => Response.json({ error: "authentication_required" }, { status: 401 }),
  });
  await until(() => !!view.button("登录这台电脑"));
  await view.click("登录这台电脑");
  await until(() => text(view.container).includes("登录 CodeShell 电脑端"));
  expect(view.calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(1);
  expect(view.calls.some((call) => call.path.endsWith("/refresh"))).toBe(false);
  expect(view.navigations).toEqual([]);
});

test("switching the browser account aborts an outstanding approval and discards its late result", async () => {
  let finish: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  const view = await fixture({
    decide: async (_path, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
  });
  await until(() => !!view.button("登录这台电脑"));
  await view.click("登录这台电脑");
  await view.switchAccount();
  expect(signal?.aborted).toBe(true);
  await action(() => finish?.(Response.json({ approved: true })));
  expect(view.navigations).toEqual([]);
  expect(text(view.container)).toContain("用户 B");
  expect(view.calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(1);
});

test("leaving the confirmation page aborts its outstanding approval", async () => {
  let finish: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  const view = await fixture({
    decide: async (_path, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
  });
  await until(() => !!view.button("登录这台电脑"));
  await view.click("登录这台电脑");
  await view.unmount();
  expect(signal?.aborted).toBe(true);
  await action(() => finish?.(Response.json({ approved: true })));
  expect(view.navigations).toEqual([]);
});
