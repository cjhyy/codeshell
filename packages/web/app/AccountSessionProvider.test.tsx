import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { AccountSessionProvider, useAccountSession } from "./AccountSessionProvider.js";
import { AccountSettings } from "./AccountSettings.js";
import type { WebsiteRoute } from "./website-routes.js";

const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherSessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const nativeFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  globalThis.fetch = nativeFetch;
});
function all(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(all)];
}
function text(node: any): string {
  return `${node.nodeValue ?? node.textContent ?? ""}${Array.from(node.childNodes ?? [])
    .map(text)
    .join("")}`;
}
function props(node: any) {
  return node[Object.keys(node).find((key) => key.startsWith("__reactProps"))!];
}
function control(container: HTMLElement, tag: string, match: (node: any) => boolean) {
  const node = all(container).find((item) => item.tagName === tag && match(item));
  if (!node) throw new Error(`Missing controlled ${tag}`);
  return props(node);
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
  throw new Error("Controlled browser operation did not reach its boundary");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture({
  role = "member",
  hasPassword = true,
  section = "profile",
  admin = false,
} = {}) {
  ensureMiniDom();
  for (const [name, value] of [
    ["location", new URL("https://cloud.fixture.invalid/")],
    ["confirm", () => true],
    ["open", () => popup],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(window, name);
    Object.defineProperty(window, name, { configurable: true, value });
    cleanups.push(() => {
      if (previous) Object.defineProperty(window, name, previous);
      else delete (window as any)[name];
    });
  }
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let queue = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(_name: string, _options: unknown, operation: () => Promise<unknown>) {
          const current = queue.then(operation);
          queue = current.then(
            () => {},
            () => {},
          );
          return current;
        },
      },
    },
  });
  cleanups.push(() => {
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else delete (globalThis as any).navigator;
  });
  const popup = { location: { href: "" }, opener: undefined, close() {} };
  let authenticated = true;
  let profile = { id: accountId, username: "fixture-user", displayName: "原昵称", role };
  let sessions = [
    {
      id: sessionId,
      kind: "account",
      deviceName: "当前浏览器",
      current: true,
      createdAt: 1,
      expiresAt: Date.now() + 600000,
    },
    {
      id: otherSessionId,
      kind: "account",
      deviceName: "旧浏览器",
      current: false,
      createdAt: 1,
      expiresAt: Date.now() + 600000,
    },
  ];
  const overview = () => ({
    account: profile,
    security: { hasPassword, githubLinked: false },
    capabilities: {
      sessions: true,
      passwordChange: hasPassword,
      admin: role === "admin",
      links: false,
    },
    stats: { activeSessions: sessions.length, loginMethods: 1 },
  });
  const snapshot = () => ({
    authenticated,
    cloudTarget: { enabled: false },
    ...(authenticated
      ? {
          csrfToken: "C".repeat(43),
          account: profile,
          overview: overview(),
          session: { id: sessionId, expiresAt: Date.now() + 600000 },
        }
      : { refreshRequired: false }),
  });
  const calls: Array<{ path: string; init?: RequestInit; body?: any }> = [];
  const overrides = new Map<
    string,
    (call: (typeof calls)[number]) => Response | Promise<Response>
  >();
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    expect(path.startsWith("/api/v1/account/")).toBe(true);
    const call = { path, init, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const override = overrides.get(`${init?.method ?? "GET"} ${path}`);
    if (override) return override(call);
    if (path === "/api/v1/account/status")
      return Response.json({ registrationAllowed: true, githubEnabled: true });
    if (path === "/api/v1/account/web/session") {
      if (init?.method === "POST") authenticated = true;
      return Response.json(snapshot());
    }
    if (path === "/api/v1/account/login" || path === "/api/v1/account/register")
      return Response.json({
        account: profile,
        sessionId,
        accessToken: "A".repeat(43),
        refreshToken: "R".repeat(43),
        accessTokenExpiresAt: Date.now() + 600000,
        refreshTokenExpiresAt: Date.now() + 86400000,
      });
    if (path === "/api/v1/account/web/overview") return Response.json(overview());
    if (path === "/api/v1/account/web/profile" && init?.method === "PATCH") {
      profile = { ...profile, ...call.body };
      return Response.json({ account: profile });
    }
    if (path === "/api/v1/account/web/sessions")
      return Response.json({ sessions, total: sessions.length, hasMore: false });
    if (path.startsWith("/api/v1/account/web/sessions/") && init?.method === "DELETE") {
      sessions = sessions.filter((item) => item.id !== path.split("/").at(-1));
      return Response.json({ ok: true, current: false });
    }
    if (path === "/api/v1/account/web/logout") {
      authenticated = false;
      return Response.json({ ok: true });
    }
    if (path === "/api/v1/account/web/github/cancel") return Response.json({ ok: true });
    throw new Error(`Unexpected controlled Account request ${init?.method ?? "GET"} ${path}`);
  }) as typeof fetch;
  let context!: ReturnType<typeof useAccountSession>;
  function Content() {
    context = useAccountSession();
    const route: WebsiteRoute = admin
      ? { kind: "admin", section: "users" }
      : { kind: "account", section: section as any };
    return context.session?.authenticated ? <AccountSettings route={route} /> : <p>请登录</p>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanups.push(async () => {
    await action(() => root.unmount());
  });
  await action(() =>
    root.render(
      <React.StrictMode>
        <AccountSessionProvider>
          <Content />
        </AccountSessionProvider>
      </React.StrictMode>,
    ),
  );
  await until(() => context.ready && !context.busy);
  await action(() => {});
  return {
    container,
    calls,
    overrides,
    snapshot,
    get context() {
      return context;
    },
  };
}

