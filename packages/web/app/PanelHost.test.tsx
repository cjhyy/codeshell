import { afterEach, expect, setSystemTime, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { ManagedPanel } from "../../server/src/panels/types.js";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { setApiWorkspace } from "./api-context.js";
import { PanelHost } from "./PanelHost.js";

type Element = React.ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement(node)) return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function button(tree: React.ReactNode, label: string): Element {
  const found = elements(tree).find((item) => item.type === "button" && text(item) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(element: Element) {
  expect(element.props.disabled).not.toBe(true);
  await act(async () => {
    element.props.onClick();
    await flushMicrotasks();
  });
}
const instanceId = "synthetic-instance-1234567890";
const prepared = {
  instanceId,
  src: "/api/v1/panel-assets/synthetic-asset-1234567890123456/ui/index.html",
  expiresAt: Date.now() + 60 * 60 * 1000,
  context: {
    appId: "test-panel",
    sessionId: "test-session-123",
    apiVersion: 1,
    host: "hub",
    busy: false,
  },
  limitations: ["视频处理需要桌面客户端。"],
};
const panel: ManagedPanel = {
  id: "test-panel",
  title: { default: "Synthetic panel" },
  version: "1.0.0",
  entry: "ui/index.html",
  icon: "panel",
  singleton: true,
  permissions: ["context.session", "agent.submitPrompt", "external.open", "storage"],
  revision: "local-revision",
  bound: true,
  enabled: true,
  globalDisabled: false,
  updatable: true,
  source: { kind: "git", label: "synthetic/panels" },
  compatibility: { supported: true, reasons: prepared.limitations },
};
interface Request {
  url: URL;
  method: string;
  body?: any;
  signal?: AbortSignal | null;
}
const originalFetch = globalThis.fetch;
const unmounts: Array<() => Promise<void>> = [];
let previousMatchMedia: PropertyDescriptor | undefined;
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  globalThis.fetch = originalFetch;
  if (previousMatchMedia) Object.defineProperty(window, "matchMedia", previousMatchMedia);
  else delete (window as any).matchMedia;
  setApiWorkspace(undefined);
  setSystemTime();
});

