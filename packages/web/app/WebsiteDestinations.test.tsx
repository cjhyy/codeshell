import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { AccountSessionProvider } from "./AccountSessionProvider.js";
import { WebsiteDestinations } from "./WebsiteDestinations.js";
import type { WebsiteComputer } from "./website-devices.js";

const origin = "https://codeshell.site";
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const host: WebsiteComputer = {
  hostId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  name: "所选电脑",
  online: true,
  revoked: false,
  publicOrigin: "https://11111111-1111-4111-8111-111111111111.devices.codeshell.site",
};
const other: WebsiteComputer = {
  ...host,
  hostId: "33333333-3333-4333-8333-333333333333",
  publicOrigin: "https://33333333-3333-4333-8333-333333333333.devices.codeshell.site",
  name: "另一台电脑",
};
const originalFetch = globalThis.fetch;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  globalThis.fetch = originalFetch;
});
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
  throw new Error("Controlled computer entry boundary not reached");
}
function install(target: object, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  cleanup.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else delete (target as any)[key];
  });
}
const claim = (selected = host) => ({
  hostId: selected.hostId,
  publicOrigin: selected.publicOrigin,
  claimUrl: `${selected.publicOrigin}/__relay/claim#${"T".repeat(43)}`,
  expiresAt: Date.now() + 60000,
});
async function fixture(
  options: {
    requestedComputer?: string | null;
    generic?: boolean;
    hosts?: WebsiteComputer[];
    access?: () => Promise<Response>;
  } = {},
) {
  ensureMiniDom();
  const requestedComputer = options.generic
    ? undefined
    : options.requestedComputer === null
      ? null
      : (options.requestedComputer ?? host.hostId);
  const navigations: string[] = [];
  const url = Object.assign(
    new URL(
      `/app?target=choose${requestedComputer === undefined ? "" : `&computer=${requestedComputer ?? ""}`}`,
      origin,
    ),
    {
      assign: (destination: string) => navigations.push(destination),
    },
  );
  install(window, "location", { value: url });
  install(globalThis, "location", { value: url });
  install(window, "isSecureContext", { value: true });
  install(globalThis, "PublicKeyCredential", { value: function PublicKeyCredential() {} });
  const state = { account: userA, hosts: options.hosts ?? [host, other], cancelPasskey: false };
  let passkeys = 0;
  let cookieQueue = Promise.resolve();
  install(globalThis, "navigator", {
    value: {
      credentials: {
        async get() {
          passkeys++;
          if (state.cancelPasskey) throw new DOMException("Cancelled", "NotAllowedError");
          const bytes = new Uint8Array([1, 2, 3]).buffer;
          return {
            id: "AQID",
            rawId: bytes,
            type: "public-key",
            response: { authenticatorData: bytes, clientDataJSON: bytes, signature: bytes },
            getClientExtensionResults: () => ({}),
          };
        },
      },
      locks: {
        request(_name: string, _options: unknown, operation: () => Promise<unknown>) {
          const next = cookieQueue.then(operation);
          cookieQueue = next.then(
            () => {},
            () => {},
          );
          return next;
        },
      },
    },
  });
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const features = {
    "devices.directory": { version: 1, enabled: true },
    "relay.phone": { version: 1, enabled: true },
    "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin: origin } },
  };
  globalThis.fetch = (async (input, init) => {
    const target = new URL(String(input), origin);
    expect(target.origin).toBe(origin);
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    const path = target.pathname + target.search;
    calls.push({ path, init });
    if (path === "/api/v1/account/status")
      return Response.json({ registrationAllowed: true, githubEnabled: false, features });
    if (path === "/api/v1/account/web/session") {
      const account = {
        id: state.account,
        username: "fixture-user",
        displayName: "当前账号",
        role: "member",
      };
      return Response.json({
        authenticated: true,
        refreshRequired: false,
        csrfToken: "C".repeat(43),
        cloudTarget: null,
        account,
        session: { id: state.account, expiresAt: Date.now() + 900000 },
        overview: {
          account,
          security: { hasPassword: true, githubLinked: false },
          capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
          stats: { activeSessions: 1, loginMethods: 1 },
          features,
        },
      });
    }
    if (path === "/api/v1/account/web/remote-hosts") return Response.json({ hosts: state.hosts });
    if (path === "/api/v1/account/web/passkeys/authentication/options") {
      expect(JSON.parse(String(init?.body))).toEqual({
        purpose: "remote-access",
        target: host.hostId,
      });
      return Response.json({
        ceremonyId: "K".repeat(43),
        optionsJSON: {
          rpId: new URL(origin).hostname,
          challenge: "Q".repeat(43),
          userVerification: "required",
        },
      });
    }
    if (path === "/api/v1/account/web/passkeys/authentication/verify")
      return Response.json({ stepUpToken: "S".repeat(43), expiresAt: Date.now() + 60000 });
    if (path === `/api/v1/account/web/remote-hosts/${host.hostId}/client-access`) {
      expect(JSON.parse(String(init?.body))).toEqual({
        client: "browser",
        stepUpToken: "S".repeat(43),
      });
      expect(new Headers(init?.headers).get("X-CodeShell-CSRF")).toBe("C".repeat(43));
      return options.access ? options.access() : Response.json(claim());
    }
    throw new Error(`Unexpected owned computer entry request ${path}`);
  }) as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  let mounted = true;
  let selected = requestedComputer;
  const render = () =>
    root.render(
      <AccountSessionProvider>
        <WebsiteDestinations
          requestedComputer={selected}
          accountControl={<span>账号菜单</span>}
          onCloud={() => {
            throw new Error("Unexpected Cloud switch");
          }}
        />
      </AccountSessionProvider>,
    );
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await action(() => root.unmount());
  };
  cleanup.push(unmount);
  await action(render);
  await until(() => calls.some((call) => call.path === "/api/v1/account/status"));
  for (let index = 0; index < 6; index++) await action(() => {});
  const button = (name: string) =>
    nodes(container).find((node) => node.tagName === "BUTTON" && text(node).trim() === name);
  return {
    container,
    calls,
    url,
    navigations,
    state,
    button,
    unmount,
    passkeys: () => passkeys,
    async click(name: string) {
      const node = button(name);
      expect(node).toBeDefined();
      expect(props(node).disabled).not.toBe(true);
      await action(() => props(node).onClick());
    },
    async focus() {
      await action(() => window.dispatchEvent({ type: "focus" } as Event));
    },
    async select(next: string) {
      selected = next;
      await action(render);
    },
  };
}

