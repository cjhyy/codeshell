import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { InstalledPanelApp } from "@cjhyy/code-shell-core";
import {
  createPanelRuntime,
  panelWebCompatibility,
  type PanelRuntimeOptions,
  type PanelTaskHost,
  type PanelTaskScope,
} from "./runtime.js";
import { resolvePanelExecutable } from "./process-service.js";
import type { PanelSnapshot } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    html?: string;
    permissions?: InstalledPanelApp["permissions"];
    origin?: string;
    agentTasks?: PanelTaskHost;
    createAgentTasks?: PanelRuntimeOptions["createAgentTasks"];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "codeshell-panel-http-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const installPath = join(root, "installed");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(join(installPath, "app", "nested"), { recursive: true }), mkdir(cwd)]);
  await Promise.all([
    writeFile(
      join(installPath, "app", "index.html"),
      options.html ??
        '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><title>Panel</title></head><body><script type="module" src="./main.mjs"></script></body></html>',
    ),
    writeFile(
      join(installPath, "app", "main.mjs"),
      'import { label } from "./nested/part.mjs"; document.body.dataset.module = label;',
    ),
    writeFile(
      join(installPath, "app", "nested", "part.mjs"),
      'export const label = "module loaded";',
    ),
    writeFile(join(installPath, "secret.json"), '{"outsideEntry":"do not serve"}'),
    writeFile(join(cwd, "notes.txt"), "host workspace notes"),
  ]);
  const app: InstalledPanelApp = {
    id: "synthetic-panel",
    version: "1",
    title: { default: "Synthetic panel" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    permissions: options.permissions ?? [
      "context.session",
      "context.workspace",
      "storage",
      "workspace.info",
      "workspace.read",
      "workspace.write",
      "agent.submitPrompt",
      "external.open",
      "notifications.send",
    ],
    agent: {
      tools: [
        {
          name: "read_panel",
          description: "Read panel",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
      ],
      skills: [],
    },
    installPath,
    source: root,
    installedAt: "2026-09-08T00:00:00.000Z",
    lastUpdated: "2026-09-08T00:00:00.000Z",
  };
  const state = {
    enabled: true,
    present: true,
    revision: "a".repeat(64),
    now: 1000,
    owners: new Set(["owner-a", "owner-b"]),
    beforeSnapshot: undefined as (() => Promise<void>) | undefined,
  };
  const ownerOf = (request: IncomingMessage) =>
    /(?:^|;\s*)session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
  const runtime = createPanelRuntime({
    cwd,
    dataDir: join(root, "data"),
    host: "hub",
    agentTasks: options.agentTasks,
    createAgentTasks: options.createAgentTasks,
    now: () => state.now,
    ownerId: async (request) => ownerOf(request),
    isAuthorized: async (request) => state.owners.has(ownerOf(request) ?? ""),
    listInstalled: async () => (state.present ? [structuredClone(app)] : []),
    snapshot: async (): Promise<PanelSnapshot> => {
      await state.beforeSnapshot?.();
      const {
        installPath: _installPath,
        source: _source,
        installedAt: _installedAt,
        lastUpdated: _lastUpdated,
        ...publicApp
      } = app;
      return {
        workspace: cwd,
        hasProject: true,
        panels: state.present
          ? [
              {
                ...publicApp,
                revision: state.revision,
                bound: state.enabled,
                enabled: state.enabled,
                globalDisabled: false,
                updatable: false,
                source: { kind: "local", label: "Synthetic" },
                compatibility: panelWebCompatibility(app),
              },
            ]
          : [],
      };
    },
  });
  const server = createServer((request, response) => {
    void (async () => {
      if (await runtime.handleAssets(request, response)) return;
      if (await runtime.handle(request, response)) return;
      response.writeHead(404);
      response.end("fallback");
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const api = (path: string, method = "POST", value?: unknown, owner: string | null = "owner-a") =>
    fetch(url + "/api/v1/panels/runtime/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: options.origin ?? url,
        ...(owner ? { Cookie: `session=${owner}` } : {}),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  const prepare = async (owner = "owner-a", extra: Record<string, unknown> = {}) => {
    const result = await api(
      "prepare",
      "POST",
      { appId: app.id, revision: state.revision, sessionId: "session-1234", ...extra },
      owner,
    );
    expect(result.status).toBe(200);
    return result.json() as Promise<{
      instanceId: string;
      src: string;
      expiresAt: number;
      context: Record<string, unknown>;
      limitations: string[];
    }>;
  };
  return { root, cwd, installPath, app, state, runtime, url, api, prepare };
}

describe("Panel HTTP runtime", () => {
  test("serves sandboxed HTML and CORS-enabled ESM bytes without login cookies", async () => {
    const f = await fixture();
    const grant = await f.prepare();
    const response = await fetch(f.url + grant.src, { headers: { Origin: "null" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.indexOf("_codeshell_bridge.js")).toBeLessThan(
      html.indexOf("Content-Security-Policy"),
    );
    expect(html.indexOf("_codeshell_bridge.js")).toBeLessThan(html.indexOf("main.mjs"));
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain(`script-src ${f.url}/api/v1/panel-assets/`);
    expect(csp).toContain("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors ${f.url}`);
    expect(response.headers.get("permissions-policy")).toContain("microphone=()");
    for (const name of ["main.mjs", "nested/part.mjs"]) {
      const module = await fetch(f.url + grant.src.replace("index.html", name), {
        headers: { Origin: "null" },
      });
      expect(module.status).toBe(200);
      expect(module.headers.get("content-type")).toContain("text/javascript");
      expect(module.headers.get("access-control-allow-origin")).toBe("*");
    }
    const head = await fetch(f.url + grant.src, { method: "HEAD" });
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(html));
    expect(await head.text()).toBe("");
    const preflight = await fetch(f.url + grant.src.replace("index.html", "main.mjs"), {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
  });

  test("injects the SDK before scripts in HTML fragments and pages without a head", async () => {
    for (const html of [
      '<div>Fragment</div><script src="./main.mjs"></script>',
      '<!doctype html><html lang="zh"><body><script type="module" src="./main.mjs"></script></body></html>',
    ]) {
      const f = await fixture({ html });
      const grant = await f.prepare();
      const result = await (await fetch(f.url + grant.src)).text();
      expect(result.indexOf("_codeshell_bridge.js")).toBeGreaterThanOrEqual(0);
      expect(result.indexOf("_codeshell_bridge.js")).toBeLessThan(result.indexOf("main.mjs"));
      if (html.startsWith("<!doctype")) expect(result.startsWith("<!doctype html>")).toBe(true);
    }
  });

  test("rejects opaque prepare origins, malformed requests, and unbounded parallel preparation", async () => {
    const opaque = await fixture({ origin: "null" });
    expect(
      (
        await opaque.api("prepare", "POST", {
          appId: opaque.app.id,
          revision: opaque.state.revision,
        })
      ).status,
    ).toBe(400);
    const f = await fixture();
    expect(
      (await f.api("prepare", "POST", { appId: f.app.id, revision: "not-a-digest" })).status,
    ).toBe(400);
    expect(
      (
        await fetch(f.url + "/api/v1/panels/runtime/prepare", {
          method: "POST",
          headers: {
            Origin: f.url,
            Cookie: "session=owner-a",
            "Content-Type": "application/json-untrusted",
          },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    const wait = new Promise<void>((done) => {
      release = done;
    });
    f.state.beforeSnapshot = async () => {
      entered();
      await wait;
    };
    const first = f.api("prepare", "POST", { appId: f.app.id, revision: f.state.revision });
    await ready;
    const others = Array.from({ length: 4 }, () =>
      f.api("prepare", "POST", { appId: f.app.id, revision: f.state.revision }),
    );
    // One additional call may share the snapshot, while the excess requests
    // must fail promptly rather than allocating more package snapshots.
    const result = await Promise.race(others);
    expect(result.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await Promise.all(others)).filter((response) => response.status === 200)).toHaveLength(
      1,
    );
  });

  test("binds SDK responses and events to the exact parent origin, source, and instance", async () => {
    const f = await fixture();
    const grant = await f.prepare();
    const scriptPath = grant.src.slice(0, grant.src.indexOf("/app/")) + "/_codeshell_bridge.js";
    const script = await (await fetch(f.url + scriptPath)).text();
    const messages: any[] = [];
    const handlers = new Map<string, (event: any) => void>();
    const parent = { postMessage: (...args: any[]) => messages.push(args) };
    const window: any = {};
    const timers = new Set<ReturnType<typeof setTimeout>>();
    runInNewContext(script, {
      window,
      parent,
      addEventListener: (name: string, callback: (event: any) => void) =>
        handlers.set(name, callback),
      setTimeout: (callback: () => void, timeout: number) => {
        const timer = setTimeout(callback, timeout);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer);
        timers.delete(timer);
      },
    });
    try {
      for (const name of ["getContext", "call", "on", "registerTool"])
        expect(typeof window.codeshellPanel[name]).toBe("function");
      const result = window.codeshellPanel.getContext();
      expect(messages[0]).toEqual([
        { type: "codeshell-panel:ready", instanceId: grant.instanceId },
        f.url,
      ]);
      const [request, targetOrigin] = messages.find(
        ([value]) => value.type === "codeshell-panel:call",
      );
      expect(targetOrigin).toBe(f.url);
      const response = {
        type: "codeshell-panel:response",
        instanceId: grant.instanceId,
        requestId: request.requestId,
        result: { appId: f.app.id },
      };
      handlers.get("message")!({ source: {}, origin: f.url, data: response });
      handlers.get("message")!({
        source: parent,
        origin: "https://untrusted.example",
        data: response,
      });
      handlers.get("message")!({
        source: parent,
        origin: f.url,
        data: { ...response, instanceId: "wrong" },
      });
      expect(timers.size).toBe(1);
      handlers.get("message")!({ source: parent, origin: f.url, data: response });
      expect(await result).toEqual({ appId: f.app.id });
      let updated: unknown;
      const unsubscribe = window.codeshellPanel.on("context.changed", (value: unknown) => {
        updated = value;
      });
      handlers.get("message")!({
        source: parent,
        origin: f.url,
        data: {
          type: "codeshell-panel:event",
          instanceId: grant.instanceId,
          event: "context.changed",
          payload: { theme: "dark" },
        },
      });
      expect(updated).toEqual({ theme: "dark" });
      unsubscribe();
      expect(() => window.codeshellPanel.on("arbitrary", () => {})).toThrow();
      const unregister = window.codeshellPanel.registerTool("read_panel", () => ({}));
      expect(() => window.codeshellPanel.registerTool("read_panel", () => ({}))).toThrow();
      unregister();
      expect(
        messages.some(
          ([value]) => value.method === "tools.register" && value.params.name === "read_panel",
        ),
      ).toBe(true);
      expect(
        messages.some(
          ([value]) => value.method === "tools.unregister" && value.params.name === "read_panel",
        ),
      ).toBe(true);
      expect(grant.limitations.join(" ")).not.toContain("Agent 扩展工具暂需桌面客户端");
    } finally {
      handlers.get("pagehide")!({});
      for (const timer of timers) clearTimeout(timer);
    }
  });

  test("keeps public HTTPS origin stable behind a proxy and ignores asset Origin spoofing", async () => {
    const f = await fixture({ origin: "https://codeshell.example" });
    const grant = await f.prepare();
    const response = await fetch(f.url + grant.src, {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src https://codeshell.example/api/v1/panel-assets/");
    expect(csp).toContain("frame-ancestors https://codeshell.example");
    expect(csp).not.toContain("untrusted.example");
  });

  test("isolates call owners and enforces manifest permissions without cookie access in the iframe", async () => {
    const f = await fixture({ permissions: ["context.workspace"] });
    const grant = await f.prepare();
    const call = `${grant.instanceId}/call`;
    expect((await f.api(call, "POST", { method: "context.get" }, "owner-b")).status).toBe(403);
    expect((await f.api(call, "POST", { method: "context.get" }, null)).status).toBe(401);
    const own = await f.api(call, "POST", { method: "context.get" });
    expect(own.status).toBe(200);
    const context = await own.json();
    expect(context.cwd).toBe(f.cwd);
    expect(context.sessionId).toBeUndefined();
    expect(context.availableMethods).toEqual(["context.get", "tools.register", "tools.unregister"]);
    expect(
      (await f.api(call, "POST", { method: "storage.get", params: { key: "secret" } })).status,
    ).toBe(403);
    expect((await f.api(call, "POST", { method: "process.spawn", params: {} })).status).toBe(403);
    expect((await f.api(call, "POST", { method: "context.get", cwd: "/etc" })).status).toBe(400);
    expect((await f.api(`${grant.instanceId}`, "DELETE", undefined, "owner-b")).status).toBe(403);
    expect((await fetch(f.url + grant.src)).status).toBe(200);
  });

  test("uses scope-bound storage and workspace operations and returns only validated host effects", async () => {
    const f = await fixture();
    const grant = await f.prepare();
    const call = `${grant.instanceId}/call`;
    expect(
      await (
        await f.api(call, "POST", {
          method: "storage.set",
          params: { key: "draft", value: { saved: true } },
        })
      ).json(),
    ).toBe(true);
    expect(
      await (await f.api(call, "POST", { method: "storage.get", params: { key: "draft" } })).json(),
    ).toEqual({ saved: true });
    expect(
      await (
        await f.api(call, "POST", { method: "workspace.readText", params: { path: "notes.txt" } })
      ).json(),
    ).toMatchObject({ path: "notes.txt", content: "host workspace notes" });
    const write = await f.api(call, "POST", {
      method: "workspace.writeText",
      params: { path: "panel/state.json", content: "{}", expectedModifiedAt: null },
    });
    expect(write.status).toBe(200);
    expect(await readFile(join(f.cwd, "panel/state.json"), "utf8")).toBe("{}");
    expect(
      (
        await f.api(call, "POST", {
          method: "workspace.readText",
          params: { path: "../installed/secret.json" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.api(call, "POST", {
          method: "external.open",
          params: { url: "javascript:alert(1)" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.api(call, "POST", {
          method: "external.open",
          params: { url: "https://name:password@example.com" },
        })
      ).status,
    ).toBe(400);
    expect(
      await (
        await f.api(call, "POST", {
          method: "external.open",
          params: { url: "https://example.com/docs" },
        })
      ).json(),
    ).toEqual({ effect: "external.open", url: "https://example.com/docs" });
    expect(
      await (
        await f.api(call, "POST", {
          method: "agent.submitPrompt",
          params: {
            prompt: "Read this panel",
            displayText: "Panel request",
            sessionId: "someone-else",
          },
        })
      ).json(),
    ).toEqual({
      effect: "agent.submitPrompt",
      prompt: "Read this panel",
      displayText: "Panel request",
      sessionId: "session-1234",
    });
    expect(
      await (
        await f.api(call, "POST", { method: "notifications.send", params: { body: "Saved" } })
      ).json(),
    ).toEqual({ effect: "notifications.send", title: "Synthetic panel", body: "Saved" });
  });

  test("permanently revokes grants on owner logout, expiry, close, unbind, uninstall, and update", async () => {
    for (const action of [
      "logout",
      "expire",
      "close",
      "unbind",
      "uninstall",
      "update",
      "invalidate",
    ] as const) {
      const f = await fixture();
      const grant = await f.prepare();
      if (action === "logout") f.state.owners.delete("owner-a");
      if (action === "expire") f.state.now = grant.expiresAt;
      if (action === "close") f.runtime.close();
      if (action === "unbind") f.state.enabled = false;
      if (action === "uninstall") f.state.present = false;
      if (action === "update") f.state.revision = "b".repeat(64);
      if (action === "invalidate") f.runtime.invalidate(f.app.id);
      if (action === "logout")
        expect(
          (await f.api(`${grant.instanceId}/call`, "POST", { method: "context.get" })).status,
        ).toBe(401);
      expect([410, 404]).toContain((await fetch(f.url + grant.src)).status);
      f.state.owners.add("owner-a");
      f.state.now = 1000;
      f.state.enabled = true;
      f.state.present = true;
      f.state.revision = "a".repeat(64);
      expect((await fetch(f.url + grant.src)).status).toBe(404);
      expect(
        (await f.api(`${grant.instanceId}/call`, "POST", { method: "context.get" })).status,
      ).toBe(410);
    }
  });

  test("cancels only the selected owner's grants and closes a deleted instance immediately", async () => {
    const f = await fixture();
    const first = await f.prepare();
    const second = await f.prepare("owner-b");
    f.runtime.cancelOwner("owner-a");
    expect((await fetch(f.url + first.src)).status).toBe(404);
    expect((await fetch(f.url + second.src)).status).toBe(200);
    expect((await f.api(second.instanceId, "DELETE", undefined, "owner-b")).status).toBe(200);
    expect((await fetch(f.url + second.src)).status).toBe(404);
  });

  test("cancel or invalidation during preparation cannot publish a new grant", async () => {
    for (const action of ["cancel", "invalidate", "close"] as const) {
      const f = await fixture();
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((done) => {
        entered = done;
      });
      const wait = new Promise<void>((done) => {
        release = done;
      });
      f.state.beforeSnapshot = async () => {
        entered();
        await wait;
      };
      const pending = f.api("prepare", "POST", { appId: f.app.id, revision: f.state.revision });
      await ready;
      if (action === "cancel") f.runtime.cancelOwner("owner-a");
      if (action === "invalidate") f.runtime.invalidate(f.app.id);
      if (action === "close") f.runtime.close();
      release();
      expect((await pending).status).toBe(410);
    }
  });

  test("does not resurrect a grant revoked while its snapshot was being checked", async () => {
    const f = await fixture();
    const grant = await f.prepare();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    const wait = new Promise<void>((done) => {
      release = done;
    });
    f.state.beforeSnapshot = async () => {
      entered();
      await wait;
    };
    const response = fetch(f.url + grant.src);
    await ready;
    f.state.owners.delete("owner-a");
    release();
    expect((await response).status).toBe(410);
    f.state.owners.add("owner-a");
    expect((await fetch(f.url + grant.src)).status).toBe(404);
  });

  test("denies changed bytes, installed roots, symlinks, traversal, and files outside the entry subtree", async () => {
    for (const attack of ["bytes", "symlink", "directory", "root"] as const) {
      const f = await fixture();
      const grant = await f.prepare();
      if (attack === "bytes") await writeFile(join(f.installPath, "app/main.mjs"), "changed");
      if (attack === "symlink") {
        await rm(join(f.installPath, "app/main.mjs"));
        await symlink(join(f.installPath, "secret.json"), join(f.installPath, "app/main.mjs"));
      }
      if (attack === "directory") {
        await rename(join(f.installPath, "app"), join(f.installPath, "old-app"));
        await symlink(join(f.installPath, "old-app"), join(f.installPath, "app"));
      }
      if (attack === "root") {
        await rename(f.installPath, f.installPath + "-old");
        await mkdir(f.installPath);
      }
      expect([410, 403, 404, 409]).toContain(
        (await fetch(f.url + grant.src.replace("index.html", "main.mjs"))).status,
      );
      expect(
        (await f.api(`${grant.instanceId}/call`, "POST", { method: "context.get" })).status,
      ).toBe(410);
    }
    const f = await fixture();
    const grant = await f.prepare();
    const base = grant.src.slice(0, grant.src.indexOf("/app/"));
    for (const path of [
      "/secret.json",
      "/app/%2e%2e%2fsecret.json",
      "/app/%252e%252e/secret.json",
      "/app/%00.json",
      "/app/nested%5cpart.mjs",
    ])
      expect((await fetch(f.url + base + path)).status).toBe(404);
    expect((await fetch(f.url + grant.src, { method: "POST" })).status).toBe(405);
    const unknown = await fetch(f.url + "/api/v1/panel-assets/unknown/app/index.html");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toBe("fallback");
  });
});

type RuntimeFixture = Awaited<ReturnType<typeof fixture>>;
type RuntimeEvent = { id: number; event: string; payload: Record<string, unknown> };

async function runtimeEvents(f: RuntimeFixture, instance: string, after = 0) {
  const response = await f.api(`${instance}/events?after=${after}`, "GET");
  expect(response.status).toBe(200);
  return response.json() as Promise<{ events: RuntimeEvent[]; cursor: number }>;
}

async function waitRuntimeEvent(f: RuntimeFixture, instance: string, name: string, after = 0) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const batch = await runtimeEvents(f, instance, after);
    const event = batch.events.find((item) => item.event === name);
    if (event) return event;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`Panel runtime did not emit ${name}`);
}

async function nodeProcessFixture() {
  const f = await fixture({ permissions: ["context.workspace", "process"] });
  const node = await resolvePanelExecutable("node");
  if (!node) throw new Error("Node.js is required for the server process integration test");
  const bin = join(f.root, "data", "panel-bin");
  await mkdir(bin, { recursive: true });
  await symlink(node, join(bin, "fixture-node"));
  const grant = await f.prepare();
  const call = async (method: string, params?: unknown) => {
    const response = await f.api(`${grant.instanceId}/call`, "POST", { method, params });
    expect(response.status).toBe(200);
    return response.json();
  };
  const executable = await call("process.find", { name: "fixture-node" });
  expect(executable.available).toBe(true);
  const directory = await call("filesystem.getKnownDirectory", { name: "downloads" });
  const params = {
    executableHandle: executable.handle,
    directoryHandle: directory.handle,
    args: [
      "-e",
      'require("node:fs").writeFileSync("process-result.txt", "completed"); process.stdout.write("panel node " + process.versions.node); process.stderr.write("stderr delivered");',
    ],
  };
  return { ...f, grant, params, directory, call };
}

describe("Panel HTTP host operations", () => {
  test("renew preserves assets and instance, rejects other owners, and cannot revive expiry", async () => {
    const f = await fixture();
    const grant = await f.prepare();
    f.state.now += 60_000;
    expect((await f.api(`${grant.instanceId}/renew`, "POST", {}, "owner-b")).status).toBe(403);
    expect(
      (await f.api(`${grant.instanceId}/renew`, "POST", { expiresAt: Number.MAX_SAFE_INTEGER }))
        .status,
    ).toBe(400);
    const renewal = await f.api(`${grant.instanceId}/renew`, "POST", {});
    expect(renewal.status).toBe(200);
    const result = await renewal.json();
    expect(result.expiresAt).toBe(grant.expiresAt + 60_000);
    expect(Object.keys(result)).toEqual(["expiresAt"]);
    expect((await fetch(f.url + grant.src)).status).toBe(200);
    expect(
      (await f.api(`${grant.instanceId}/call`, "POST", { method: "context.get" })).status,
    ).toBe(200);
    f.state.now = result.expiresAt;
    expect((await f.api(`${grant.instanceId}/renew`, "POST", {})).status).toBe(410);
    f.state.now = 1000;
    expect((await f.api(`${grant.instanceId}/renew`, "POST", {})).status).toBe(410);
    expect((await fetch(f.url + grant.src)).status).toBe(404);
  });

  test("renew rechecks expiry after awaited snapshot validation", async () => {
    const f = await fixture();
    const grant = await f.prepare();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    f.state.beforeSnapshot = async () => {
      entered();
      await blocked;
    };
    const renewal = f.api(`${grant.instanceId}/renew`, "POST", {});
    await ready;
    f.state.now = grant.expiresAt;
    release();
    expect((await renewal).status).toBe(410);
    f.state.now = 1000;
    expect((await f.api(`${grant.instanceId}/renew`, "POST", {})).status).toBe(410);
  });

  test("runs real Node only after an owner confirmation and delivers output with acknowledged events", async () => {
    const f = await nodeProcessFixture();
    expect(f.grant.context.availableMethods).toContain("process.spawn");
    expect(f.grant.context.availableMethods).not.toContain("agent.task.start");
    const pending = f.api(`${f.grant.instanceId}/call`, "POST", {
      method: "process.spawn",
      params: f.params,
    });
    const confirmation = await waitRuntimeEvent(f, f.grant.instanceId, "host.confirm");
    expect(
      await readFile(join(f.directory.path, "process-result.txt"), "utf8").catch(() => ""),
    ).toBe("");
    expect((await f.api(`${f.grant.instanceId}/events`, "GET", undefined, "owner-b")).status).toBe(
      403,
    );
    expect(
      (
        await f.api(
          `${f.grant.instanceId}/confirm`,
          "POST",
          { requestId: confirmation.payload.requestId, allowed: true },
          "owner-b",
        )
      ).status,
    ).toBe(403);
    const confirmed = await f.api(`${f.grant.instanceId}/confirm`, "POST", {
      requestId: confirmation.payload.requestId,
      allowed: true,
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ accepted: true, allowed: true });
    const started = await pending;
    expect(started.status).toBe(200);
    const process = await started.json();
    const exited = await waitRuntimeEvent(f, f.grant.instanceId, "process.exit");
    expect(exited.payload).toMatchObject({ processId: process.processId, code: 0 });
    const batch = await runtimeEvents(f, f.grant.instanceId);
    expect(
      batch.events
        .filter((item) => item.event === "process.output")
        .map((item) => item.payload.text)
        .join(""),
    ).toContain("panel node");
    expect(
      batch.events
        .filter((item) => item.event === "process.output")
        .map((item) => item.payload.text)
        .join(""),
    ).toContain("stderr delivered");
    expect(await readFile(join(f.directory.path, "process-result.txt"), "utf8")).toBe("completed");
    expect((await runtimeEvents(f, f.grant.instanceId, batch.cursor)).events).toEqual([]);
    expect(
      (await f.api(`${f.grant.instanceId}/events?after=${batch.cursor + 1}`, "GET")).status,
    ).toBe(400);
    const duplicate = await f.api(`${f.grant.instanceId}/confirm`, "POST", {
      requestId: confirmation.payload.requestId,
      allowed: false,
    });
    expect(await duplicate.json()).toEqual({ accepted: true, allowed: true });
  });

  test("owner revoke while process approval is pending cannot start or confirm the old process", async () => {
    const f = await nodeProcessFixture();
    const pending = f.api(`${f.grant.instanceId}/call`, "POST", {
      method: "process.spawn",
      params: f.params,
    });
    const confirmation = await waitRuntimeEvent(f, f.grant.instanceId, "host.confirm");
    f.runtime.cancelOwner("owner-a");
    expect((await pending).status).toBe(410);
    expect(
      (
        await f.api(`${f.grant.instanceId}/confirm`, "POST", {
          requestId: confirmation.payload.requestId,
          allowed: true,
        })
      ).status,
    ).toBe(410);
    expect(
      await readFile(join(f.directory.path, "process-result.txt"), "utf8").catch(() => ""),
    ).toBe("");
    const reopened = await f.prepare();
    expect(
      (
        await f.api(`${reopened.instanceId}/call`, "POST", {
          method: "process.spawn",
          params: f.params,
        })
      ).status,
    ).toBe(400);
  });

  test("agent tasks require a parent confirmation and retain their exact owner and bundled skills", async () => {
    const calls: Array<{ scope: PanelTaskScope; method: string; params: unknown }> = [];
    const revoked: string[] = [];
    const f = await fixture({
      permissions: ["context.workspace", "agent.task"],
      agentTasks: {
        async call(scope, method, params) {
          calls.push({ scope, method, params });
          const task = { id: "task-fixture", status: "running" };
          scope.emit("agent.task.changed", task);
          return task;
        },
        revokeInstance: (id) => {
          revoked.push(id);
        },
        close() {},
      },
    });
    f.app.agent!.skills = ["agent/skills/research/SKILL.md"];
    const grant = await f.prepare();
    expect(grant.context.apiVersion).toBe(9);
    expect(grant.context.availableMethods).toContain("agent.task.start");
    const input = {
      method: "agent.task.start",
      params: { prompt: "Summarize the fixture", label: "Summary" },
    };
    const pending = f.api(`${grant.instanceId}/call`, "POST", input);
    const confirmation = await waitRuntimeEvent(f, grant.instanceId, "host.confirm");
    expect(calls).toHaveLength(0);
    expect(
      (
        await f.api(`${grant.instanceId}/confirm`, "POST", {
          requestId: confirmation.payload.requestId,
          allowed: true,
        })
      ).status,
    ).toBe(200);
    expect((await pending).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.scope).toMatchObject({
      instanceId: grant.instanceId,
      ownerId: "owner-a",
      appId: f.app.id,
      cwd: f.cwd,
      projectPath: f.cwd,
      availableSkills: [`${f.app.id}:research`],
    });
    expect(calls[0]!.params).toEqual(input.params);
    expect((await waitRuntimeEvent(f, grant.instanceId, "agent.task.changed")).payload).toEqual({
      id: "task-fixture",
      status: "running",
    });
    const denied = f.api(`${grant.instanceId}/call`, "POST", input);
    const second = await waitRuntimeEvent(f, grant.instanceId, "host.confirm", confirmation.id);
    await f.api(`${grant.instanceId}/confirm`, "POST", {
      requestId: second.payload.requestId,
      allowed: false,
    });
    expect((await denied).status).toBe(403);
    expect(calls).toHaveLength(1);
    f.runtime.cancelOwner("owner-a");
    expect(revoked).toContain(grant.instanceId);
    expect(await calls[0]!.scope.isAuthorized()).toBe(false);
  });

  test("routes panel tools only when declared and registered, and binds results to the owner", async () => {
    let hooks!: Parameters<NonNullable<PanelRuntimeOptions["createAgentTasks"]>>[0];
    let scope!: PanelTaskScope;
    const f = await fixture({
      permissions: ["context.workspace", "agent.task"],
      createAgentTasks(input) {
        hooks = input;
        return {
          async call(inputScope) {
            scope = inputScope;
            return [];
          },
          revokeInstance() {},
          close() {},
        };
      },
    });
    const grant = await f.prepare();
    await f.api(`${grant.instanceId}/call`, "POST", { method: "agent.task.list" });
    const panelId = `panel-app:${f.app.id}`;
    const action = (input: Record<string, unknown>) =>
      hooks.onPanelAction(scope, input) as Promise<Record<string, any>>;
    expect(await action({ action: "tools", panelId })).toEqual({ ok: true, tools: [] });
    expect(
      (await action({ action: "invoke", panelId, toolName: "read_panel", arguments: {} })).ok,
    ).toBe(false);
    expect((await action({ action: "open", panelId: "panel-app:another" })).ok).toBe(false);
    expect(
      (
        await f.api(`${grant.instanceId}/call`, "POST", {
          method: "tools.register",
          params: { name: "undeclared" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.api(`${grant.instanceId}/call`, "POST", {
          method: "tools.register",
          params: { name: "read_panel" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await action({ action: "tools", panelId })).tools.map((tool: any) => tool.name),
    ).toEqual(["read_panel"]);
    const pending = action({ action: "invoke", panelId, toolName: "read_panel", arguments: {} });
    const invocation = await waitRuntimeEvent(f, grant.instanceId, "tools.invoke");
    expect(invocation.payload).toMatchObject({ toolName: "read_panel", args: {} });
    const reply = { requestId: invocation.payload.requestId, result: { saved: true } };
    expect((await f.api(`${grant.instanceId}/tool-results`, "POST", reply, "owner-b")).status).toBe(
      403,
    );
    expect((await f.api(`${grant.instanceId}/tool-results`, "POST", reply)).status).toBe(200);
    expect(await pending).toMatchObject({
      ok: true,
      panelId,
      toolName: "read_panel",
      result: { saved: true },
    });
    expect((await f.api(`${grant.instanceId}/tool-results`, "POST", reply)).status).toBe(400);
    await f.api(`${grant.instanceId}/call`, "POST", {
      method: "tools.unregister",
      params: { name: "read_panel" },
    });
    expect(await action({ action: "tools", panelId })).toEqual({ ok: true, tools: [] });
  });

  test("rejects invalid tool arguments before dispatch and settles pending callbacks on revoke", async () => {
    let hooks!: Parameters<NonNullable<PanelRuntimeOptions["createAgentTasks"]>>[0];
    let scope!: PanelTaskScope;
    const f = await fixture({
      permissions: ["agent.task"],
      createAgentTasks(input) {
        hooks = input;
        return {
          async call(inputScope) {
            scope = inputScope;
            return [];
          },
          revokeInstance() {},
          close() {},
        };
      },
    });
    f.app.agent!.tools[0]!.inputSchema = {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    };
    const grant = await f.prepare();
    await f.api(`${grant.instanceId}/call`, "POST", { method: "agent.task.list" });
    await f.api(`${grant.instanceId}/call`, "POST", {
      method: "tools.register",
      params: { name: "read_panel" },
    });
    const invoke = (args: unknown) =>
      hooks.onPanelAction(scope, {
        action: "invoke",
        panelId: `panel-app:${f.app.id}`,
        toolName: "read_panel",
        arguments: args,
      }) as Promise<Record<string, unknown>>;
    const rejected = await Promise.race([
      invoke({ value: "invalid" }),
      new Promise<null>((done) => setTimeout(() => done(null), 500)),
    ]);
    expect(rejected?.ok).toBe(false);
    expect((await runtimeEvents(f, grant.instanceId)).events).toEqual([]);
    const pending = invoke({ value: 1 });
    await waitRuntimeEvent(f, grant.instanceId, "tools.invoke");
    f.runtime.cancelOwner("owner-a");
    expect((await pending).ok).toBe(false);
    expect(await hooks.onPanelAction(scope, { action: "list" })).toMatchObject({ ok: false });
  });
});

test("main conversation Panel actions select only that login owner and session", async () => {
  const f = await fixture();
  const first = await f.prepare("owner-a", { sessionId: "session-first" });
  const otherOwner = await f.prepare("owner-b", { sessionId: "session-first" });
  const otherSession = await f.prepare("owner-a", { sessionId: "session-second" });
  const panelId = `panel-app:${f.app.id}`;
  await f.api(`${first.instanceId}/call`, "POST", {
    method: "tools.register",
    params: { name: "read_panel" },
  });
  expect(await f.runtime.panelAction("owner-a", "session-first", { action: "list" })).toMatchObject(
    {
      ok: true,
      panels: [{ id: panelId }],
    },
  );
  expect(await f.runtime.panelAction("owner-a", "session-absent", { action: "list" })).toEqual({
    ok: true,
    panels: [],
  });
  expect(
    await f.runtime.panelAction("owner-b", "session-first", { action: "tools", panelId }),
  ).toEqual({ ok: true, tools: [] });
  expect(
    await f.runtime.panelAction("owner-a", "session-second", { action: "tools", panelId }),
  ).toEqual({ ok: true, tools: [] });
  const pending = f.runtime.panelAction("owner-a", "session-first", {
    action: "invoke",
    panelId,
    toolName: "read_panel",
    arguments: {},
  });
  const event = await waitRuntimeEvent(f, first.instanceId, "tools.invoke");
  expect((await runtimeEvents(f, otherSession.instanceId)).events).toEqual([]);
  const reply = { requestId: event.payload.requestId, result: { scope: "first" } };
  expect((await f.api(`${otherSession.instanceId}/tool-results`, "POST", reply)).status).toBe(400);
  expect(
    (await f.api(`${otherOwner.instanceId}/tool-results`, "POST", reply, "owner-b")).status,
  ).toBe(400);
  expect((await f.api(`${first.instanceId}/tool-results`, "POST", reply)).status).toBe(200);
  expect(await pending).toMatchObject({ ok: true, result: { scope: "first" } });
  await f.api(first.instanceId, "DELETE");
  expect(await f.runtime.panelAction("owner-a", "session-first", { action: "list" })).toEqual({
    ok: true,
    panels: [],
  });
});

test("filesystem.openDirectory returns an authenticated browser URL that downloads its granted files", async () => {
  const f = await nodeProcessFixture();
  const bytes = Buffer.alloc(20 * 1024, 0x62);
  await writeFile(join(f.directory.path, "下载结果.mp4"), bytes);
  const effect = await f.call("filesystem.openDirectory", { handle: f.directory.handle });
  expect(effect).toMatchObject({ effect: "filesystem.openDirectory", opened: false });
  expect(effect.url).toMatch(
    /^\/api\/v1\/panels\/runtime\/[A-Za-z0-9_-]+\/directory\/[A-Za-z0-9_-]+$/,
  );
  const relative = effect.url.slice("/api/v1/panels/runtime/".length);
  const listing = await f.api(relative + "?workspace=" + encodeURIComponent(f.cwd), "GET");
  expect(listing.status).toBe(200);
  const html = await listing.text();
  expect(html).toContain("下载结果.mp4");
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  expect(href).toBeDefined();
  expect(new URL(href!, f.url).searchParams.get("workspace")).toBe(f.cwd);
  const downloadPath = href!.slice("/api/v1/panels/runtime/".length);
  expect((await f.api(downloadPath, "GET", undefined, "owner-b")).status).toBe(403);
  const download = await f.api(downloadPath, "GET");
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  const head = await f.api(downloadPath, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(bytes.length));
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  expect(
    (await f.api(relative + "?workspace=" + encodeURIComponent(f.cwd + "-other"), "GET")).status,
  ).toBe(400);
  f.runtime.cancelOwner("owner-a");
  expect((await f.api(downloadPath, "GET")).status).toBe(410);
});
