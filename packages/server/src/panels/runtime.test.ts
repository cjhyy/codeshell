import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { CredentialStore, type InstalledPanelApp } from "@cjhyy/code-shell-core";
import {
  createPanelRuntime,
  panelWebCompatibility,
  type PanelRuntimeOptions,
  type PanelTaskHost,
  type PanelTaskScope,
} from "./runtime.js";
import { PanelToolJobService, type ToolJobScope } from "./tool-jobs.js";
import { createSharedPanelToolHost, type SharedPanelToolHost } from "./shared-tool-jobs.js";
import { resolvePanelExecutable } from "./process-service.js";
import { PanelResourceService } from "./resources/service.js";
import { PanelTaskCookieHost } from "./task-cookie-host.js";
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
    publicPathPrefix?: string;
    agentTasks?: PanelTaskHost;
    authorizePanelDirectory?: PanelRuntimeOptions["authorizePanelDirectory"];
    createAgentTasks?: PanelRuntimeOptions["createAgentTasks"];
    sharedToolJobs?: (input: {
      root: string;
      cwd: string;
      app: InstalledPanelApp;
    }) => SharedPanelToolHost;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeshell-panel-http-")));
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
    host: options.sharedToolJobs ? "desktop" : "hub",
    sharedToolJobs: options.sharedToolJobs?.({ root, cwd, app }),
    publicPathPrefix: options.publicPathPrefix,
    agentTasks: options.agentTasks,
    authorizePanelDirectory: options.authorizePanelDirectory,
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
    await runtime.close();
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
  test("Web capabilities disclose actual confirmation and result limits and mask native hand-offs", async () => {
    const f = await fixture({
      permissions: ["context.workspace", "resources", "credentials.connections"],
    });
    const grant = await f.prepare();
    const context = grant.context as any;
    expect(context.capabilities.bridge).toMatchObject({
      consentTimeoutMs: 50000,
      callTimeoutMs: 60000,
      maxResultBytes: 3 * 1024 * 1024,
    });
    expect(context.capabilities.resources).toMatchObject({ materialize: false, capture: false });
    expect(context.capabilities.process).toBeUndefined();
    expect(context.capabilities.tasks).toBeUndefined();
    expect(context.availableMethods).toContain("resources.read");
    expect(context.availableMethods).toContain("resources.references.get");
    expect(context.availableMethods).toContain("resources.references.forget");
    expect(context.availableMethods).toContain("credentials.connections.list");
    for (const method of [
      "resources.materialize",
      "resources.capture",
      "resources.references.create",
      "resources.references.relink",
      "resources.references.pick",
      "credentials.connections.authorizeProcess",
      "tasks.start",
    ]) {
      expect(context.availableMethods).not.toContain(method);
    }
    const denied = await f.api(`${grant.instanceId}/call`, "POST", {
      method: "resources.capture",
      params: { directoryHandle: "not-granted", path: "result.txt" },
    });
    expect(denied.status).toBe(403);
    for (const method of ["resources.references.create", "resources.references.relink"]) {
      const result = await f.api(`${grant.instanceId}/call`, "POST", { method, params: {} });
      expect(result.status).toBe(403);
    }
  });

  test("Web rejects an oversized Host result with a bounded structured error", async () => {
    let responseValue: unknown = { models: [] };
    const f = await fixture({
      permissions: ["context.workspace", "agent.task"],
      agentTasks: {
        async call() {
          return responseValue;
        },
        revokeInstance() {},
        close() {},
      },
    });
    const grant = await f.prepare();
    const call = () =>
      f.api(`${grant.instanceId}/call`, "POST", { method: "agent.task.models", params: {} });
    const small = await call();
    expect(small.status).toBe(200);
    expect(await small.json()).toEqual({ models: [] });
    responseValue = { models: ["x".repeat(3 * 1024 * 1024)] };
    const oversized = await call();
    expect(oversized.status).toBe(400);
    const text = await oversized.text();
    expect(text.length).toBeLessThan(1024);
    expect(JSON.parse(text)).toMatchObject({ code: "RESULT_TOO_LARGE" });
  });

  test("Web shutdown awaits resource cleanup before resolving", async () => {
    const f = await fixture({ permissions: ["context.workspace", "resources"] });
    await f.prepare();
    const original = PanelResourceService.prototype.shutdown;
    let release!: () => void;
    let entered!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanupStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const shutdown = spyOn(PanelResourceService.prototype, "shutdown").mockImplementation(
      async function (this: PanelResourceService) {
        await original.call(this);
        entered();
        await cleanupGate;
      },
    );
    let resolved = false;
    const closing = f.runtime.close().then(() => {
      resolved = true;
    });
    try {
      await cleanupStarted;
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);
      release();
      await closing;
      expect(resolved).toBe(true);
    } finally {
      release();
      await closing;
      shutdown.mockRestore();
    }
  });

  test("project asset bridge and CSP use the public prefix while prepare stays relative", async () => {
    const publicPathPrefix = "/p/7bc54c17-1af8-4105-87c1-f4e5c6638998";
    const f = await fixture({ publicPathPrefix });
    const grant = await f.prepare();
    expect(grant.src.startsWith("/api/v1/panel-assets/")).toBe(true);
    const response = await fetch(f.url + grant.src, { headers: { Origin: "null" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`src="${publicPathPrefix}/api/v1/panel-assets/`);
    expect(response.headers.get("content-security-policy")).toContain(
      `script-src ${f.url}${publicPathPrefix}/api/v1/panel-assets/`,
    );
  });
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
      let taskChanged: unknown;
      const stopTasks = window.codeshellPanel.on("tasks.changed", (value: unknown) => {
        taskChanged = value;
      });
      handlers.get("message")!({
        source: parent,
        origin: f.url,
        data: {
          type: "codeshell-panel:event",
          instanceId: grant.instanceId,
          event: "tasks.changed",
          payload: { id: "tool-job" },
        },
      });
      expect(taskChanged).toEqual({ id: "tool-job" });
      stopTasks();
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

  test("two HTTP Panel instances detect conflicting project saves", async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([f.prepare(), f.prepare()]);
    const call = async (grant: typeof one, method: string, params: unknown) => {
      const response = await f.api(`${grant.instanceId}/call`, "POST", { method, params });
      expect(response.status).toBe(200);
      return response.json();
    };
    for (const grant of [one, two]) {
      const context = await call(grant, "context.get", {});
      expect(context.availableMethods).toContain("storage.getSnapshot");
      expect(context.availableMethods).toContain("storage.compareAndSet");
      expect(await call(grant, "storage.getSnapshot", { key: "draft" })).toEqual({
        exists: false,
        value: null,
        revision: null,
      });
    }
    const desktop = await call(one, "storage.compareAndSet", {
      key: "draft",
      value: { source: "desktop" },
      expectedRevision: null,
    });
    expect(desktop.updated).toBe(true);
    expect(
      await call(two, "storage.compareAndSet", {
        key: "draft",
        value: { source: "phone" },
        expectedRevision: null,
      }),
    ).toEqual({ updated: false, snapshot: desktop.snapshot });
    expect(
      await call(two, "storage.compareAndSet", {
        key: "draft",
        value: { source: "merged" },
        expectedRevision: desktop.snapshot.revision,
      }),
    ).toMatchObject({ updated: true, snapshot: { value: { source: "merged" } } });
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

async function runtimeEvents(f: RuntimeFixture, instance: string, after = 0, owner = "owner-a") {
  const response = await f.api(`${instance}/events?after=${after}`, "GET", undefined, owner);
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

async function nativeToolFixture(
  source: string,
  sharedToolJobs?: NonNullable<Parameters<typeof fixture>[0]>["sharedToolJobs"],
  cookies = false,
) {
  const f = await fixture({
    permissions: [
      "context.workspace",
      "process",
      "resources",
      ...(cookies ? ["credentials.cookies" as const] : []),
    ],
    sharedToolJobs,
  });
  const entry = "app/tools/sample.mjs";
  await mkdir(join(f.installPath, "app", "tools"), { recursive: true });
  await writeFile(join(f.installPath, entry), source);
  f.app.nativeEntries = {
    sample: { entry, sha256: createHash("sha256").update(source).digest("hex") },
  };
  const grant = await f.prepare();
  const call = (method: string, params?: unknown, instance = grant.instanceId, owner = "owner-a") =>
    f.api(`${instance}/call`, "POST", { method, params }, owner);
  const start = async (requestKey?: string) => {
    const pending = call("tasks.start", {
      entry: "sample",
      input: { request: { value: "fixture" } },
      recovery: "retry",
      requestKey,
    });
    const confirmation = await waitRuntimeEvent(f, grant.instanceId, "host.confirm");
    expect(
      (
        await f.api(`${grant.instanceId}/confirm`, "POST", {
          requestId: confirmation.payload.requestId,
          allowed: true,
        })
      ).status,
    ).toBe(200);
    const response = await pending;
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ...f, grant, call, start };
}

describe("Panel HTTP host operations", () => {
  async function cookieFixture(delay = 0) {
    const f = await nativeToolFixture(
      `import {readFile} from "node:fs/promises";
let text="";for await(const chunk of process.stdin) text+=chunk;
const request=JSON.parse(text), index=process.argv.findIndex(arg=>arg==="--cookies-file"||arg==="--cookies"), path=process.argv[index+1];
const content=await readFile(path,"utf8");
if(!content.includes("runtime-fixture-cookie")) process.exit(3);
console.log(JSON.stringify({type:"progress",progress:{message:"cookie-read",fraction:0.5}}));
setTimeout(()=>console.log(JSON.stringify({type:"result",result:{ok:true,value:request.value}})),${delay});`,
      undefined,
      true,
    );
    const store = new CredentialStore(f.cwd);
    const saved = {
      id: "cookie-fixture",
      type: "cookie" as const,
      label: "Test saved login",
      meta: { domain: "example.com" },
      secret: JSON.stringify([
        { domain: ".example.com", name: "session", value: "runtime-fixture-cookie" },
      ]),
    };
    store.save("project", saved);
    const accounts = await (
      await f.call("credentials.cookies.listForTask", { url: "https://example.com/watch" })
    ).json();
    const input = {
      entry: "sample",
      recovery: "retry",
      input: {
        request: { value: "fixture" },
        cookieArgument: {
          argumentName: "--cookies-file",
          credentialId: saved.id,
          url: "https://example.com/watch",
          revision: accounts.accounts[0].revision,
        },
      },
    };
    let cursor = 0;
    async function consent(pending: Promise<Response>, allowed: boolean, during?: () => void) {
      const event = await waitRuntimeEvent(f, f.grant.instanceId, "host.confirm", cursor);
      cursor = event.id;
      expect(JSON.stringify(event.payload)).toContain("Test saved login");
      expect(JSON.stringify(event.payload)).toContain("example.com");
      expect(JSON.stringify(event.payload)).not.toContain("runtime-fixture-cookie");
      during?.();
      await f.api(`${f.grant.instanceId}/confirm`, "POST", {
        requestId: event.payload.requestId,
        allowed,
      });
      return pending;
    }
    async function status(id: string, wanted: string) {
      let current: any;
      for (let i = 0; i < 100; i++) {
        current = await (await f.call("tasks.get", { id })).json();
        if (current.status === wanted) return current;
        await Bun.sleep(20);
      }
      throw new Error(`Cookie task expected ${wanted}, received ${current?.status}`);
    }
    return { ...f, store, saved, input, consent, status };
  }
  async function processCookieFixture(delay = 0) {
    const f = await cookieFixture(delay);
    const read = async (method: string, params: unknown) => {
      const response = await f.call(method, params);
      expect(response.status).toBe(200);
      return response.json();
    };
    const executable = await read("process.find", { name: "node" });
    const entry = await read("process.resolveEntry", {
      name: "sample",
      executableHandle: executable.handle,
    });
    const directory = await read("filesystem.getKnownDirectory", { name: "project" });
    const { argumentName: _argument, ...selection } = f.input.input.cookieArgument;
    return {
      ...f,
      read,
      selection,
      executable,
      params: {
        executableHandle: executable.handle,
        entryHandle: entry.handle,
        directoryHandle: directory.handle,
        args: [],
        stdin: "pipe",
      },
    };
  }

  test("Web grants only an opaque account file to a temporary process after consent", async () => {
    const f = await processCookieFixture();
    expect(f.grant.context.availableMethods).toContain("credentials.cookies.authorizeProcess");
    expect((f.grant.context as any).capabilities.process.cookieCredentials).toBe(true);
    const request = { ...f.selection, executableHandle: f.executable.handle };
    const denied = await f.consent(f.call("credentials.cookies.authorizeProcess", request), false);
    expect(await denied.json()).toEqual({ authorized: false, cancelled: true });
    const accepted = await f.consent(f.call("credentials.cookies.authorizeProcess", request), true);
    const authorization = await accepted.json();
    expect(authorization.authorized).toBe(true);
    expect(Object.keys(authorization).sort()).toEqual([
      "authorized",
      "count",
      "fileArgumentHandle",
    ]);
    const events = await runtimeEvents(f, f.grant.instanceId);
    const pending = f.call("process.spawn", {
      ...f.params,
      fileArgumentHandles: [authorization.fileArgumentHandle],
    });
    const event = await waitRuntimeEvent(
      f,
      f.grant.instanceId,
      "host.confirm",
      events.events.filter((item) => item.event === "host.confirm").at(-1)!.id,
    );
    await f.api(`${f.grant.instanceId}/confirm`, "POST", {
      requestId: event.payload.requestId,
      allowed: true,
    });
    const response = await pending;
    expect(response.status).toBe(200);
    const started = await response.json();
    await f.read("process.write", {
      processId: started.processId,
      text: JSON.stringify({ value: "metadata" }),
    });
    await f.read("process.end", { processId: started.processId });
    const exited = await waitRuntimeEvent(f, f.grant.instanceId, "process.exit");
    expect(exited.payload.code).toBe(0);
    const output = JSON.stringify((await runtimeEvents(f, f.grant.instanceId)).events);
    expect(output).toContain("metadata");
    expect(output).not.toContain("runtime-fixture-cookie");
    await f.api(f.grant.instanceId, "DELETE");
    for (let i = 0; i < 50; i++) {
      const files = (await readdir(join(f.root, "data", "panel-task-cookies"))).filter((name) =>
        name.startsWith("cookies-"),
      );
      if (!files.length) return;
      await Bun.sleep(10);
    }
    throw new Error("temporary account file was not cleaned after page closure");
  });

  test("Web rejects account changes during temporary-process consent without creating a file", async () => {
    const f = await processCookieFixture();
    const response = await f.consent(
      f.call("credentials.cookies.authorizeProcess", {
        ...f.selection,
        executableHandle: f.executable.handle,
      }),
      true,
      () => {
        f.store.save("project", { ...f.saved, label: "Changed account" });
      },
    );
    expect(response.status).toBe(400);
    expect(
      (await readdir(join(f.root, "data", "panel-task-cookies"))).filter((name) =>
        name.startsWith("cookies-"),
      ),
    ).toEqual([]);
  });

  test("logout while a temporary account file is being prepared prevents its grant and cleans the file", async () => {
    const f = await processCookieFixture();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = PanelTaskCookieHost.prototype.materialize;
    const mocked = spyOn(PanelTaskCookieHost.prototype, "materialize").mockImplementation(
      async function (scope, selection) {
        const lease = await original.call(this, scope, selection);
        entered();
        await waiting;
        return lease;
      },
    );
    const pending = f.consent(
      f.call("credentials.cookies.authorizeProcess", {
        ...f.selection,
        executableHandle: f.executable.handle,
      }),
      true,
    );
    try {
      await ready;
      f.runtime.cancelOwner("owner-a");
      release();
      const response = await pending;
      expect(response.status).toBe(410);
      expect(await response.text()).not.toContain("fileArgumentHandle");
      expect(
        (await readdir(join(f.root, "data", "panel-task-cookies"))).filter((name) =>
          name.startsWith("cookies-"),
        ),
      ).toEqual([]);
    } finally {
      release();
      await pending;
      mocked.mockRestore();
    }
  });

  test("Web selected-account consent gates real native Cookie use and keeps secrets out of task records", async () => {
    const f = await cookieFixture();
    expect((f.grant.context as any).capabilities.tasks.cookieCredentials).toBe(true);
    expect(f.grant.context.availableMethods).toContain("credentials.cookies.listForTask");
    const denied = await f.consent(f.call("tasks.start", f.input), false);
    expect(denied.status).toBe(403);
    expect(await (await f.call("tasks.list", {})).json()).toEqual([]);
    const response = await f.consent(f.call("tasks.start", f.input), true);
    expect(response.status).toBe(200);
    const job = await response.json();
    const done = await f.status(job.id, "succeeded");
    expect(done.result).toEqual({ ok: true, value: "fixture" });
    expect(JSON.stringify(done)).not.toContain("runtime-fixture-cookie");
    expect(
      (await readdir(join(f.root, "data", "panel-task-cookies"))).filter((name) =>
        name.startsWith("cookies-"),
      ),
    ).toEqual([]);
  });
  test("Web rechecks account replacement during consent before admitting the task", async () => {
    const f = await cookieFixture();
    const response = await f.consent(f.call("tasks.start", f.input), true, () => {
      f.store.save("project", { ...f.saved, label: "Replacement account" });
    });
    expect(response.status).toBe(400);
    expect(await (await f.call("tasks.list", {})).json()).toEqual([]);
  });
  test("logout during the post-consent Cookie lookup cannot admit a new task", async () => {
    const f = await cookieFixture();
    const observer = await f.prepare("owner-b");
    let release!: () => void,
      entered!: () => void,
      checks = 0;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = PanelTaskCookieHost.prototype.check;
    const mocked = spyOn(PanelTaskCookieHost.prototype, "check").mockImplementation(
      async function (scope, selection) {
        const result = await original.call(this, scope, selection);
        if (++checks === 2) {
          entered();
          await waiting;
        }
        return result;
      },
    );
    const pending = f.consent(f.call("tasks.start", f.input), true);
    try {
      await ready;
      f.runtime.cancelOwner("owner-a");
      release();
      expect((await pending).status).toBe(410);
      expect(await (await f.call("tasks.list", {}, observer.instanceId, "owner-b")).json()).toEqual(
        [],
      );
    } finally {
      release();
      await pending;
      mocked.mockRestore();
    }
  });
  test("Web retry asks for the same saved account again, denial preserves cancellation and acceptance retains the task ID", async () => {
    const f = await cookieFixture(500);
    const response = await f.consent(f.call("tasks.start", f.input), true);
    const job = await response.json();
    await waitRuntimeEvent(f, f.grant.instanceId, "tasks.changed");
    expect((await f.call("tasks.cancel", { id: job.id })).status).toBe(200);
    await f.status(job.id, "cancelled");
    expect((await f.consent(f.call("tasks.retry", { id: job.id }), false)).status).toBe(403);
    await f.status(job.id, "cancelled");
    const retry = await f.consent(f.call("tasks.retry", { id: job.id }), true);
    expect((await retry.json()).id).toBe(job.id);
    expect((await f.status(job.id, "succeeded")).result.ok).toBe(true);
  });
  test("logout aborts input preparation before a native job can be published or run", async () => {
    const f = await nativeToolFixture("process.stdin.resume();");
    await f.prepare("owner-b");
    let entered!: () => void;
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = PanelResourceService.prototype.dispatch;
    const mocked = spyOn(PanelResourceService.prototype, "dispatch").mockImplementation(
      async function (...args: Parameters<typeof original>) {
        if (args[1] === "resources.materialize") {
          signal = args[3]?.signal;
          entered();
          await blocked;
          signal?.throwIfAborted();
          return {};
        }
        return original.apply(this, args);
      },
    );
    const pending = f.call("tasks.start", {
      entry: "sample",
      input: {
        request: {},
        resources: [{ assetId: "asset-" + "a".repeat(64), path: "input.txt" }],
      },
    });
    try {
      const confirmation = await waitRuntimeEvent(f, f.grant.instanceId, "host.confirm");
      await f.api(`${f.grant.instanceId}/confirm`, "POST", {
        requestId: confirmation.payload.requestId,
        allowed: true,
      });
      await ready;
      f.runtime.cancelOwner("owner-b");
      expect(signal?.aborted).toBe(false);
      f.runtime.cancelOwner("owner-a");
      expect(signal?.aborted).toBe(true);
      release();
      expect((await pending).status).toBe(410);
      const reopened = await f.prepare("owner-b");
      expect(await (await f.call("tasks.list", {}, reopened.instanceId, "owner-b")).json()).toEqual(
        [],
      );
      expect(f.runtime.activeTaskCount()).toBe(0);
    } finally {
      release();
      await pending;
      mocked.mockRestore();
    }
  });
  test("Web native tasks run from reviewed entries, persist across page close, and remain scoped", async () => {
    const f = await nativeToolFixture(
      'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (part) => input += part); process.stdin.on("end", () => { const request = JSON.parse(input); process.stdout.write(JSON.stringify({ type: "result", result: { value: request.value } }) + "\\n"); });',
    );
    expect((f.grant.context as any).capabilities.tasks.available).toBe(true);
    expect(f.grant.context.availableMethods).toContain("tasks.start");
    const otherOwner = await f.prepare("owner-b");
    const job = await f.start("stable-request");
    expect(typeof job.id).toBe("string");
    expect((await waitRuntimeEvent(f, f.grant.instanceId, "tasks.changed")).payload.id).toBe(
      job.id,
    );
    expect((await runtimeEvents(f, otherOwner.instanceId, 0, "owner-b")).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "tasks.changed",
          payload: expect.objectContaining({ id: job.id }),
        }),
      ]),
    );
    expect(f.runtime.activeTaskCount()).toBeGreaterThanOrEqual(0);
    expect((await f.api(f.grant.instanceId, "DELETE")).status).toBe(200);
    const reopened = await f.prepare();
    let current: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await f.call("tasks.get", { id: job.id }, reopened.instanceId);
      expect(response.status).toBe(200);
      current = await response.json();
      if (current.status === "succeeded" || current.status === "failed") break;
      await Bun.sleep(20);
    }
    expect(current).toMatchObject({ status: "succeeded", result: { value: "fixture" } });
    const list = await f.call("tasks.list", {}, reopened.instanceId);
    expect(list.status).toBe(200);
    expect((await list.json()).some((entry: { id: string }) => entry.id === job.id)).toBe(true);
    f.state.revision = "b".repeat(64);
    await f.runtime.invalidate(f.app.id);
    const next = await f.prepare();
    const previous = await f.call("tasks.get", { id: job.id }, next.instanceId);
    expect((await previous.json()).readOnly).toBe(true);
    expect((await f.call("tasks.cancel", { id: job.id }, next.instanceId)).status).toBe(400);
  });

  test("Web native task approval cannot survive session revocation", async () => {
    const f = await nativeToolFixture(
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({type:"result",result:{ok:true}})+"\\n"));',
    );
    const pending = f.call("tasks.start", {
      entry: "sample",
      input: { request: {} },
    });
    await waitRuntimeEvent(f, f.grant.instanceId, "host.confirm");
    f.runtime.cancelOwner("owner-a");
    expect((await pending).status).toBe(410);
    expect(f.runtime.activeTaskCount()).toBe(0);
  });

  test("Hub project task survives initiating login revocation and reports completion to another device", async () => {
    const f = await nativeToolFixture(
      'process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.stdout.write(JSON.stringify({type:"result",result:{ok:true}})+"\\n"), 500));',
    );
    expect((f.grant.context as any).capabilities.tasks).toMatchObject({
      ownership: "project",
      sharedAcrossDevices: true,
      continuesAfterLogout: true,
    });
    const job = await f.start();
    const observer = await f.prepare("owner-b");
    let current: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await f.call("tasks.get", { id: job.id }, observer.instanceId, "owner-b");
      current = await response.json();
      if (current.status === "running") break;
      await Bun.sleep(20);
    }
    expect(current.status).toBe("running");
    f.runtime.cancelOwner("owner-a");
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await f.call("tasks.get", { id: job.id }, observer.instanceId, "owner-b");
      current = await response.json();
      if (current.status === "succeeded") break;
      await Bun.sleep(20);
    }
    expect(current.status).toBe("succeeded");
    expect(current.result).toEqual({ ok: true });
    expect((await f.call("tasks.get", { id: job.id })).status).toBe(410);
    expect((await runtimeEvents(f, observer.instanceId, 0, "owner-b")).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "tasks.changed",
          payload: expect.objectContaining({ id: job.id, status: "succeeded" }),
        }),
      ]),
    );
  });

  test("Desktop directory authority revocation invalidates existing Web process grants", async () => {
    let trusted = true;
    const checked: string[][] = [];
    const f = await fixture({
      permissions: ["context.workspace", "process"],
      authorizePanelDirectory: async (app, project, workspace) => {
        checked.push([app.id, project, workspace]);
        if (!trusted) throw new Error("workspace trust revoked");
      },
    });
    const grant = await f.prepare();
    const call = () =>
      f.api(`${grant.instanceId}/call`, "POST", {
        method: "filesystem.getKnownDirectory",
        params: { name: "downloads" },
      });
    expect((await call()).status).toBe(200);
    expect(checked.at(-1)).toEqual([f.app.id, f.cwd, f.cwd]);
    trusted = false;
    expect((await call()).status).toBe(410);
    trusted = true;
    expect((await call()).status).toBe(410);
  });

  test("Web restores only a bookmarked server directory after reopening the Panel", async () => {
    const f = await nodeProcessFixture();
    const project = await f.call("filesystem.getKnownDirectory", { name: "project" });
    expect(project.path).toBe(f.cwd);
    const pending = f.call("filesystem.pickDirectory");
    const confirmation = await waitRuntimeEvent(f, f.grant.instanceId, "host.confirm");
    expect(
      (
        await f.api(`${f.grant.instanceId}/confirm`, "POST", {
          requestId: confirmation.payload.requestId,
          allowed: true,
        })
      ).status,
    ).toBe(200);
    const selected = await pending;
    expect(typeof selected.bookmark).toBe("string");
    expect(selected.path).toBe(f.directory.path);
    expect((await f.api(f.grant.instanceId, "DELETE")).status).toBe(200);
    const reopened = await f.prepare();
    const restored = await f.api(`${reopened.instanceId}/call`, "POST", {
      method: "filesystem.restoreDirectory",
      params: { bookmark: selected.bookmark },
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      path: selected.path,
      bookmark: selected.bookmark,
    });
    expect(
      (
        await f.api(`${reopened.instanceId}/call`, "POST", {
          method: "filesystem.restoreDirectory",
          params: { bookmark: project.handle },
        })
      ).status,
    ).toBe(400);
  });

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
    expect(grant.context.apiVersion).toBe(14);
    expect(grant.context.capabilities.bridge.structuredErrors).toBe(true);
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