async function fixture(
  options: {
    intercept?: (request: Request) => Response | Promise<Response> | undefined;
    onSubmit?: (input: { prompt: string; sessionId: string }) => Promise<{ accepted: true }>;
  } = {},
) {
  ensureMiniDom();
  previousMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const requests: Request[] = [];
  const replies: Array<{ data: any; origin: string }> = [];
  const submissions: Array<{ prompt: string; sessionId: string }> = [];
  const child = {
    postMessage: (data: unknown, origin: string) => {
      replies.push({ data, origin });
    },
  };
  let authLost = 0;
  let dirty = false;
  let busy = false;
  globalThis.fetch = (async (path, init) => {
    const request: Request = {
      url: new URL(String(path), "http://localhost"),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    };
    requests.push(request);
    const intercepted = options.intercept?.(request);
    if (intercepted) return intercepted;
    if (request.url.pathname.endsWith("/prepare")) return Response.json(prepared);
    if (request.url.pathname.endsWith("/events"))
      return Response.json({ events: [], cursor: Number(request.url.searchParams.get("after")) });
    if (request.url.pathname.endsWith("/renew"))
      return Response.json({ expiresAt: Date.now() + 30 * 60 * 1000 });
    if (request.url.pathname.endsWith("/confirm"))
      return Response.json({ accepted: true, allowed: request.body.allowed });
    if (request.url.pathname.endsWith("/tool-results")) return Response.json({ accepted: true });
    if (request.method === "DELETE") return Response.json({ closed: true });
    if (request.url.pathname.endsWith("/call")) {
      const { method, params } = request.body;
      if (method === "context.get") return Response.json(prepared.context);
      if (method === "agent.submitPrompt")
        return Response.json({
          effect: method,
          prompt: params.prompt,
          sessionId: prepared.context.sessionId,
        });
      if (method === "external.open") return Response.json({ effect: method, url: params.url });
      if (method === "notifications.send")
        return Response.json({ effect: method, title: params.title, body: params.body ?? "" });
      return Response.json({ value: "synthetic value" });
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${request.url.pathname}`);
  }) as typeof fetch;
  let tree!: Element;
  function MountedHost() {
    tree = PanelHost({
      panel,
      sessionId: prepared.context.sessionId,
      busy,
      onClose() {},
      onAuthLost: () => {
        authLost++;
      },
      onDirtyChange: (value) => {
        dirty = value;
      },
      onSubmitPrompt: async (input) => {
        submissions.push(input);
        return options.onSubmit ? options.onSubmit(input) : { accepted: true };
      },
    });
    return tree;
  }
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(async () => {
      root.render(<MountedHost />);
      await flushMicrotasks();
    });
  let alive = true;
  const unmount = async () => {
    if (!alive) return;
    alive = false;
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  };
  unmounts.push(unmount);
  await render();
  const attach = () => {
    const iframe = elements(tree).find((item) => item.type === "iframe");
    if (iframe) iframe.props.ref.current.contentWindow = child;
    return iframe;
  };
  attach();
  const message = async (data: any, origin = "null", source: unknown = child) => {
    await act(async () => {
      window.dispatchEvent({ type: "message", data, origin, source } as MessageEvent);
      await flushMicrotasks();
    });
  };
  return {
    get tree() {
      return tree;
    },
    get authLost() {
      return authLost;
    },
    get dirty() {
      return dirty;
    },
    requests,
    replies,
    submissions,
    unmount,
    attach,
    message,
    async call(method: string, params?: unknown, requestId = String(requests.length)) {
      await message({ type: "codeshell-panel:call", instanceId, requestId, method, params });
    },
    async ready() {
      await act(async () => {
        attach()!.props.onLoad();
        await flushMicrotasks();
      });
      await message({ type: "codeshell-panel:ready", instanceId });
    },
    async updateBusy(value: boolean) {
      busy = value;
      await render();
      attach();
    },
    async resume() {
      await act(async () => {
        window.dispatchEvent({ type: "focus" } as Event);
        await flushMicrotasks();
      });
    },
  };
}

test("iframe remains opaque and prepare alone does not mark it loaded", async () => {
  setApiWorkspace("/workspace/测试 %20");
  const view = await fixture();
  const frame = view.attach()!;
  expect(frame.props.sandbox).toBe("allow-scripts");
  expect(frame.props.referrerPolicy).toBe("no-referrer");
  expect(frame.props.src).toContain("workspace=");
  expect(new URL(frame.props.src, "http://localhost").searchParams.get("workspace")).toBe(
    "/workspace/测试 %20",
  );
  expect(text(view.tree)).toContain("正在打开面板");
  await view.message({ type: "codeshell-panel:ready", instanceId });
  expect(text(view.tree)).toContain("正在打开面板");
  await view.ready();
  expect(text(view.tree)).not.toContain("正在打开面板");
  expect(text(view.tree)).toContain("视频处理需要桌面客户端");
});

test("wrong window, non-opaque origin and wrong instance never reach authenticated APIs", async () => {
  const view = await fixture();
  const call = {
    type: "codeshell-panel:call",
    instanceId,
    requestId: "one",
    method: "storage.get",
    params: { key: "test" },
  };
  await view.message(call, "https://evil.example");
  await view.message(call, "null", {});
  await view.message({ ...call, instanceId: "another-panel-instance" });
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/call"))).toHaveLength(0);
  await view.message(call);
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/call"))).toHaveLength(1);
  expect(view.replies.at(-1)).toMatchObject({
    origin: "*",
    data: {
      type: "codeshell-panel:response",
      instanceId,
      requestId: "one",
      result: { value: "synthetic value" },
    },
  });
});

test.each([
  "https://evil.example/panel.html",
  "/api/v1/panel-assets/synthetic-asset-1234567890123456/%2e%2e/index.html",
  "/api/v1/panel-assets/synthetic-asset-1234567890123456/ui/%2fapi.html",
  "/api/v1/panel-assets/synthetic-asset-1234567890123456/ui/index.html?redirect=elsewhere",
])("invalid iframe source %s never creates a frame", async (src) => {
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/prepare")) return Response.json({ ...prepared, src });
    },
  });
  expect(view.attach()).toBeUndefined();
  expect(text(view.tree)).toContain("面板启动信息无效");
  expect(view.authLost).toBe(0);
});

test("panel prompt requires parent confirmation and duplicate request IDs cannot resubmit it", async () => {
  const view = await fixture();
  await view.call("agent.submitPrompt", { prompt: "Read the selected project" }, "first");
  expect(view.submissions).toHaveLength(0);
  expect(view.dirty).toBe(true);
  expect(view.attach()!.props.inert).toBe(true);
  await view.call("agent.submitPrompt", { prompt: "A different payload" }, "first");
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/call"))).toHaveLength(1);
  await click(button(view.tree, "确认发送任务"));
  expect(view.submissions).toEqual([
    { prompt: "Read the selected project", sessionId: prepared.context.sessionId },
  ]);
  expect(view.replies.at(-1)?.data).toMatchObject({
    requestId: "first",
    result: { accepted: true },
  });
  expect(view.dirty).toBe(false);
});

test("declining a panel task never calls the workbench controller", async () => {
  const view = await fixture();
  await view.call("agent.submitPrompt", { prompt: "Unapproved task" });
  await click(button(view.tree, "取消"));
  expect(view.submissions).toHaveLength(0);
  expect(view.replies.at(-1)?.data.error).toContain("取消");
});

test("external links are shown as HTTPS parent confirmation links before any opened response", async () => {
  const view = await fixture();
  await view.call("external.open", { url: "https://example.com/path?q=review" });
  expect(view.replies.some((reply) => reply.data.result?.opened)).toBe(false);
  const anchor = elements(view.tree).find((item) => item.type === "a")!;
  expect(anchor.props).toMatchObject({
    href: "https://example.com/path?q=review",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  await click(anchor);
  expect(view.replies.at(-1)?.data.result).toEqual({ opened: true });
  await view.call("external.open", { url: "javascript:alert(1)" });
  expect(elements(view.tree).some((item) => item.type === "a")).toBe(false);
  expect(view.replies.at(-1)?.data.error).toContain("链接无效");
});

test("server effect-shaped storage values never become parent actions", async () => {
  const view = await fixture({
    intercept(request) {
      if (request.body?.method === "storage.get")
        return Response.json({
          effect: "agent.submitPrompt",
          prompt: "Untrusted storage value",
          sessionId: prepared.context.sessionId,
        });
    },
  });
  await view.call("storage.get", { key: "test" });
  expect(view.submissions).toHaveLength(0);
  expect(text(view.tree)).not.toContain("确认发送任务");
  expect(view.replies.at(-1)?.data.result.effect).toBe("agent.submitPrompt");
});

test("context retains the server API version and reports current workbench busy state", async () => {
  const view = await fixture();
  await view.updateBusy(true);
  await view.call("context.get");
  expect(view.replies.at(-1)?.data.result).toMatchObject({ apiVersion: 1, busy: true });
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/prepare"))).toHaveLength(
    1,
  );
  expect(
    view.replies.some(
      (reply) => reply.data.type === "codeshell-panel:event" && reply.data.payload.busy,
    ),
  ).toBe(true);
});

test("a revoked grant closes only its panel while authentication failure is reported once", async () => {
  let status = 410;
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/call"))
        return Response.json({ error: "Panel grant expired" }, { status });
    },
  });
  await view.call("context.get");
  expect(view.authLost).toBe(0);
  expect(view.attach()).toBeUndefined();
  expect(text(view.tree)).toContain("Panel grant expired");
  await click(button(view.tree, "重新打开面板"));
  view.attach();
  status = 401;
  await view.call("context.get", undefined, "auth-one");
  await view.call("context.get", undefined, "auth-two");
  expect(view.authLost).toBe(1);
});

test("unmount cancels pending confirmations and deletes the original workspace grant", async () => {
  setApiWorkspace("/workspace/original");
  const view = await fixture();
  await view.call("agent.submitPrompt", { prompt: "Pending task" });
  setApiWorkspace("/workspace/later");
  await view.unmount();
  expect(view.submissions).toHaveLength(0);
  expect(view.dirty).toBe(false);
  const deletes = view.requests.filter((request) => request.method === "DELETE");
  expect(deletes).toHaveLength(1);
  expect(deletes[0].url.searchParams.get("workspace")).toBe("/workspace/original");
});

test("a late prepare response is cleaned up after the component has unmounted", async () => {
  setApiWorkspace("/workspace/original");
  let resolvePrepare!: (response: Response) => void;
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/prepare"))
        return new Promise<Response>((resolve) => {
          resolvePrepare = resolve;
        });
    },
  });
  await view.unmount();
  setApiWorkspace("/workspace/later");
  await act(async () => {
    resolvePrepare(Response.json(prepared));
    await flushMicrotasks();
  });
  const cleanup = view.requests.find((request) => request.method === "DELETE")!;
  expect(cleanup.url.searchParams.get("workspace")).toBe("/workspace/original");
  expect(view.requests[0].signal?.aborted).toBe(true);
});

test("lease renewal on resume retains the same iframe and its original workspace", async () => {
  setApiWorkspace("/workspace/original");
  const view = await fixture();
  await view.ready();
  const frame = view.attach()!;
  setApiWorkspace("/workspace/later");
  setSystemTime(prepared.expiresAt - 59_000);
  await view.resume();
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/renew"))).toHaveLength(
    1,
  );
  expect(
    view.requests
      .find((request) => request.url.pathname.endsWith("/renew"))!
      .url.searchParams.get("workspace"),
  ).toBe("/workspace/original");
  expect(view.attach()!.props.src).toBe(frame.props.src);
  expect(view.attach()!.props.ref.current.contentWindow).toBe(
    frame.props.ref.current.contentWindow,
  );
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/prepare"))).toHaveLength(
    1,
  );
  expect(view.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  expect(text(view.tree)).not.toContain("正在打开面板");
});

test("temporary renewal errors preserve the iframe and revoked renewals require reopening", async () => {
  let status = 503;
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/renew"))
        return Response.json({ error: "Lease revoked" }, { status });
    },
  });
  await view.ready();
  setSystemTime(prepared.expiresAt - 59_000);
  await view.resume();
  expect(view.attach()).toBeDefined();
  expect(text(view.tree)).toContain("当前内容会保留");
  expect(view.authLost).toBe(0);
  status = 410;
  setSystemTime(prepared.expiresAt - 53_000);
  await view.resume();
  expect(view.attach()).toBeUndefined();
  expect(text(view.tree)).toContain("Lease revoked");
  expect(view.authLost).toBe(0);
});

test("server events wait for iframe readiness and host confirmations stay in the parent", async () => {
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/events"))
        return Response.json({
          cursor: 2,
          events: [
            {
              id: 1,
              event: "process.output",
              payload: { processId: "process-one", data: "hello" },
            },
            {
              id: 2,
              event: "host.confirm",
              payload: {
                requestId: "run-one",
                title: "运行下载工具",
                body: "yt-dlp synthetic-url",
              },
            },
          ],
        });
    },
  });
  expect(view.replies.some((reply) => reply.data.event === "process.output")).toBe(false);
  expect(text(view.tree)).toContain("运行下载工具");
  expect(view.attach()!.props.inert).toBe(true);
  expect(view.dirty).toBe(true);
  await view.ready();
  expect(view.replies.filter((reply) => reply.data.event === "process.output")).toHaveLength(1);
  expect(view.replies.some((reply) => reply.data.event === "host.confirm")).toBe(false);
  await click(button(view.tree, "确认执行"));
  expect(view.requests.find((request) => request.url.pathname.endsWith("/confirm"))!.body).toEqual({
    requestId: "run-one",
    allowed: true,
  });
  expect(text(view.tree)).not.toContain("运行下载工具");
  expect(view.dirty).toBe(false);
});

test("failed host confirmation can be retried and cancelling explicitly denies the server request", async () => {
  let failing = true;
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/events"))
        return Response.json({
          cursor: 1,
          events: [
            {
              id: 1,
              event: "host.confirm",
              payload: { requestId: "run-two", title: "运行命令", body: "synthetic command" },
            },
          ],
        });
      if (request.url.pathname.endsWith("/confirm") && failing)
        return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    },
  });
  await click(button(view.tree, "确认执行"));
  expect(text(view.tree)).toContain("暂未收到确认结果");
  expect(text(view.tree)).toContain("运行命令");
  failing = false;
  await click(button(view.tree, "取消"));
  const confirmations = view.requests.filter((request) =>
    request.url.pathname.endsWith("/confirm"),
  );
  expect(confirmations.map((request) => request.body)).toEqual([
    { requestId: "run-two", allowed: true },
    { requestId: "run-two", allowed: false },
  ]);
  expect(view.attach()!.props.inert).toBe(false);
});

test("a confirmation that already timed out does not close the panel", async () => {
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/events"))
        return Response.json({
          cursor: 1,
          events: [
            {
              id: 1,
              event: "host.confirm",
              payload: { requestId: "run-three", title: "运行命令", body: "synthetic command" },
            },
          ],
        });
      if (request.url.pathname.endsWith("/confirm"))
        return Response.json({ accepted: true, allowed: false });
    },
  });
  await click(button(view.tree, "确认执行"));
  expect(text(view.tree)).toContain("此确认已超时");
  expect(view.attach()).toBeDefined();
  expect(view.authLost).toBe(0);
});

test("cancelling after an uncertain approved response reports the server's actual outcome", async () => {
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/events"))
        return Response.json({
          cursor: 1,
          events: [
            {
              id: 1,
              event: "host.confirm",
              payload: {
                requestId: "already-approved",
                title: "运行命令",
                body: "synthetic command",
              },
            },
          ],
        });
      if (request.url.pathname.endsWith("/confirm"))
        return Response.json({ accepted: true, allowed: true });
    },
  });
  await click(button(view.tree, "取消"));
  expect(text(view.tree)).toContain("该操作此前已获准执行");
  expect(text(view.tree)).not.toContain("未获准执行");
});

test("only a delivered tool invocation can return one bounded iframe tool result", async () => {
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/events"))
        return Response.json({
          cursor: 1,
          events: [
            {
              id: 1,
              event: "tools.invoke",
              payload: { requestId: "tool-one", toolName: "design.list", args: {} },
            },
          ],
        });
    },
  });
  const result = {
    type: "codeshell-panel:tool-result",
    instanceId,
    requestId: "tool-one",
    result: { items: [] },
  };
  await view.message(result);
  expect(view.requests.some((request) => request.url.pathname.endsWith("/tool-results"))).toBe(
    false,
  );
  await view.ready();
  expect(view.replies.some((reply) => reply.data.event === "tools.invoke")).toBe(true);
  await view.message(result, "https://attacker.invalid");
  await view.message(result, "null", {});
  await view.message({ ...result, instanceId: "other-instance" });
  await view.message({ ...result, requestId: "unseen-tool" });
  await view.message({ ...result, result: "中".repeat(180_000) });
  expect(view.requests.some((request) => request.url.pathname.endsWith("/tool-results"))).toBe(
    false,
  );
  await view.message(result);
  await view.message(result);
  expect(
    view.requests.filter((request) => request.url.pathname.endsWith("/tool-results")),
  ).toHaveLength(1);
});

test("unmount aborts event polling and pending renewal without late UI updates", async () => {
  let resolveRenew!: (response: Response) => void;
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/events")) return new Promise<Response>(() => {});
      if (request.url.pathname.endsWith("/renew"))
        return new Promise<Response>((resolve) => {
          resolveRenew = resolve;
        });
    },
  });
  setSystemTime(prepared.expiresAt - 59_000);
  await view.resume();
  await view.unmount();
  expect(
    view.requests.find((request) => request.url.pathname.endsWith("/events"))!.signal?.aborted,
  ).toBe(true);
  expect(
    view.requests.find((request) => request.url.pathname.endsWith("/renew"))!.signal?.aborted,
  ).toBe(true);
  await act(async () => {
    resolveRenew(Response.json({ expiresAt: Date.now() + 30 * 60_000 }));
    await flushMicrotasks();
  });
  await view.resume();
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/renew"))).toHaveLength(
    1,
  );
  expect(view.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
});

test("server directory results display the remote path without claiming a local folder opened", async () => {
  const view = await fixture({
    intercept(request) {
      if (request.body?.method === "filesystem.openDirectory")
        return Response.json({
          effect: "filesystem.openDirectory",
          path: "/server/downloads",
          opened: false,
        });
    },
  });
  await view.call("filesystem.openDirectory", { path: "/server/downloads" });
  expect(text(view.tree)).toContain("文件保存在服务器目录：/server/downloads");
  expect(view.replies.at(-1)?.data.result).toEqual({ opened: false, path: "/server/downloads" });
});

test("server directory links open only on a user's click and retain their original workspace", async () => {
  setApiWorkspace("/workspace/original");
  const path = `/api/v1/panels/runtime/${instanceId}/directory/f2f099cc-5c0d-444f-ac44-76165b436e3a`;
  const view = await fixture({
    intercept(request) {
      if (request.body?.method === "filesystem.openDirectory")
        return Response.json({
          effect: "filesystem.openDirectory",
          path: "/server/downloads",
          opened: false,
          url: path,
        });
    },
  });
  setApiWorkspace("/workspace/later");
  await view.call("filesystem.openDirectory", { path: "/server/downloads" });
  const link = elements(view.tree).find(
    (item) => item.type === "a" && text(item) === "查看并下载文件",
  )!;
  expect(link.props).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
  const url = new URL(link.props.href, "http://localhost");
  expect(url.pathname).toBe(path);
  expect(url.searchParams.get("workspace")).toBe("/workspace/original");
  expect(text(view.tree)).toContain("文件保存在服务器目录：/server/downloads");
  expect(view.replies.at(-1)?.data.result).toEqual({ opened: false, path: "/server/downloads" });
  expect(view.requests.some((request) => request.url.pathname === path)).toBe(false);
  await view.unmount();
});

for (const url of [
  "javascript:alert(1)",
  "https://attacker.invalid/directory/f2f099cc-5c0d-444f-ac44-76165b436e3a",
  "/api/v1/panels/runtime/other-instance-1234567890/directory/f2f099cc-5c0d-444f-ac44-76165b436e3a",
  `/api/v1/panels/runtime/${instanceId}/directory/../../auth/status`,
  `/api/v1/panels/runtime/${instanceId}/directory/%2fapi%2fv1%2fauth`,
  `/api/v1/panels/runtime/${instanceId}/directory/f2f099cc-5c0d-444f-ac44-76165b436e3a?redirect=https://attacker.invalid`,
  `/api/v1/panels/runtime/${instanceId}/directory/not-a-handle`,
])
  test(`rejects an unsafe server directory link: ${url}`, async () => {
    const view = await fixture({
      intercept(request) {
        if (request.body?.method === "filesystem.openDirectory")
          return Response.json({
            effect: "filesystem.openDirectory",
            path: "/server/downloads",
            opened: false,
            url,
          });
      },
    });
    await view.call("filesystem.openDirectory", { path: "/server/downloads" });
    expect(elements(view.tree).some((item) => item.type === "a")).toBe(false);
    expect(view.replies.at(-1)?.data.error).toContain("目录链接无效");
  });

test("revoked grants remove their previous directory download links", async () => {
  const view = await fixture({
    intercept(request) {
      if (request.body?.method === "filesystem.openDirectory")
        return Response.json({
          effect: "filesystem.openDirectory",
          path: "/server/downloads",
          opened: false,
          url: `/api/v1/panels/runtime/${instanceId}/directory/f2f099cc-5c0d-444f-ac44-76165b436e3a`,
        });
      if (request.body?.method === "context.get")
        return Response.json({ error: "Panel closed" }, { status: 410 });
    },
  });
  await view.call("filesystem.openDirectory", { path: "/server/downloads" });
  expect(text(view.tree)).toContain("查看并下载文件");
  await view.call("context.get");
  expect(text(view.tree)).not.toContain("查看并下载文件");
});
