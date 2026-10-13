import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { AuthGate } from "./AuthGate.js";
import { setApiProject, setApiWorkspace } from "./api-context.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nativeFetch = globalThis.fetch;
const nativeSocket = globalThis.WebSocket;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  globalThis.fetch = nativeFetch;
  globalThis.WebSocket = nativeSocket;
  setApiProject(null);
  setApiWorkspace(undefined);
});

function text(node: any): string {
  return `${node.nodeValue ?? node.textContent ?? ""}${Array.from(node.childNodes ?? [])
    .map(text)
    .join("")}`;
}
function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function button(container: HTMLElement, label: string) {
  const element = nodes(container).find(
    (node) => node.tagName === "BUTTON" && text(node) === label,
  );
  if (!element) throw new Error(`Missing ${label}`);
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps"))!;
  return element[key];
}
async function action(run: () => unknown) {
  await act(async () => {
    run();
    await flushMicrotasks();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture({ active = false, strict = false } = {}) {
  ensureMiniDom();
  let location = new URL(`http://localhost/${active ? `?project=${projectId}` : ""}`);
  for (const [target, name, descriptor] of [
    [window, "location", { get: () => location }],
    [globalThis, "location", { get: () => location }],
    [
      window,
      "history",
      {
        value: {
          state: null,
          replaceState(_state: unknown, _unused: string, url: string | URL) {
            location = new URL(String(url), location);
          },
        },
      },
    ],
    [
      window,
      "matchMedia",
      { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    ],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, ...descriptor });
    cleanup.push(() =>
      previous ? Object.defineProperty(target, name, previous) : delete (target as any)[name],
    );
  }
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onclose?: (value: { code: number }) => void;
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const session = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "cloud-management",
    audience: "http://localhost",
    installationId: "22222222-2222-4222-8222-222222222222",
    accountOrigin: "https://accounts.fixture.invalid",
    accountId: "33333333-3333-4333-8333-333333333333",
    managementEpoch: "44444444-4444-4444-8444-444444444444",
    expiresAt: Date.now() + 60_000,
  };
  let status = () =>
    Promise.resolve(
      Response.json({ initialized: true, mode: "cloud-account", authenticated: true, session }),
    );
  let projects = () =>
    Response.json({
      runtime: "docker",
      available: true,
      projects: active
        ? [
            {
              id: projectId,
              name: "Isolated project",
              status: "running",
              generation: 1,
              createdAt: 1,
            },
          ]
        : [],
    });
  let logout = () => Promise.resolve(Response.json({ revoked: true }));
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    requests.push({ path, init });
    if (path === "/api/v1/auth/status") return status();
    if (path === "/api/v1/auth/logout") return logout();
    if (path === "/api/v1/projects") return projects();
    if (path.includes("/api/v1/configuration"))
      return Response.json({
        workspace: { path: "/fixture", settingsScope: "local", skillDirectories: [] },
        defaults: {},
        connections: [],
        catalog: [],
        skills: [],
        mcpServers: [],
        restartRequired: false,
      });
    if (path.includes("/api/v1/environments")) return Response.json({ environments: [] });
    return Response.json({});
  }) as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup.push(() => action(() => root.unmount()));
  await action(() =>
    root.render(
      strict ? (
        <React.StrictMode>
          <AuthGate setupToken="" />
        </React.StrictMode>
      ) : (
        <AuthGate setupToken="" />
      ),
    ),
  );
  return {
    container,
    session,
    requests,
    focus: () => action(() => window.dispatchEvent({ type: "focus" } as Event)),
    click: (label: string) => action(() => button(container, label).onClick()),
    setStatus(value: typeof status) {
      status = value;
    },
    setProjects(value: typeof projects) {
      projects = value;
    },
    setLogout(value: typeof logout) {
      logout = value;
    },
  };
}

test("Cloud signed-out gate has the Desktop management instruction without legacy password fields", async () => {
  const f = await fixture();
  f.setStatus(async () =>
    Response.json({ initialized: true, mode: "cloud-account", authenticated: false }),
  );
  await f.focus();
  expect(text(f.container)).toContain("请从桌面 Cloud 管理器登录");
  expect(nodes(f.container).filter((node) => node.tagName === "INPUT")).toHaveLength(0);
  expect(f.requests.some(({ path }) => /auth\/(setup|login|sessions)/.test(path))).toBe(false);
});