describe("Desktop and Web shared native coordinator", () => {
  async function sharedFixture() {
    let service!: PanelToolJobService;
    let nativeScope!: ToolJobScope;
    let host!: SharedPanelToolHost;
    let allowNative = true;
    const executed: string[] = [];
    const f = await nativeToolFixture("process.stdin.resume();", ({ root, cwd }) => {
      nativeScope = { appId: "synthetic-panel", projectPath: cwd, revision: "native-r1" };
      service = new PanelToolJobService({
        rootDir: join(root, "data", "panel-tool-jobs"),
        isAuthorized: (scope) => allowNative && scope.revision === nativeScope.revision,
        execute: async (job, context) => {
          executed.push(job.id);
          await context.reportProgress({ stage: "waiting", fraction: 0.5 });
          await new Promise<void>((done) => {
            context.signal.addEventListener("abort", () => done(), { once: true });
            if (context.signal.aborted) done();
          });
          return {};
        },
      });
      cleanups.push(() => service.shutdown());
      host = createSharedPanelToolHost({
        service: () => service,
        resolveScope: async () => nativeScope,
      });
      return host;
    });
    return {
      ...f,
      service,
      nativeScope,
      host,
      executed,
      revokeNative: () => {
        allowNative = false;
      },
    };
  }

  test("Desktop and phone see the same task ID, receive scoped events and deduplicate submission", async () => {
    const f = await sharedFixture();
    expect((f.grant.context as any).capabilities.tasks).toMatchObject({
      ownership: "project",
      executionRevision: "native-r1",
      sharedAcrossDevices: true,
      continuesAfterLogout: true,
    });
    const native = await f.service.start(f.nativeScope, {
      entry: { name: "sample", sha256: f.app.nativeEntries!.sample!.sha256 },
      input: { request: { value: "fixture" } },
      recovery: "retry",
      requestKey: "both-devices",
    });
    const event = await waitRuntimeEvent(f, f.grant.instanceId, "tasks.changed");
    expect(event.payload.id).toBe(native.id);
    expect(event.payload.scope).toEqual(f.nativeScope);
    expect(event.payload).not.toHaveProperty("input");
    expect((await f.start("both-devices")).id).toBe(native.id);
    expect(await (await f.call("tasks.list")).json()).toMatchObject([{ id: native.id }]);
    const phone = await f.prepare("owner-b");
    const stopped = await f.call("tasks.cancel", { id: native.id }, phone.instanceId, "owner-b");
    expect(stopped.status).toBe(200);
    expect((await stopped.json()).status).toBe("cancelled");
    expect((await f.service.get(f.nativeScope, native.id)).status).toBe("cancelled");
    expect(f.executed).toEqual([native.id]);
  });

  test("logout and HTTP shutdown detach access while project tasks remain under the Desktop owner", async () => {
    const f = await sharedFixture();
    const job = await f.start("phone-start");
    const observer = await f.prepare("owner-b");
    f.state.owners.delete("owner-a");
    f.runtime.cancelOwner("owner-a");
    expect((await f.call("tasks.list")).status).toBe(401);
    expect(
      await (await f.call("tasks.get", { id: job.id }, observer.instanceId, "owner-b")).json(),
    ).toMatchObject({ id: job.id, status: "running" });
    await f.runtime.close();
    expect((await f.service.get(f.nativeScope, job.id)).status).toBe("running");
    const reopened = await f.host.bind(f.app, f.cwd);
    expect((await reopened.get(job.id)).id).toBe(job.id);
    await reopened.cancel(job.id);
    expect((await f.service.get(f.nativeScope, job.id)).status).toBe("cancelled");
  });

  test("project invalidation stops its shared work without cancelling another project's task", async () => {
    const f = await sharedFixture();
    const job = await f.start();
    const otherScope = { ...f.nativeScope, projectPath: join(f.root, "other-project") };
    const other = await f.service.start(otherScope, {
      entry: { name: "sample", sha256: f.app.nativeEntries!.sample!.sha256 },
      input: {},
      recovery: "retry",
    });
    expect(f.service.activeCount(f.cwd)).toBe(1);
    expect(f.service.activeCount(otherScope.projectPath)).toBe(1);
    await f.runtime.invalidate(f.app.id);
    expect((await f.service.get(f.nativeScope, job.id)).status).toBe("cancelled");
    expect(["running", "queued"]).toContain((await f.service.get(otherScope, other.id)).status);
    expect(f.service.activeCount(f.cwd)).toBe(0);
    await f.service.cancel(otherScope, other.id);
  });

  test("native authorization and frozen package revision remain enforced behind Web authorization", async () => {
    const f = await sharedFixture();
    const job = await f.start();
    const captured = await f.host.bind(f.app, f.cwd);
    f.nativeScope.revision = "native-r2";
    await expect(captured.get(job.id)).rejects.toThrow("authorized");
    expect((await f.call("tasks.get", { id: job.id })).status).toBe(400);
    f.revokeNative();
    expect((await f.call("tasks.list")).status).toBe(400);
    await f.host.invalidate(f.cwd);
  });

  test("old Web records remain read-only and cannot be retried through the shared coordinator", async () => {
    const f = await sharedFixture();
    const legacyScope = { appId: f.app.id, projectPath: f.cwd, revision: f.state.revision };
    const root = join(
      f.root,
      "data",
      "panel-web-tool-jobs",
      createHash("sha256").update(f.cwd).digest("hex").slice(0, 24),
    );
    const legacy = new PanelToolJobService({
      rootDir: root,
      execute: async () => ({ legacy: true }),
    });
    const job = await legacy.start(legacyScope, {
      entry: { name: "sample", sha256: f.app.nativeEntries!.sample!.sha256 },
      input: { old: true },
      recovery: "retry",
    });
    await legacy.shutdown();
    const records = await (await f.call("tasks.list")).json();
    expect(records).toMatchObject([
      { id: job.id, readOnly: true, historySource: "desktop-web-legacy" },
    ]);
    expect(await (await f.call("tasks.get", { id: job.id })).json()).toMatchObject({
      id: job.id,
      readOnly: true,
      input: { old: true },
    });
    const retry = await f.call("tasks.retry", { id: job.id });
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ code: "NOT_SUPPORTED" });
    expect((await f.call("tasks.cancel", { id: job.id })).status).toBe(400);
    expect(await f.service.list(f.nativeScope)).toEqual([]);
  });
});

