import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type {
  ManagedPanel,
  PanelDiscovery,
  PanelReview,
  PanelSnapshot,
} from "../../server/src/panels/types.js";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { setApiWorkspace } from "./api-context.js";
import { HubPanels } from "./HubPanels.js";

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
function button(tree: React.ReactNode, label: string, index = 0): Element {
  const found = elements(tree).filter(
    (element) => element.type === "button" && text(element) === label,
  )[index];
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
const source = {
  kind: "git" as const,
  url: "https://github.com/synthetic-owner/test-panels.git",
  ref: "main",
  commit: "a".repeat(40),
  subdir: "apps/test-panel",
};
const review: PanelReview = {
  kind: "install",
  reviewToken: "opaque-reviewed-content",
  expiresAt: Date.now() + 60 * 60 * 1000,
  expectedRevision: null,
  source,
  compatibility: { supported: true, reasons: [] },
  preview: {
    id: "test-panel",
    version: "1.0.0",
    title: { default: "Test panel", "zh-CN": "验收面板" },
    description: "A synthetic installable panel",
    entry: "ui/index.html",
    icon: "panel",
    singleton: true,
    permissions: ["context.workspace", "workspace.read"],
    agent: {
      tools: [
        {
          name: "read_data",
          description: "Reads sample data",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      skills: ["agent/skills/test-skill/SKILL.md"],
    },
    alreadyInstalled: false,
    source: { kind: "git", label: source.url },
    warnings: [],
  },
};
const discovery: PanelDiscovery = {
  source,
  panels: [
    {
      subdir: source.subdir,
      source: { ...source, ref: source.ref },
      id: review.preview.id,
      version: review.preview.version,
      title: review.preview.title,
      description: review.preview.description,
      icon: "panel",
    },
  ],
  issues: [],
};
function panel(patch: Partial<ManagedPanel> = {}): ManagedPanel {
  const { alreadyInstalled: _installed, warnings: _warnings, ...manifest } = review.preview;
  return {
    ...manifest,
    revision: "original-revision",
    bound: true,
    enabled: true,
    globalDisabled: false,
    updatable: true,
    source: { ...source, label: source.url },
    compatibility: { supported: true, reasons: [] },
    ...patch,
  };
}
const originalFetch = globalThis.fetch;
const unmounts: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  globalThis.fetch = originalFetch;
  setApiWorkspace(undefined);
});

interface Request {
  url: URL;
  method: string;
  body?: Record<string, any>;
  signal?: AbortSignal | null;
}
async function fixture(
  options: {
    panels?: ManagedPanel[];
    review?: PanelReview;
    discovery?: PanelDiscovery;
    intercept?: (request: Request) => Response | Promise<Response> | undefined;
  } = {},
) {
  ensureMiniDom();
  let snapshot: PanelSnapshot = {
    panels: options.panels ?? [],
    workspace: "/workspace/original",
    hasProject: true,
  };
  const requests: Request[] = [];
  const opened: ManagedPanel[] = [];
  let changed = 0;
  let authLost = 0;
  globalThis.fetch = (async (path, init) => {
    const request = {
      url: new URL(String(path), "http://localhost"),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    };
    requests.push(request);
    const intercepted = options.intercept?.(request);
    if (intercepted) return intercepted;
    const { pathname } = request.url;
    if (pathname === "/api/v1/panels" && request.method === "GET") return Response.json(snapshot);
    if (pathname === "/api/v1/panels/github/discover")
      return Response.json(options.discovery ?? discovery);
    if (pathname === "/api/v1/panels/preview") return Response.json(options.review ?? review);
    if (pathname.endsWith("/update-preview"))
      return Response.json({
        ...(options.review ?? review),
        kind: "update",
        expectedRevision: snapshot.panels[0]?.revision,
      });
    if (pathname === "/api/v1/panels/install") {
      snapshot = {
        ...snapshot,
        panels: [panel({ bound: !!request.body?.bind, enabled: !!request.body?.bind })],
      };
      return Response.json({ id: review.preview.id });
    }
    if (pathname.endsWith("/binding")) {
      snapshot = {
        ...snapshot,
        panels: snapshot.panels.map((value) => ({
          ...value,
          bound: !!request.body?.bound,
          enabled: !!request.body?.bound,
        })),
      };
      return Response.json(snapshot);
    }
    if (pathname === `/api/v1/panels/${review.preview.id}` && request.method === "DELETE") {
      snapshot = { ...snapshot, panels: [] };
      return Response.json({ removed: true });
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${pathname}`);
  }) as typeof fetch;
  let tree!: Element;
  let dirty = false;
  let version = 0;
  function MountedPanels() {
    tree = HubPanels({
      onAuthLost: () => authLost++,
      onDirtyChange: (value) => {
        dirty = value;
      },
      onChanged: () => changed++,
      onOpen: (value) => {
        opened.push(value);
      },
      configurationVersion: version,
    });
    return tree;
  }
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(async () => {
      root.render(<MountedPanels />);
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
  return {
    get tree() {
      return tree;
    },
    get dirty() {
      return dirty;
    },
    get changed() {
      return changed;
    },
    get authLost() {
      return authLost;
    },
    requests,
    opened,
    unmount,
    async refresh(panels: ManagedPanel[]) {
      snapshot = { ...snapshot, panels };
      version++;
      await render();
    },
  };
}

test("GitHub discovery reviews the selected candidate and installs only its opaque token before opening", async () => {
  setApiWorkspace("/workspace/演示 %20");
  const view = await fixture();
  await click(button(view.tree, "浏览官方仓库"));
  expect(text(view.tree)).toContain("找到 1 个面板");
  await click(button(view.tree, "审阅安装"));
  expect(text(view.tree)).toContain(source.commit);
  expect(text(view.tree)).toContain("读取工作区文件");
  expect(text(view.tree)).toContain("Skill · test-skill");
  expect(view.dirty).toBe(true);
  expect(view.requests.find((request) => request.url.pathname.endsWith("/preview"))?.body).toEqual({
    source: discovery.panels[0].source,
  });
  await click(button(view.tree, "确认安装"));
  const install = view.requests.find((request) => request.url.pathname.endsWith("/install"))!;
  expect(install.body).toEqual({ reviewToken: review.reviewToken, bind: true });
  expect(install.url.searchParams.get("workspace")).toBe("/workspace/演示 %20");
  expect(view.changed).toBe(1);
  expect(view.dirty).toBe(false);
  await click(button(view.tree, "打开面板"));
  expect(view.opened.map((item) => item.id)).toEqual(["test-panel"]);
});

test("unsupported installed panels cannot be opened or newly bound", async () => {
  const unsupported = { supported: false, reasons: ["此面板需要桌面专属的进程能力。"] };
  const view = await fixture({
    panels: [panel({ bound: false, enabled: false, compatibility: unsupported })],
  });
  expect(button(view.tree, "打开面板").props.disabled).toBe(true);
  expect(button(view.tree, "绑定工作区").props.disabled).toBe(true);
  // The compatibility is deserialized through the same endpoint as a real host.
  expect(elements(view.tree).find((item) => item.props.value?.reasons)?.props.value).toEqual(
    unsupported,
  );
  expect(view.opened).toHaveLength(0);
});

test("partial host support remains usable and is described before binding", async () => {
  const partial = { supported: true, reasons: ["基础界面可用；视频转码需要桌面宿主。"] };
  const view = await fixture({
    panels: [panel({ compatibility: partial })],
    review: { ...review, compatibility: partial },
  });
  expect(button(view.tree, "打开面板").props.disabled).not.toBe(true);
  const compatibility = elements(view.tree).find((item) => item.props.value?.reasons)!;
  expect(
    text((compatibility.type as (props: any) => React.ReactNode)(compatibility.props)),
  ).toContain("部分功能可用");
  await click(button(view.tree, "检查更新"));
  expect(text(view.tree)).toContain("已绑定当前工作区，更新将保留绑定");
  await click(button(view.tree, "确认更新"));
  expect(
    view.requests.find((request) => request.url.pathname.endsWith("/install"))?.body?.bind,
  ).toBe(true);
});

test("an unsafe-to-run panel may be installed but never automatically bound", async () => {
  const view = await fixture({
    review: { ...review, compatibility: { supported: false, reasons: ["缺少安全隔离运行条件。"] } },
  });
  await click(button(view.tree, "浏览官方仓库"));
  await click(button(view.tree, "审阅安装"));
  expect(text(view.tree)).toContain("当前 Web 工作台无法绑定或打开它");
  const bind = elements(view.tree).find(
    (item) => item.type === "input" && item.props.type === "checkbox",
  )!;
  expect(bind.props.checked).toBe(false);
  expect(bind.props.disabled).toBe(true);
  await click(button(view.tree, "确认安装"));
  expect(
    view.requests.find((request) => request.url.pathname.endsWith("/install"))?.body?.bind,
  ).toBe(false);
});

test("the all-panels entry reviews one candidate at a time and requires a separate install for each", async () => {
  const second = {
    ...discovery.panels[0],
    id: "second-panel",
    subdir: "apps/second-panel",
    source: { ...source, subdir: "apps/second-panel" },
    title: { default: "Second panel" },
  };
  const view = await fixture({
    discovery: { ...discovery, panels: [discovery.panels[0], second] },
    intercept(request) {
      if (
        request.url.pathname === "/api/v1/panels/preview" &&
        request.body?.source.subdir === "apps/second-panel"
      )
        return Response.json({
          ...review,
          reviewToken: "second-reviewed-token",
          source: second.source,
          preview: { ...review.preview, id: second.id, title: second.title },
        });
    },
  });
  await click(button(view.tree, "浏览官方仓库"));
  await click(button(view.tree, "逐个审阅未安装面板（2）"));
  expect(text(view.tree)).toContain("正在审阅第 1 / 2 个面板");
  expect(view.requests.some((request) => request.url.pathname.endsWith("/install"))).toBe(false);
  await click(button(view.tree, "确认安装"));
  expect(text(view.tree)).toContain("正在审阅第 2 / 2 个面板");
  expect(text(view.tree)).toContain("Second panel");
  expect(view.requests.filter((request) => request.url.pathname.endsWith("/install"))).toHaveLength(
    1,
  );
  await click(button(view.tree, "确认安装"));
  expect(
    view.requests
      .filter((request) => request.url.pathname.endsWith("/install"))
      .map((request) => request.body?.reviewToken),
  ).toEqual(["opaque-reviewed-content", "second-reviewed-token"]);
  expect(view.dirty).toBe(false);
  expect(text(view.tree)).not.toContain("正在审阅第");
});

test("skipping and cancelling sequential review never installs unconfirmed candidates", async () => {
  const second = {
    ...discovery.panels[0],
    id: "second-panel",
    subdir: "apps/second-panel",
    source: { ...source, subdir: "apps/second-panel" },
  };
  const view = await fixture({
    discovery: { ...discovery, panels: [discovery.panels[0], second] },
  });
  await click(button(view.tree, "浏览官方仓库"));
  await click(button(view.tree, "逐个审阅未安装面板（2）"));
  await click(button(view.tree, "跳过此面板"));
  expect(text(view.tree)).toContain("正在审阅第 2 / 2 个面板");
  await click(button(view.tree, "取消逐个审阅"));
  expect(text(view.tree)).not.toContain("正在审阅第");
  expect(view.requests.some((request) => request.url.pathname.endsWith("/install"))).toBe(false);
});

test("a stale reviewed version cannot be resubmitted and must be explicitly reviewed again", async () => {
  let installCount = 0;
  const view = await fixture({
    panels: [panel()],
    intercept(request) {
      if (request.url.pathname.endsWith("/install") && installCount++ === 0)
        return Response.json({ error: "另一设备已更新此面板。" }, { status: 409 });
    },
  });
  await click(button(view.tree, "检查更新"));
  await click(button(view.tree, "确认更新"));
  expect(text(view.tree)).toContain("另一设备已更新此面板。");
  expect(text(view.tree)).not.toContain("确认更新");
  await view.refresh([panel({ revision: "concurrent-revision" })]);
  await click(button(view.tree, "重新审阅"));
  const previews = view.requests.filter((request) =>
    request.url.pathname.endsWith("/update-preview"),
  );
  expect(previews.map((request) => request.body)).toEqual([
    { expectedRevision: "original-revision" },
    { expectedRevision: "concurrent-revision" },
  ]);
  expect(installCount).toBe(1);
});

test("an expired review performs no install request", async () => {
  const view = await fixture({ review: { ...review, expiresAt: Date.now() - 1 } });
  await click(button(view.tree, "浏览官方仓库"));
  await click(button(view.tree, "审阅安装"));
  await click(button(view.tree, "确认安装"));
  expect(text(view.tree)).toContain("安装审阅已过期");
  expect(view.requests.some((request) => request.url.pathname.endsWith("/install"))).toBe(false);
  expect(button(view.tree, "重新审阅")).toBeDefined();
});

test("binding and confirmed uninstall carry the reviewed local revision", async () => {
  const view = await fixture({ panels: [panel({ bound: false, enabled: false })] });
  await click(button(view.tree, "绑定工作区"));
  expect(view.requests.find((request) => request.method === "PATCH")?.body).toEqual({
    bound: true,
    expectedRevision: "original-revision",
  });
  await click(button(view.tree, "卸载"));
  expect(view.requests.some((request) => request.method === "DELETE")).toBe(false);
  expect(text(view.tree)).toContain("其他工作区也将无法打开它");
  await click(button(view.tree, "确认卸载"));
  expect(view.requests.find((request) => request.method === "DELETE")?.body).toEqual({
    expectedRevision: "original-revision",
  });
  expect(text(view.tree)).toContain("还没有安装面板");
});

test("a concurrent panel change requires reviewing the new version before uninstalling", async () => {
  const view = await fixture({ panels: [panel()] });
  await click(button(view.tree, "卸载"));
  await view.refresh([panel({ revision: "updated-revision", version: "2.0.0" })]);
  expect(button(view.tree, "确认卸载").props.disabled).toBe(true);
  expect(text(view.tree)).toContain("面板已被其他设备修改");
  await click(button(view.tree, "查看最新版本"));
  expect(view.requests.some((request) => request.method === "DELETE")).toBe(false);
  await click(button(view.tree, "确认卸载"));
  expect(view.requests.find((request) => request.method === "DELETE")?.body).toEqual({
    expectedRevision: "updated-revision",
  });
});

test("an existing candidate updates its installed source instead of overwriting from a new repository", async () => {
  const view = await fixture({ panels: [panel()] });
  await click(button(view.tree, "浏览官方仓库"));
  await click(button(view.tree, "已安装 · 检查更新"));
  expect(view.requests.some((request) => request.url.pathname === "/api/v1/panels/preview")).toBe(
    false,
  );
  expect(
    view.requests.find((request) => request.url.pathname.endsWith("/update-preview"))?.body,
  ).toEqual({
    expectedRevision: "original-revision",
  });
});

test("unmount aborts the captured workspace mutation and ignores its late response", async () => {
  setApiWorkspace("/workspace/original");
  let resolveInstall!: (response: Response) => void;
  const view = await fixture({
    intercept(request) {
      if (request.url.pathname.endsWith("/install"))
        return new Promise<Response>((resolve) => {
          resolveInstall = resolve;
        });
    },
  });
  await click(button(view.tree, "浏览官方仓库"));
  await click(button(view.tree, "审阅安装"));
  await click(button(view.tree, "确认安装"));
  const install = view.requests.find((request) => request.url.pathname.endsWith("/install"))!;
  setApiWorkspace("/workspace/later");
  await view.unmount();
  expect(install.signal?.aborted).toBe(true);
  expect(install.url.searchParams.get("workspace")).toBe("/workspace/original");
  await act(async () => {
    resolveInstall(Response.json({ id: "test-panel" }));
    await flushMicrotasks();
  });
  expect(view.changed).toBe(0);
  expect(view.dirty).toBe(false);
});

test("expired host authentication returns control to the shared sign-in flow", async () => {
  const view = await fixture({
    intercept: () => Response.json({ error: "Session expired" }, { status: 401 }),
  });
  expect(view.authLost).toBe(1);
  expect(view.requests).toHaveLength(1);
  expect(button(view.tree, "浏览官方仓库").props.disabled).toBe(true);
});