test("a restored website cookie opens account settings without another login or any runtime request", async () => {
  const view = await fixture();
  expect(text(view.container)).toContain("昵称用于显示，用户名用于密码登录");
  expect(
    control(view.container, "INPUT", (node) => props(node).autoComplete === "nickname").value,
  ).toBe("原昵称");
  expect(view.calls.some((call) => call.path.includes("/login"))).toBe(false);
  expect(view.calls.every((call) => call.path.startsWith("/api/v1/account/"))).toBe(true);
});

test("profile changes preserve separate username and nickname fields and fixed cookie authority", async () => {
  const view = await fixture();
  await action(() =>
    control(view.container, "INPUT", (node) => props(node).autoComplete === "nickname").onChange({
      target: { value: "新昵称 <script>" },
    }),
  );
  await action(() => control(view.container, "FORM", () => true).onSubmit({ preventDefault() {} }));
  const patch = view.calls.find((call) => call.init?.method === "PATCH")!;
  expect(patch.body).toEqual({ displayName: "新昵称 <script>" });
  expect(new Headers(patch.init?.headers).get("X-CodeShell-CSRF")).toBe("C".repeat(43));
  expect(new Headers(patch.init?.headers).has("Authorization")).toBe(false);
  expect(text(view.container)).toContain("账号资料已保存");
  expect(all(view.container).some((node) => node.tagName === "SCRIPT")).toBe(false);
});

test("a member administrator URL never requests administrator data", async () => {
  const view = await fixture({ admin: true });
  expect(text(view.container)).toContain("当前账号没有管理员权限");
  expect(view.calls.some((call) => call.path.includes("/admin/"))).toBe(false);
});

test("GitHub-only accounts expose no first-password mutation form", async () => {
  const view = await fixture({ section: "security", hasPassword: false });
  expect(text(view.container)).toContain("请继续使用 GitHub");
  expect(
    all(view.container).some((node) => node.tagName === "INPUT" && props(node).type === "password"),
  ).toBe(false);
  expect(view.calls.some((call) => call.path.endsWith("/password"))).toBe(false);
});

test("consecutive session mutations leave the new list actions enabled", async () => {
  const view = await fixture({ section: "sessions" });
  const exitOld = () =>
    control(
      view.container,
      "BUTTON",
      (node) => text(node) === "退出" && text(node.parentNode).includes("旧浏览器"),
    );
  await action(() => exitOld().onClick());
  expect(text(view.container)).not.toContain("旧浏览器");
  const current = control(view.container, "BUTTON", (node) => text(node) === "退出");
  expect(current.disabled).toBe(false);
  expect(text(view.container)).toContain("当前浏览器");
});

test("logout clears the private settings before the server responds and ignores old data", async () => {
  const view = await fixture();
  const late = deferred<Response>();
  view.overrides.set("POST /api/v1/account/web/logout", () => late.promise);
  let logout!: Promise<boolean>;
  await action(() => {
    logout = view.context.logout();
  });
  expect(text(view.container)).toContain("请登录");
  expect(text(view.container)).not.toContain("账号资料");
  late.resolve(Response.json({ ok: true }));
  await action(() => logout);
  expect(view.context.session?.authenticated).toBe(false);
});

test("cancelled GitHub association cannot publish a late failure over a fresh settings status", async () => {
  const view = await fixture({ section: "connections" });
  const late = deferred<Response>();
  view.overrides.set("POST /api/v1/account/web/github/start", (call) =>
    Response.json({
      authorizationUrl: `https://github.com/login/oauth/authorize?scope=read%3Auser&code_challenge_method=S256&code_challenge=${call.body.codeChallenge}`,
      receipt: "R".repeat(43),
      expiresAt: Date.now() + 60000,
      pollIntervalMs: 1000,
    }),
  );
  view.overrides.set("POST /api/v1/account/web/github/poll", () => late.promise);
  let flow!: Promise<void>;
  await action(() => {
    flow = view.context.github("link");
  });
  await until(() => view.calls.some((call) => call.path.endsWith("/github/poll")));
  await action(() => view.context.cancelGithub());
  late.resolve(
    Response.json({ error: "github_login_failed", reason: "provider_timeout" }, { status: 502 }),
  );
  await action(() => flow);
  expect(view.context.session?.account?.id).toBe(accountId);
  expect(view.context.error).toBe("");
  expect(view.context.status).toContain("已取消关联");
});

test("password login exchanges its transient grant at the fixed Account path and exposes only cookie metadata", async () => {
  const view = await fixture();
  await action(() => view.context.logout());
  await until(() => !view.context.busy);
  let result!: Promise<boolean>;
  await action(() => {
    result = view.context.signIn("login", {
      username: "fixture-user",
      password: "synthetic password",
    });
  });
  await result;
  await action(() => {});
  expect(view.context.session?.authenticated).toBe(true);
  expect("accessToken" in view.context.session!).toBe(false);
  expect("refreshToken" in view.context.session!).toBe(false);
  const native = view.calls.find((call) => call.path === "/api/v1/account/login")!;
  const exchange = view.calls.find(
    (call) => call.path === "/api/v1/account/web/session" && call.init?.method === "POST",
  )!;
  expect(native.init?.credentials).toBe("omit");
  expect(exchange.body).toEqual({ refreshToken: "R".repeat(43) });
  expect(new Headers(exchange.init?.headers).get("Authorization")).toBe("Bearer " + "A".repeat(43));
  expect(view.calls.some((call) => call.path === "/api/v1/account/web/login")).toBe(false);
});