async function previewFixture(bytes: string | Uint8Array = "0123456789") {
  const f = await fixture({ permissions: ["resources"] });
  const service = new PanelResourceService({
    rootDirectory: join(f.root, "data", "panel-app-media"),
    isScopeAuthorized: () => true,
  });
  cleanups.push(() => service.shutdown());
  const file = join(f.cwd, "preview.mp4");
  await writeFile(file, bytes);
  const asset = await service.library.importFile({ appId: f.app.id, projectPath: f.cwd }, file);
  const grant = await f.prepare();
  const response = await f.api(`${grant.instanceId}/call`, "POST", {
    method: "resources.open",
    params: { assetId: asset.id },
  });
  expect(response.status).toBe(200);
  const effect = await response.json();
  return { ...f, service, asset, grant, effect, file };
}

test("resource preview streams scoped bytes with seeking, HEAD, and explicit download", async () => {
  const f = await previewFixture();
  expect(f.grant.context.availableMethods).toContain("resources.open");
  expect(f.effect).toMatchObject({ effect: "resources.open", asset: f.asset });
  const read = (suffix = "", init: RequestInit = {}) =>
    fetch(f.url + f.effect.url + suffix, {
      ...init,
      headers: { Cookie: "session=owner-a", ...init.headers },
    });
  const range = await read("", { headers: { Range: "bytes=2-5" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(range.headers.get("content-type")).toBe("video/mp4");
  expect(range.headers.get("cache-control")).toContain("no-store");
  expect(await range.text()).toBe("2345");
  const head = await read("", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
  const invalid = await read("", { headers: { Range: "bytes=50-" } });
  expect(invalid.status).toBe(416);
  expect(await invalid.text()).toBe("");
  const download = await read("?download=1&workspace=" + encodeURIComponent(f.cwd));
  expect(download.headers.get("content-disposition")).toContain("attachment;");
  expect(await download.text()).toBe("0123456789");
  expect((await read("?workspace=other")).status).toBe(400);
  expect((await read("?download=1&download=1")).status).toBe(400);
  expect((await read("?path=/etc/passwd")).status).toBe(400);
  expect((await read("", { method: "POST" })).status).toBe(405);
});

test("resource URLs cannot cross owners, projects, permissions, closed grants or revoked sessions", async () => {
  const f = await previewFixture();
  const read = (owner = "owner-a") =>
    fetch(f.url + f.effect.url, { headers: { Cookie: `session=${owner}` } });
  expect((await read("owner-b")).status).toBe(403);
  const other = await f.service.library.importFile(
    { appId: f.app.id, projectPath: f.cwd + "-other" },
    f.file,
  );
  // Content IDs can be identical across projects; a project with no copy must not gain access.
  const otherFile = join(f.cwd, "private.mp4");
  await writeFile(otherFile, "other project bytes");
  const privateAsset = await f.service.library.importFile(
    { appId: f.app.id, projectPath: f.cwd + "-other" },
    otherFile,
  );
  expect(other.id).toBe(f.asset.id);
  const privateResponse = await fetch(f.url + f.effect.url.replace(f.asset.id, privateAsset.id), {
    headers: { Cookie: "session=owner-a" },
  });
  expect(privateResponse.status).toBe(404);
  expect(await privateResponse.text()).not.toContain(f.root);
  await f.api(f.grant.instanceId, "DELETE");
  expect((await read()).status).toBe(410);
  const fresh = await f.prepare();
  f.effect.url = f.effect.url.replace(f.grant.instanceId, fresh.instanceId);
  f.state.owners.delete("owner-a");
  expect((await read()).status).toBe(401);
  f.state.owners.add("owner-a");
  f.state.enabled = false;
  expect((await read()).status).toBe(410);
  const denied = await fixture({ permissions: [] });
  const deniedGrant = await denied.prepare();
  expect(deniedGrant.context.availableMethods).not.toContain("resources.open");
  expect(
    (await denied.api(`${deniedGrant.instanceId}/resources/${f.asset.id}`, "GET")).status,
  ).toBe(403);
});

test("closing one resource reader interrupts its stream even while another grant keeps the scope alive", async () => {
  const f = await previewFixture();
  const file = join(f.cwd, "large.mp4");
  await writeFile(file, Buffer.alloc(4 * 1024 * 1024, 42));
  const asset = await f.service.library.importFile({ appId: f.app.id, projectPath: f.cwd }, file);
  const otherGrant = await f.prepare();
  const original = PanelResourceService.prototype.openRead;
  const slow = spyOn(PanelResourceService.prototype, "openRead").mockImplementation(
    async function (scope, id, options) {
      const result = await original.call(this, scope, id, options);
      if (result.body) {
        const source = result.body;
        result.body = Readable.from(
          (async function* () {
            try {
              for await (const chunk of source) {
                for (let offset = 0; offset < chunk.length; offset += 32768) {
                  await new Promise((resolve) => setTimeout(resolve, 30));
                  yield chunk.subarray(offset, offset + 32768);
                }
              }
            } finally {
              source.destroy();
            }
          })(),
          { objectMode: false },
        );
      }
      return result;
    },
  );
  try {
    const response = await fetch(
      `${f.url}/api/v1/panels/runtime/${f.grant.instanceId}/resources/${asset.id}`,
      { headers: { Cookie: "session=owner-a" } },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let received = (await reader.read()).value!.length;
    expect(received).toBeGreaterThan(0);
    await f.api(f.grant.instanceId, "DELETE");
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.length;
      }
    } catch {
      /* Node errors on premature close; Bun may return a short body. */
    }
    expect(received).toBeLessThan(asset.bytes);
    expect(
      (
        await f.api(`${otherGrant.instanceId}/call`, "POST", {
          method: "resources.get",
          params: { id: asset.id },
        })
      ).status,
    ).toBe(200);
  } finally {
    slow.mockRestore();
  }
});

test("revoking a login stops an idle resource stream without waiting for another chunk", async () => {
  const f = await previewFixture(Buffer.alloc(1024 * 1024, 42));
  const original = PanelResourceService.prototype.openRead;
  let idle: Readable | undefined;
  const paused = spyOn(PanelResourceService.prototype, "openRead").mockImplementation(
    async function (scope, id, options) {
      const result = await original.call(this, scope, id, options);
      result.body?.destroy();
      idle = new Readable({ read() {} });
      idle.push(Buffer.from("0"));
      return { ...result, body: idle };
    },
  );
  try {
    const response = await fetch(f.url + f.effect.url, { headers: { Cookie: "session=owner-a" } });
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBe(1);
    f.state.owners.delete("owner-a");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([
        (async () => {
          let received = 1;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) return received < f.asset.bytes;
              received += chunk.value.length;
            }
          } catch {
            return received < f.asset.bytes;
          }
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      expect(stopped).toBe(true);
      expect(idle!.destroyed).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    paused.mockRestore();
    idle?.destroy();
  }
});
