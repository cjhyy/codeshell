import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { WebsiteEntry } from "./WebsiteShell.js";
import { logoutWebsiteCloudSession } from "./website-cloud.js";
import { setApiProject, setApiWorkspace } from "./api-context.js";

const originalFetch = globalThis.fetch,
  originalSocket = globalThis.WebSocket;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  setApiProject(null);
  setApiWorkspace(undefined);
});
const origin = "https://cloud.fixture.invalid";
const accountA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  accountB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  rootA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  rootB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  installation = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  project = "ffffffff-ffff-4fff-8fff-ffffffffffff";
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
  throw new Error("Controlled website boundary not reached");
}
function install(target: object, name: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  cleanup.push(() => {
    if (previous) Object.defineProperty(target, name, previous);
    else delete (target as any)[name];
  });
}
function cloudSession(accountId = accountA, id = rootA) {
  return {
    id,
    kind: "cloud-management",
    audience: origin,
    installationId: installation,
    accountOrigin: origin,
    accountId,
    managementEpoch: installation,
    expiresAt: Date.now() + 600000,
  };
}
async function fixture() {
  ensureMiniDom();
  let url = new URL(origin);
  install(window, "location", { get: () => url });
  install(globalThis, "location", { get: () => url });
  install(window, "history", {
    value: {
      state: null,
      replaceState(_state: unknown, _unused: string, value: string) {
        url = new URL(String(value), url);
      },
      pushState(_state: unknown, _unused: string, value: string) {
        url = new URL(String(value), url);
      },
    },
  });
  install(window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  let queue = Promise.resolve();
  install(globalThis, "navigator", {
    value: {
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
  class Socket {
    static OPEN = 1;
    readyState = 0;
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  let currentAccount = accountA,
    currentRoot = rootA;
  let hold: ((value: Response) => void) | undefined;
  let holdNext = false;
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const accountSession = () => {
    const account = {
      id: currentAccount,
      username: currentAccount === accountA ? "account-a" : "account-b",
      displayName: currentAccount === accountA ? "用户 A" : "用户 B",
      role: "member",
    };
    return {
      authenticated: true,
      account,
      overview: {
        account,
        security: { hasPassword: true, githubLinked: false },
        capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
        stats: { activeSessions: 1, loginMethods: 1 },
      },
      session: { id: currentRoot, expiresAt: Date.now() + 900000 },
      csrfToken: "C".repeat(43),
      cloudTarget: {
        enabled: true,
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId: installation,
      },
    };
  };
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    expect(path.startsWith("/")).toBe(true);
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    if (path === "/api/v1/cloud-browser/capabilities")
      return Response.json({
        version: 1,
        mode: "cloud-browser",
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId: installation,
      });
    if (path === "/api/v1/account/status")
      return Response.json({ registrationAllowed: true, githubEnabled: true });
    if (path === "/api/v1/account/web/session") return Response.json(accountSession());
    if (path === "/api/v1/account/web/overview") return Response.json(accountSession().overview);
    if (path === "/api/v1/account/web/cloud-tickets")
      return Response.json({
        ticket: "T".repeat(43),
        expiresAt: Date.now() + 60000,
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId: installation,
      });
    if (path === "/api/v1/cloud-browser/session") {
      const response = Response.json({
        authenticated: true,
        mode: "cloud-account",
        session: cloudSession(currentAccount, currentRoot),
      });
      if (holdNext)
        return new Promise<Response>((resolve) => {
          hold = resolve;
        });
      return response;
    }
    if (path === "/api/v1/projects")
      return Response.json({
        runtime: "docker",
        available: true,
        projects: [
          { id: project, name: "真实私有项目", status: "running", generation: 1, createdAt: 1 },
        ],
      });
    if (path === "/api/v1/environment") return Response.json({});
    if (path === `/p/${project}/api/v1/configuration`)
      return Response.json({
        workspace: { path: "/private", settingsScope: "local", skillDirectories: [] },
        defaults: {},
        connections: [],
        catalog: [],
        skills: [],
        mcpServers: [],
        restartRequired: false,
      });
    throw new Error(`Unexpected controlled website request ${path}`);
  }) as typeof fetch;
  const container = document.createElement("div"),
    root = createRoot(container);
  cleanup.push(async () => {
    hold?.(Response.json({}, { status: 401 }));
    await action(() => root.unmount());
  });
  await action(() =>
    root.render(
      <React.StrictMode>
        <WebsiteEntry setupToken="" />
      </React.StrictMode>,
    ),
  );
  await until(() => nodes(container).some((node) => node.tagName === "TEXTAREA"));
  return {
    container,
    calls,
    get url() {
      return url;
    },
    async switchAccount(sameAccount: boolean) {
      currentAccount = sameAccount ? accountA : accountB;
      currentRoot = rootB;
      holdNext = true;
      await action(() => window.dispatchEvent({ type: "focus" } as Event));
      await until(() => hold !== undefined);
    },
  };
}

test("the website opens the actual CodeShell composer after cookie authority and a real project are confirmed", async () => {
  const view = await fixture();
  expect(text(view.container)).toContain("新对话");
  expect(text(view.container)).toContain("历史对话");
  expect(text(view.container)).not.toContain("活跃登录会话");
  expect(view.calls.some((call) => /auth\/(login|setup|sessions)/.test(call.path))).toBe(false);
  expect(view.calls.find((call) => call.path === "/api/v1/cloud-browser/session")?.init?.body).toBe(
    JSON.stringify({ ticket: "T".repeat(43) }),
  );
});

test("account and root changes cannot mount a new project gate with the previous Cloud cookie", async () => {
  for (const sameAccount of [false, true]) {
    const view = await fixture();
    const before = view.calls.filter((call) => call.path === "/api/v1/projects").length;
    await view.switchAccount(sameAccount);
    expect(view.calls.filter((call) => call.path === "/api/v1/projects")).toHaveLength(before);
    expect(nodes(view.container).some((node) => node.tagName === "TEXTAREA")).toBe(false);
    await cleanup.pop()!();
  }
});

test("account settings share the website session and retain a real unsent conversation", async () => {
  const view = await fixture();
  const textarea = nodes(view.container).find((node) => node.tagName === "TEXTAREA");
  await action(() => props(textarea).onChange({ target: { value: "保留这条未发送内容" } }));
  const settings = nodes(view.container).find(
    (node) => node.tagName === "BUTTON" && text(node) === "账号设置",
  );
  await action(() => props(settings).onClick({ currentTarget: settings }));
  expect(view.url.pathname).toBe("/settings/account/profile");
  expect(text(view.container)).toContain("昵称用于显示");
  const back = nodes(view.container).find(
    (node) => node.tagName === "BUTTON" && text(node) === "← 返回工作台",
  );
  await action(() => props(back).onClick());
  expect(view.url.pathname).toBe("/");
  expect(props(nodes(view.container).find((node) => node.tagName === "TEXTAREA")).value).toBe(
    "保留这条未发送内容",
  );
});

test("a stale tab never revokes a newer Cloud cookie when signing out", async () => {
  await fixture();
  const writes: string[] = [];
  await logoutWebsiteCloudSession(
    cloudSession() as any,
    (async (url, init) => {
      if (init?.method === "POST") writes.push(String(url));
      return Response.json({
        authenticated: true,
        mode: "cloud-account",
        session: cloudSession(accountB, rootB),
      });
    }) as typeof fetch,
  );
  expect(writes).toEqual([]);
  await logoutWebsiteCloudSession(
    cloudSession() as any,
    (async (url, init) => {
      if (init?.method === "POST") writes.push(String(url));
      return Response.json({ authenticated: true, mode: "cloud-account", session: cloudSession() });
    }) as typeof fetch,
  );
  expect(writes).toEqual(["/api/v1/auth/logout"]);
});