test("a selected computer goes through an explicit Passkey to the full workbench without choosing a project", async () => {
  const view = await fixture();
  expect(text(view.container)).toContain("所选电脑");
  expect(text(view.container)).toContain("无需先选项目");
  expect(text(view.container)).not.toContain("另一台电脑");
  expect(view.button("进入云端")).toBeUndefined();
  expect(nodes(view.container).some((node) => ["SELECT", "TEXTAREA"].includes(node.tagName))).toBe(
    false,
  );
  expect(view.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
  expect(view.passkeys()).toBe(0);
  const settings = nodes(view.container).find(
    (node) => node.tagName === "A" && text(node) === "管理 Passkey",
  );
  expect(props(settings).href).toBe(
    `/settings/account/security?target=choose&computer=${host.hostId}`,
  );
  await view.click("使用指纹连接");
  await until(() => view.navigations.length === 1);
  expect(view.passkeys()).toBe(1);
  expect(view.navigations).toEqual([claim().claimUrl]);
  expect(view.calls.some((call) => /projects|chat|sessions/.test(call.path))).toBe(false);
});

test("missing, malformed and offline selected computers never choose another target", async () => {
  for (const options of [
    { hosts: [other], message: "当前账号里找不到这台电脑" },
    { requestedComputer: null, message: "电脑链接无效" },
    { hosts: [{ ...host, online: false }, other], message: "这台电脑暂时无法连接" },
    { hosts: [{ ...host, revoked: true }, other], message: "当前账号里找不到这台电脑" },
  ]) {
    const view = await fixture(options);
    expect(text(view.container)).toContain(options.message);
    expect(text(view.container)).not.toContain("另一台电脑");
    expect(view.button("进入云端")).toBeUndefined();
    const button = view.button("使用指纹连接");
    if (button) expect(props(button).disabled).toBe(true);
    expect(view.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    expect(view.navigations).toEqual([]);
    await view.unmount();
  }
});

test("a cancelled Passkey remains visible across directory refresh and can be retried explicitly", async () => {
  const view = await fixture();
  view.state.cancelPasskey = true;
  await view.click("使用指纹连接");
  await until(() => text(view.container).includes("已取消或超时"));
  await view.focus();
  expect(text(view.container)).toContain("已取消或超时");
  expect(view.navigations).toEqual([]);
  expect(view.calls.some((call) => call.path.endsWith("/client-access"))).toBe(false);
  view.state.cancelPasskey = false;
  await view.click("使用指纹连接");
  await until(() => view.navigations.length === 1);
  expect(view.passkeys()).toBe(2);
});

test("a claim for another computer is refused without navigation", async () => {
  const view = await fixture({ access: async () => Response.json(claim(other)) });
  await view.click("使用指纹连接");
  await until(() => text(view.container).includes("电脑连接授权无效"));
  expect(view.navigations).toEqual([]);
});

test("account changes, target changes and unmount cancel a pending claim without opening stale authority", async () => {
  for (const change of ["account", "target", "unmount"] as const) {
    let finish!: (response: Response) => void;
    const view = await fixture({
      access: () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    });
    await view.click("使用指纹连接");
    await until(() => !!finish);
    const call = view.calls.find((entry) => entry.path.endsWith("/client-access"))!;
    if (change === "account") {
      view.state.account = userB;
      view.state.hosts = [other];
      await view.focus();
      await until(() => text(view.container).includes("当前账号里找不到这台电脑"));
    } else if (change === "target") await view.select(other.hostId);
    else await view.unmount();
    expect(call.init?.signal?.aborted).toBe(true);
    await action(() => finish(Response.json(claim())));
    expect(view.navigations).toEqual([]);
    await view.unmount();
  }
});

test("directory changes retire an in-flight selected computer and require explicit reconnection", async () => {
  let finish!: (response: Response) => void;
  const view = await fixture({
    access: () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  });
  await view.click("使用指纹连接");
  await until(() => !!finish);
  view.state.hosts = [{ ...host, online: false }];
  await view.focus();
  await until(() => text(view.container).includes("电脑已离线或授权发生变化"));
  expect(
    view.calls.find((entry) => entry.path.endsWith("/client-access"))!.init?.signal?.aborted,
  ).toBe(true);
  await action(() => finish(Response.json(claim())));
  expect(view.navigations).toEqual([]);
});

test("the ordinary website chooser still lists computers and Cloud without automatically connecting", async () => {
  const view = await fixture({ generic: true });
  expect(text(view.container)).toContain("选择云端或电脑");
  expect(text(view.container)).toContain("另一台电脑");
  expect(view.button("进入云端")).toBeDefined();
  expect(view.passkeys()).toBe(0);
  expect(view.navigations).toEqual([]);
});