test("Cloud project route renders the real workbench without Hub device management", async () => {
  const f = await fixture({ active: true, strict: true });
  expect(text(f.container)).toContain("Isolated project");
  expect(text(f.container)).toContain("退出此 Cloud 工作台");
  const profileLink = nodes(f.container).find(
    (node) => node.tagName === "A" && text(node) === "账号资料",
  );
  expect(profileLink).toBeDefined();
  const profileProps =
    profileLink[Object.keys(profileLink).find((name) => name.startsWith("__reactProps"))!];
  expect(profileProps.href).toBe("https://accounts.fixture.invalid/api/v1/account/manage");
  expect(profileProps.target).toBe("_blank");
  expect(profileProps.rel).toBe("noopener noreferrer");
  expect(text(f.container)).not.toContain("设备与退出");
  expect(text(f.container)).not.toContain("账号与设备");
  expect(f.requests.some(({ path }) => path === "/api/v1/auth/sessions")).toBe(false);
});

test("Cloud authority 401 closes the active project and returns its own login instruction", async () => {
  const f = await fixture({ active: true });
  f.setStatus(async () => Response.json({ error: "revoked" }, { status: 401 }));
  await f.focus();
  expect(text(f.container)).toContain("Cloud 管理登录已失效");
  expect(text(f.container)).not.toContain("Isolated project");
  expect(nodes(f.container).filter((node) => node.tagName === "INPUT")).toHaveLength(0);
});

test("a malformed replacement Cloud identity closes the known view instead of retaining its authority", async () => {
  const f = await fixture({ active: true });
  f.setStatus(async () =>
    Response.json({
      initialized: true,
      mode: "cloud-account",
      authenticated: true,
      session: { ...f.session, audience: "https://different-cloud.fixture.invalid" },
    }),
  );
  await f.focus();
  expect(text(f.container)).toContain("Cloud 管理登录已失效");
  expect(text(f.container)).not.toContain("Isolated project");
});

test("Cloud cannot downgrade a known origin into legacy Hub after a 404", async () => {
  const f = await fixture({ active: true });
  f.setStatus(async () => Response.json({}, { status: 404 }));
  await f.focus();
  expect(text(f.container)).toContain("请从桌面 Cloud 管理器登录");
  expect(text(f.container)).not.toContain("Isolated project");
});

test("Cloud project 404 remains gated instead of activating single-project legacy authority", async () => {
  const f = await fixture();
  f.setProjects(() => Response.json({}, { status: 404 }));
  await f.focus();
  expect(text(f.container)).toContain("刷新项目");
  expect(text(f.container)).not.toContain("设备与退出");
});

test("failed or unconfirmed Cloud logout preserves the view and offers a retry", async () => {
  const f = await fixture({ active: true });
  f.setLogout(async () => Response.json({ authenticated: false }));
  await f.click("退出此 Cloud 工作台");
  expect(text(f.container)).toContain("未能确认退出");
  expect(text(f.container)).toContain("Isolated project");
  f.setLogout(async () => {
    throw new TypeError("offline");
  });
  await f.click("退出此 Cloud 工作台");
  expect(text(f.container)).toContain("未能确认退出");
  f.setLogout(async () => Response.json({ revoked: true }));
  await f.click("退出此 Cloud 工作台");
  expect(text(f.container)).toContain("此 Cloud 工作台已退出");
  expect(text(f.container)).not.toContain("Isolated project");
  expect(
    f.requests
      .filter(({ path }) => path === "/api/v1/auth/logout")
      .every(({ init }) => init?.body === "{}" && init.method === "POST"),
  ).toBe(true);
});

test("an auth status started before explicit logout cannot restore a late Cloud view", async () => {
  const f = await fixture();
  const late = deferred<Response>();
  f.setStatus(() => late.promise);
  await f.focus();
  await f.click("退出此 Cloud 工作台");
  await action(() =>
    late.resolve(
      Response.json({
        initialized: true,
        mode: "cloud-account",
        authenticated: true,
        session: f.session,
      }),
    ),
  );
  expect(text(f.container)).toContain("此 Cloud 工作台已退出");
  expect(text(f.container)).not.toContain("你的项目");
});
