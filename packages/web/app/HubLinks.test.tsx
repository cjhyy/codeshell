import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  getLinkProviderManifest,
  type LinkProviderView,
  type LinkSnapshot,
  type MaskedLinkConnection,
} from "@cjhyy/code-shell-link";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { setApiWorkspace } from "./api-context.js";
import { HubLinks } from "./HubLinks.js";

// Mount the actual component and native element tree; invoke its rendered event
// handlers because the minimal DOM intentionally has no browser event bubbling.
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
function findButton(tree: React.ReactNode, label: string, index = 0): Element {
  const found = elements(tree).filter(
    (element) => element.type === "button" && text(element) === label,
  )[index];
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function input(tree: React.ReactNode, type: "name" | "token"): Element {
  return elements(tree).find(
    (element) =>
      element.type === "input" &&
      (type === "token" ? element.props.type === "password" : element.props.maxLength === 100),
  )!;
}
async function click(element: Element) {
  expect(element.props.disabled).not.toBe(true);
  await act(async () => {
    element.props.onClick();
    await flushMicrotasks();
  });
}

const provider: LinkProviderView = {
  ...getLinkProviderManifest("github")!,
  tokenLabel: "Token",
  tokenPlaceholder: "synthetic-token",
  actions: [],
  deviceAuth: { providerId: "github", configured: true, flow: "device-code" },
};
const methodId = provider.connectionMethods.find(
  (method) => method.executionRuntime === "local" && method.availability === "available",
)!.id;
function connection(
  id = `link-github-${methodId}`,
  patch: Partial<MaskedLinkConnection> = {},
): MaskedLinkConnection {
  return {
    id,
    providerId: "github",
    methodId,
    label: id,
    runtime: "local",
    authSource: "manual-token",
    status: "connected",
    capabilityIds: [],
    revision: `revision-${id}`,
    scope: "user",
    editable: true,
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

async function fixture(connections: MaskedLinkConnection[]) {
  ensureMiniDom();
  let snapshot: LinkSnapshot = {
    providers: [provider],
    connections,
    capabilities: { token: true, cliBinding: true, deviceAuth: true },
    revision: "snapshot-1",
  };
  const requests: Array<{ url: URL; method: string; body?: any }> = [];
  globalThis.fetch = (async (path, init) => {
    const url = new URL(String(path), "http://localhost");
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === "/api/v1/links" && method === "GET") return Response.json(snapshot);
    if (url.pathname === "/api/v1/links/authorizations/device" && method === "POST")
      return Response.json({
        id: "pending-authorization",
        providerId: "github",
        state: "pending",
        prompt: {
          userCode: "FAKE-CODE",
          verificationUri: "https://github.com/login/device",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    if (
      url.pathname === "/api/v1/links/authorizations/pending-authorization" &&
      method === "DELETE"
    )
      return Response.json({ cancelled: true });
    if (url.pathname.startsWith("/api/v1/links/connections/") && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      snapshot = {
        ...snapshot,
        connections: snapshot.connections.filter((item) => item.id !== id),
      };
      return Response.json({ removed: true });
    }
    if (url.pathname === "/api/v1/links/connections/token" && method === "POST")
      return Response.json(connection());
    throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
  }) as typeof fetch;
  let tree!: Element;
  let dirty = false;
  let version = 0;
  function MountedLinks() {
    tree = HubLinks({
      onAuthLost: () => {
        throw new Error("Unexpected auth loss");
      },
      onDirtyChange: (value) => {
        dirty = value;
      },
      configurationVersion: version,
    });
    return tree;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(async () => {
      root.render(<MountedLinks />);
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
    requests,
    unmount,
    async refresh(next: MaskedLinkConnection[]) {
      snapshot = { ...snapshot, connections: next, revision: `snapshot-${++version}` };
      await render();
    },
  };
}

test("disconnecting the authorizing connection cancels its captured workspace URL and releases the editor", async () => {
  setApiWorkspace("/workspace/original");
  const view = await fixture([connection()]);
  await click(findButton(view.tree, "管理连接"));
  await click(findButton(view.tree, "开始授权"));
  expect(view.dirty).toBe(true);
  expect(text(view.tree)).toContain("FAKE-CODE");
  // Cleanup belongs to the original authorization even if the controller scope changes.
  setApiWorkspace("/workspace/later");
  await click(findButton(view.tree, "断开"));
  await click(findButton(view.tree, "确认断开"));
  const deletes = view.requests.filter((request) => request.method === "DELETE");
  expect(deletes.map((request) => request.url.pathname)).toEqual([
    "/api/v1/links/authorizations/pending-authorization",
    `/api/v1/links/connections/${connection().id}`,
  ]);
  expect(deletes[0].url.searchParams.get("workspace")).toBe("/workspace/original");
  expect(text(view.tree)).not.toContain("FAKE-CODE");
  expect(view.dirty).toBe(false);
  expect(findButton(view.tree, "添加连接").props.disabled).not.toBe(true);
  await view.unmount();
  expect(
    view.requests.filter((request) => request.url.pathname.includes("pending-authorization")),
  ).toHaveLength(1);
});

test("disconnecting another connection preserves the current pending authorization and its cancel control", async () => {
  setApiWorkspace("/workspace/original");
  const view = await fixture([connection(), connection("other-connection")]);
  await click(findButton(view.tree, "管理连接"));
  await click(findButton(view.tree, "开始授权"));
  await click(findButton(view.tree, "断开", 1));
  await click(findButton(view.tree, "确认断开"));
  expect(
    view.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.url.pathname),
  ).toEqual(["/api/v1/links/connections/other-connection"]);
  expect(view.dirty).toBe(true);
  expect(text(view.tree)).toContain("FAKE-CODE");
  expect(findButton(view.tree, "取消授权").props.disabled).not.toBe(true);
  await click(findButton(view.tree, "取消授权"));
  expect(text(view.tree)).not.toContain("FAKE-CODE");
  expect(view.dirty).toBe(false);
});

test("a create-only draft explicitly adopts a concurrently created matching connection without losing its input", async () => {
  const view = await fixture([]);
  await click(findButton(view.tree, "添加连接"));
  await act(async () => {
    input(view.tree, "name").props.onChange({ target: { value: "My retained name" } });
  });
  await act(async () => {
    input(view.tree, "token").props.onChange({ target: { value: "synthetic-retained-token" } });
  });
  await view.refresh([
    connection(undefined, { revision: "concurrent-version", label: "Other device name" }),
  ]);
  expect(findButton(view.tree, "验证并保存").props.disabled).toBe(true);
  expect(input(view.tree, "name").props.value).toBe("My retained name");
  expect(input(view.tree, "token").props.value).toBe("synthetic-retained-token");
  expect(view.requests.some((request) => request.method === "POST")).toBe(false);
  await click(findButton(view.tree, "载入最新版本，保留输入"));
  expect(input(view.tree, "name").props.value).toBe("My retained name");
  expect(input(view.tree, "token").props.value).toBe("synthetic-retained-token");
  await act(async () => {
    elements(view.tree)
      .find((element) => element.type === "form")!
      .props.onSubmit({ preventDefault() {} });
    await flushMicrotasks();
  });
  expect(
    view.requests.find((request) => request.url.pathname.endsWith("/connections/token"))?.body,
  ).toMatchObject({
    connectionId: connection().id,
    expectedRevision: "concurrent-version",
    label: "My retained name",
    token: "synthetic-retained-token",
  });
});

test("a new draft does not adopt a different provider, method or connection ID", async () => {
  const view = await fixture([]);
  await click(findButton(view.tree, "添加连接"));
  for (const unrelated of [
    connection(undefined, { methodId: "another-method" }),
    connection(undefined, { providerId: "gitlab" }),
    connection("another-id"),
  ]) {
    await view.refresh([unrelated]);
    expect(text(view.tree)).not.toContain("载入最新版本，保留输入");
    expect(findButton(view.tree, "验证并保存").props.disabled).not.toBe(true);
  }
});
