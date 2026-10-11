import { afterAll, afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "../../../../packages/web/node_modules/react-dom/client.js";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMiniDom,
  flushMicrotasks,
} from "../../../../packages/web/src/test-utils/renderHook.tsx";
import { HubSettings } from "../../../../packages/web/app/HubSettings.tsx";
import { HubSkills } from "../../../../packages/web/app/HubSkills.tsx";
import { HubMcp } from "../../../../packages/web/app/HubMcp.tsx";
import { setApiWorkspace, setApiProject } from "../../../../packages/web/app/api-context.ts";

const realFetch = globalThis.fetch;
const forbid = async () => {
  throw new Error("Network forbidden outside review fixture");
};
globalThis.fetch = forbid as typeof fetch;
// Install the deny-all network boundary before Core-facing imports.
const { createHubConfiguration } =
  await import("../../../../packages/server/src/hub/configuration.ts");
const { createHubSkills } =
  await import("../../../../packages/server/src/hub/skills-management.ts");
const { startHeadlessServer } =
  await import("../../../../packages/server/src/serve/headless-server.ts");
const cleanups: Array<() => void | Promise<void>> = [];
const requests: Array<{ path: string; method: string; body: any }> = [];
function props(node: any): any {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function nodes(node: any): any[] {
  return [node, ...(node.childNodes ?? []).flatMap(nodes)];
}
function textOf(node: any): string {
  return node.childNodes?.length ? node.childNodes.map(textOf).join("") : (node.textContent ?? "");
}
function find(root: any, tag: string, match: (p: any, n: any) => boolean = () => true): any {
  const result = nodes(root).find((n) => n.tagName === tag.toUpperCase() && match(props(n), n));
  if (!result) throw new Error(`Missing ${tag}: ${textOf(root)}`);
  return result;
}
function button(root: any, label: string) {
  return find(root, "button", (_p, n) => textOf(n) === label);
}
async function click(node: any) {
  expect(props(node).disabled).not.toBe(true);
  await act(async () => {
    props(node).onClick?.({ currentTarget: node });
    await flushMicrotasks();
  });
}
async function change(node: any, value: string) {
  await act(async () => {
    props(node).onChange({ target: { value } });
    await flushMicrotasks();
  });
}
async function submit(node: any) {
  await act(async () => {
    void props(node).onSubmit({ preventDefault() {}, nativeEvent: {} });
    await flushMicrotasks();
  });
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await flushMicrotasks();
    });
  }
  throw new Error("Fixture did not settle");
}
async function mount(element: React.ReactNode) {
  ensureMiniDom();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await flushMicrotasks();
  });
  cleanups.push(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
  return container;
}
async function service(kind: "configuration" | "skills" | "full-configuration") {
  const cwd = mkdtempSync(join(tmpdir(), "codeshell-review-20261012-web-round2-state-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  writeFileSync(
    join(cwd, ".code-shell", "settings.local.json"),
    JSON.stringify({
      defaults: { text: "one", auxText: "one" },
      modelConnections: ["one", "two", "three"].map((id) => ({
        id,
        catalogId: "openai",
        tag: "text",
        model: `fixture-${id}`,
      })),
    }),
  );
  const skillDir = join(cwd, ".code-shell", "skills", "review-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: review-skill\ndescription: Review fixture\n---\n\n# Initial instructions\n",
  );
  let cookie = "",
    origin: string,
    bootstrapToken: string | undefined;
  if (kind === "full-configuration") {
    const workerEntryPath = join(cwd, "fixture-worker.cjs");
    writeFileSync(workerEntryPath, "process.stdin.resume();\n");
    const host = await startHeadlessServer({
      cwd,
      dataDir: join(cwd, "host"),
      workerEntryPath,
      authMode: "hub",
      port: 0,
    });
    cleanups.push(() => host.close());
    origin = host.url;
    bootstrapToken = host.bootstrapToken;
  } else {
    const handler =
      kind === "configuration"
        ? createHubConfiguration({ cwd })
        : createHubSkills({ cwd, dataDir: join(cwd, "data"), owner: async () => "fixture" });
    const server = createServer((req, res) => {
      void handler.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      if ("close" in handler) await (handler as any).close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }
  let defaultsRequest = 0;
  let firstDefaultFinished!: () => void;
  const firstDefaultResponse = new Promise<void>((resolve) => {
    firstDefaultFinished = resolve;
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), origin);
    if (url.origin !== origin) throw new Error(`Forbidden origin: ${url.origin}`);
    requests.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const headers = new Headers(init?.headers);
    headers.set("Origin", origin);
    if (cookie) headers.set("Cookie", cookie);
    const isDefault = kind === "full-configuration" && url.pathname.endsWith("/defaults");
    const ordinal = isDefault ? ++defaultsRequest : 0;
    // Model two tab requests already created from the old form, with the second
    // reaching the host only after the first transaction has released its gate.
    if (ordinal === 2) await firstDefaultResponse;
    const response = await realFetch(url, { ...init, headers });
    if (ordinal === 1) firstDefaultFinished();
    return response;
  }) as typeof fetch;
  if (kind === "full-configuration") {
    const setup = await fetch(`${origin}/api/v1/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: bootstrapToken,
        username: "admin",
        password: "fixture-only-password",
        deviceName: "review",
      }),
    });
    expect(setup.status).toBe(200);
    cookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
  }
  return { origin, cwd };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  requests.length = 0;
  setApiWorkspace(undefined);
  setApiProject(null);
  globalThis.fetch = forbid as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("confirmed: two edited default-model forms overwrite an untouched setting after the production mutation gate releases", async () => {
  const { origin } = await service("full-configuration");
  let dirtyA = false,
    dirtyB = false;
  const a = await mount(
    <HubSettings
      section="models"
      onAuthLost={() => {}}
      onDirtyChange={(value) => {
        dirtyA = value;
      }}
    />,
  );
  const b = await mount(
    <HubSettings
      section="models"
      onAuthLost={() => {}}
      onDirtyChange={(value) => {
        dirtyB = value;
      }}
    />,
  );
  await waitFor(
    () =>
      nodes(a).some((n) => props(n)["aria-label"] === "默认对话模型") &&
      nodes(b).some((n) => props(n)["aria-label"] === "默认辅助模型"),
  );
  await change(
    find(a, "select", (p) => p["aria-label"] === "默认对话模型"),
    "two",
  );
  await change(
    find(b, "select", (p) => p["aria-label"] === "默认辅助模型"),
    "three",
  );
  expect(dirtyA).toBe(true);
  expect(dirtyB).toBe(true);
  // Both UI requests are made from the same original snapshot. The fetch guard
  // delays B's arrival until A's real host transaction and hot-reload gate finish.
  await act(async () => {
    for (const root of [a, b])
      props(find(root, "form", (p) => p.className === "config-card config-defaults")).onSubmit({
        preventDefault() {},
      });
    await flushMicrotasks();
  });
  await waitFor(() => textOf(a).includes("设置已保存") && textOf(b).includes("设置已保存"));
  const updates = requests.filter((r) => r.path.endsWith("/defaults"));
  expect(updates.map((r) => r.body)).toEqual([
    { text: "two", auxText: "one" },
    { text: "one", auxText: "three" },
  ]);
  const final = await (await fetch(`${origin}/api/v1/configuration`)).json();
  expect(final.defaults).toEqual({ text: "one", auxText: "three" });
  expect(textOf(a)).toContain("设置已保存");
  expect(textOf(b)).toContain("设置已保存");
  console.log(
    "DEFAULT_CONFLICT",
    JSON.stringify({
      requests: updates.map((r) => r.body),
      final: final.defaults,
      bothShownSaved: true,
    }),
  );
});

test("confirmed: Skills refresh after a concurrent edit retains the stale revision and cannot recover Save", async () => {
  const { origin } = await service("skills");
  let dirty = false;
  const root = await mount(
    <HubSkills
      onAuthLost={() => {}}
      onDirtyChange={(value) => {
        dirty = value;
      }}
    />,
  );
  await waitFor(() => textOf(root).includes("查看与编辑"));
  await click(button(root, "查看与编辑"));
  await waitFor(() => nodes(root).some((n) => props(n)["aria-label"] === "SKILL.md 内容"));
  const detail = await (await fetch(`${origin}/api/v1/skills/detail?name=review-skill`)).json();
  const draft = detail.content + "\nMy unsaved local draft\n";
  await change(
    find(root, "textarea", (p) => p["aria-label"] === "SKILL.md 内容"),
    draft,
  );
  expect(dirty).toBe(true);
  const changed = await fetch(`${origin}/api/v1/skills/local`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "review-skill",
      content: detail.content + "\nOther device committed\n",
      revision: detail.revision,
    }),
  });
  expect(changed.status).toBe(200);
  await submit(find(root, "form", (p) => p.className === "skills-editor"));
  await waitFor(() => textOf(root).includes("Skill 已发生变化"));
  await click(button(root, "刷新"));
  await waitFor(() => !textOf(root).includes("Skill 已发生变化"));
  expect(props(find(root, "textarea", (p) => p["aria-label"] === "SKILL.md 内容")).value).toBe(
    draft,
  );
  await submit(find(root, "form", (p) => p.className === "skills-editor"));
  await waitFor(() => textOf(root).includes("Skill 已发生变化"));
  const writes = requests.filter(
    (r) => r.path === "/api/v1/skills/local" && r.body?.content === draft,
  );
  expect(writes).toHaveLength(2);
  expect(writes.map((r) => r.body.revision)).toEqual([detail.revision, detail.revision]);
  const current = await (await fetch(`${origin}/api/v1/skills/detail?name=review-skill`)).json();
  expect(current.revision).not.toBe(detail.revision);
  expect(current.content).toContain("Other device committed");
  console.log(
    "SKILL_CONFLICT",
    JSON.stringify({
      saveAttempts: writes.length,
      attemptedRevisions: writes.map((r) => r.body.revision),
      currentRevision: current.revision,
      draftStillPresent: true,
    }),
  );
});

test("confirmed: late MCP probe response restores success for configuration replaced during the probe", async () => {
  let version = 0;
  let resolveProbe!: (response: Response) => void;
  let server = {
    name: "fixture-mcp",
    source: "settings",
    scope: "local",
    editable: true,
    deletable: true,
    hasLocalOverride: true,
    pluginDisabled: false,
    enabled: true,
    transport: "stdio",
    command: "old-command",
    argsCount: 0,
    envKeys: [],
    headerKeys: [],
    envVars: [],
    envHeaders: {},
    disabledTools: [],
  };
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "http://fixture.invalid").pathname;
    if (path === "/api/v1/mcp")
      return Response.json({ workspacePath: "/fixture", servers: [server], removed: [] });
    if (path === "/api/v1/mcp/servers/fixture-mcp/probe")
      return new Promise<Response>((resolve) => {
        resolveProbe = resolve;
      });
    throw new Error(`Unexpected fixture request ${init?.method ?? "GET"} ${path}`);
  }) as typeof fetch;
  ensureMiniDom();
  const container = document.createElement("div");
  const reactRoot = createRoot(container);
  const render = () =>
    act(async () => {
      reactRoot.render(<HubMcp onAuthLost={() => {}} configurationVersion={version} />);
      await flushMicrotasks();
    });
  cleanups.push(async () => {
    await act(async () => {
      reactRoot.unmount();
      await flushMicrotasks();
    });
  });
  await render();
  await click(button(container, "测试连接"));
  expect(typeof resolveProbe).toBe("function");
  // Probe finished on the host; its response is delayed in transit while a second device updates the command.
  const oldResult = {
    name: "fixture-mcp",
    status: "ok",
    checkedAt: new Date(Date.now() - 1000).toISOString(),
    durationMs: 10,
    toolCount: 1,
    tools: [{ name: "old_command_tool", allowed: true }],
  };
  server = { ...server, command: "new-command" };
  version++;
  await render();
  expect(textOf(container)).toContain("new-command");
  expect(textOf(container)).not.toContain("测试连接成功");
  await act(async () => {
    resolveProbe(Response.json(oldResult));
    await flushMicrotasks();
  });
  expect(textOf(container)).toContain("new-command");
  expect(textOf(container)).toContain("测试连接成功");
  expect(textOf(container)).toContain("old_command_tool");
  console.log(
    "MCP_STALE_PROBE",
    JSON.stringify({
      displayedCommand: server.command,
      testedCommand: "old-command",
      displayedSuccess: true,
      displayedTool: "old_command_tool",
    }),
  );
});
