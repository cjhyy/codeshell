import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";

const root = realpathSync(process.argv[2]);
const tunnel = process.argv[3] === "tunnel";
process.env.HOME = join(root, "home");
process.env.CODE_SHELL_HOME = join(root, "code-shell-home");
const desktopMain = resolve(import.meta.dir, "..");
const repository = resolve(desktopMain, "../../../..");
const userData = join(root, "electron-profile");
const first = join(root, "first %20 project");
const second = join(root, "second project");
const firstSecondary = join(root, "first secondary root");
const forged = join(root, "forged-worktree");
const outside = join(root, "unregistered-project");
const source = join(root, "panel-source");
for (const directory of [
  userData,
  first,
  second,
  firstSecondary,
  forged,
  outside,
  join(source, ".codeshell-panel"),
  join(source, "app"),
])
  mkdirSync(directory, { recursive: true });
writeFileSync(join(forged, ".git"), `gitdir: ${outside}/.git/worktrees/forged\n`);
writeFileSync(
  join(source, ".codeshell-panel/panel.json"),
  JSON.stringify({
    schemaVersion: 1,
    id: "desktop-panel",
    version: "1.0.0",
    title: { default: "Desktop panel" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    placement: "right-dock",
    permissions: [
      "context.workspace",
      "context.session",
      "automations.manage",
      "storage",
      "workspace.read",
      "workspace.write",
      "resources",
    ],
  }),
);
writeFileSync(
  join(source, "app/index.html"),
  '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>',
);
writeFileSync(join(source, "app/main.js"), 'document.body.dataset.fixture = "desktop-panel";');
mock.module("electron", () => ({
  app: {
    getPath: (name) => {
      assert.equal(name, "userData");
      return userData;
    },
  },
}));
const server = createServer((request, response) => {
  void api
    .handle(request, response, { baseUrl })
    .then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    })
    .catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const { installLocalNetworkGuard } = await import(
  join(repository, "scripts/runtime-cost-smoke-isolation.mjs")
);
installLocalNetworkGuard(baseUrl);
assert.throws(() => fetch("https://scope.invalid/"), /non-fixture/);
assert.throws(() => http.get("http://127.0.0.1:9/"), /non-fixture/);
// Exercise current runtime sources without imposing a competing package build on the host.
const panelsModule = await import(join(repository, "packages/server/src/index.panels.ts"));
mock.module("@cjhyy/code-shell-server/panels", () => panelsModule);
const desktopWebModule = await import(join(repository, "packages/server/src/index.desktop-web.ts"));
mock.module("@cjhyy/code-shell-server/desktop-web", () => desktopWebModule);
const { createDesktopWebService } = await import(join(desktopMain, "desktop-web-service.ts"));
const { getProjectStore } = await import(join(desktopMain, "project-store.ts"));
const { createDesktopPanelProjectScopeResolver, resolveDesktopPanelProjectPath } = await import(
  join(desktopMain, "panel-project-scope.ts")
);
const projectStore = getProjectStore();
await projectStore.addRoot((await projectStore.createFromPath(first)).id, firstSecondary);
await projectStore.createFromPath(second);
const resolveProjectScope = createDesktopPanelProjectScopeResolver({
  store: projectStore,
  environmentDir: join(root, "code-shell-home", "desktop"),
});
const { createDesktopPanelAutomationHost } = await import(
  join(desktopMain, "panel-automation-host.ts")
);
const { CronScheduler, CronStore } = await import("@cjhyy/code-shell-core/internal");
const scheduler = new CronScheduler(new CronStore(join(root, "cron.json")));
scheduler.setExecutionEnabled(false);
const automationHost = createDesktopPanelAutomationHost(
  () => ({
    requireRendererPath: async (cwd) => cwd,
    isNoRepoCwd: () => false,
    resolveExactRoot: () => undefined,
    resolveProjectRootById: (projectId, rootId) => ({
      projectId,
      rootId,
      cwd: projectId === "first" ? first : second,
    }),
    resolveSessionAuthority: async (sessionId) =>
      sessionId === "session-first" || sessionId === "session-second"
        ? {
            sessionId,
            cwd: sessionId === "session-first" ? first : second,
            projectId: sessionId === "session-first" ? "first" : "second",
            rootId: "main",
          }
        : undefined,
  }),
  () => scheduler,
);
const { SettingsManager, installReviewedLocalPanelApp, previewLocalPanelApp } =
  await import("@cjhyy/code-shell-core");
const { TrustedDeviceStore } = await import("@cjhyy/code-shell-server/mobile-remote");
const { panelAppStoragePath, writePanelAppStorage, DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES } =
  await import(join(repository, "packages/server/src/panels/storage-store.ts"));
const preview = await previewLocalPanelApp({ kind: "dir", path: source });
await installReviewedLocalPanelApp(
  { kind: "dir", path: source },
  preview.reviewToken,
  new Date().toISOString(),
);
for (const cwd of [first, second])
  new SettingsManager(cwd, "full").mutateSettingsForScope("project", cwd, (current) => {
    current.panelAppBindings = ["desktop-panel"];
  });
for (const [cwd, marker] of [
  [first, "desktop-first"],
  [second, "desktop-second"],
])
  await writePanelAppStorage(
    panelAppStoragePath(userData, "desktop-panel", cwd),
    { marker },
    DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES,
  );
const devices = new TrustedDeviceStore(join(root, "devices.json"));
const device = devices.addDevice({
  name: "Fixture browser",
  secretHash: "synthetic-paired-secret",
});
let mutations = 0;
let notifications = 0;
let busy = false;
const bridge = {
  isSessionRunning: () => busy,
  withWebConfigurationMutation: async (_cwd, work) => {
    if (busy) throw Object.assign(new Error("busy"), { status: 409 });
    mutations++;
    return work();
  },
  notifyWebConfigurationChanged: () => {
    notifications++;
  },
};
const allowed = new Set([first, second, firstSecondary, forged]);
const api = createDesktopWebService({
  devices,
  automations: automationHost,
  resolveProjectScope,
  resolvePanelProjectPath: (cwd) => resolveDesktopPanelProjectPath(projectStore, cwd),
  sharedToolJobs: {
    bind: async () => {
      throw new Error("This storage-only fixture must not bind native tasks");
    },
    activeCount: () => 0,
    invalidate: async () => {},
  },
  authorizePanelDirectory: async () => {
    throw new Error("Storage fixture cannot grant a directory");
  },
  getBridge: () => bridge,
  resolveWorkspace: async (cwd) => (allowed.has(cwd ?? first) ? (cwd ?? first) : undefined),
  onSessionsChanged: () => {},
});
let remoteHost;
let accessCookie;
let passcode;
if (tunnel) {
  const { RemoteHostManager } = await import(
    join(repository, "packages/server/src/mobile-remote/remote-host-manager.ts")
  );
  const { AccessPasscode } = await import(
    join(repository, "packages/server/src/mobile-remote/access-passcode.ts")
  );
  // Reserve the exact origin before Core imports so the network guard stays
  // installed; then replace the fixture listener with the real tunnel host.
  await new Promise((resolve) => server.close(resolve));
  passcode = new AccessPasscode({ filePath: join(root, "access.json") });
  passcode.set("fixture-access-passcode");
  remoteHost = new RemoteHostManager({ devices, webApi: api, onClientEvent: () => {} });
  const started = await remoteHost.start({
    mode: "tunnel",
    host: "localhost",
    port: Number(new URL(baseUrl).port),
    passcode,
  });
  assert.equal(started.url, baseUrl);
  const access = await fetch(`${baseUrl}/health`, {
    headers: { "X-Access-Passcode": "fixture-access-passcode" },
  });
  assert.equal(access.status, 200);
  accessCookie = access.headers.get("set-cookie").split(";", 1)[0];
  assert.match(access.headers.get("set-cookie"), /SameSite=Lax/);
}
let cookie;
async function request(
  path,
  { cwd = first, method = "GET", body, authenticated = true, origin = baseUrl } = {},
) {
  return fetch(baseUrl + path, {
    method,
    headers: {
      Origin: origin,
      ...((authenticated && cookie) || (accessCookie && origin !== "null")
        ? {
            Cookie: [authenticated && cookie, origin !== "null" && accessCookie]
              .filter(Boolean)
              .join("; "),
          }
        : {}),
      ...(cwd ? { "X-CodeShell-Workspace": encodeURIComponent(cwd) } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login() {
  const response = await request("/api/v1/desktop/session", {
    method: "POST",
    body: { deviceId: device.id, secretHash: "synthetic-paired-secret" },
    authenticated: false,
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie").split(";", 1)[0];
}
async function list(cwd) {
  const response = await request("/api/v1/panels", { cwd });
  assert.equal(response.status, 200);
  return (await response.json()).panels[0];
}
async function prepare(cwd, sessionId = cwd === first ? "session-first" : "session-second") {
  const panel = await list(cwd);
  const response = await request("/api/v1/panels/runtime/prepare", {
    cwd,
    method: "POST",
    body: { appId: panel.id, revision: panel.revision, sessionId },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function call(cwd, grant, method, params) {
  const response = await request(`/api/v1/panels/runtime/${grant.instanceId}/call`, {
    cwd,
    method: "POST",
    body: { method, params },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
try {
  assert.equal((await request("/api/v1/panels", { authenticated: false })).status, 401);
  await login();
  assert.equal((await request("/api/v1/panels", { cwd: outside })).status, 403);
  assert.equal((await request("/api/v1/panels", { cwd: forged })).status, 403);
  const grantA = await prepare(first);
  const grantB = await prepare(second);
  if (tunnel) {
    for (const [path, method] of [
      ["/health", "GET"],
      ["/api/v1/panels", "GET"],
      ["/api/v1/panels/runtime/prepare", "POST"],
      ["/api/mobile/uploads/opaque-upload-ticket", "PUT"],
      [grantA.src, "POST"],
      [grantA.src, "OPTIONS"],
    ]) {
      const denied = await fetch(baseUrl + path, { method, headers: { Origin: "null" } });
      assert.equal(denied.status, 401, `${method} ${path} must retain the passcode gate`);
    }
    const upgradeStatus = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/ws`, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          Origin: "null",
        },
      });
      req.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on("upgrade", (_response, socket) => {
        socket.destroy();
        reject(new Error("ungated websocket"));
      });
      req.on("error", (error) => {
        if (error.code === "ECONNRESET") resolve("closed");
        else reject(error);
      });
      req.end();
    });
    assert.ok(upgradeStatus === 401 || upgradeStatus === "closed");
  }
  const nativeScope = await resolveProjectScope(first, first);
  assert.deepEqual(grantA.context.projectScope, nativeScope.scope);
  const switchedSession = await prepare(first, "other-session");
  assert.deepEqual(switchedSession.context.projectScope, nativeScope.scope);
  assert.notEqual(grantA.context.projectScope.projectId, grantB.context.projectScope.projectId);
  assert.equal(
    (await call(first, grantA, "context.get")).projectScope.environmentId,
    nativeScope.scope.environmentId,
  );
  const forgedScope = await request("/api/v1/panels/runtime/prepare", {
    method: "POST",
    body: {
      appId: "desktop-panel",
      revision: (await list(first)).revision,
      projectScope: nativeScope.scope,
    },
  });
  assert.equal(forgedScope.status, 400);
  assert.ok(grantA.context.availableMethods.includes("automations.createUnique"));
  assert.equal(
    grantA.limitations.some((reason) => reason.includes("automations.manage")),
    false,
  );
  const automationInput = {
    name: "phone reminder",
    schedule: "1h",
    prompt: "fixture prompt",
    key: "market.us",
    timezone: "UTC",
  };
  const [jobA, replay] = await Promise.all([
    call(first, grantA, "automations.createUnique", automationInput),
    call(first, grantA, "automations.createUnique", automationInput),
  ]);
  assert.equal(jobA.id, replay.id);
  assert.equal(scheduler.list().length, 1);
  scheduler.pause(jobA.id);
  assert.equal((await call(first, grantA, "automations.list", {})).automations[0].enabled, false);
  await call(first, grantA, "automations.update", { id: jobA.id, prompt: "from phone" });
  assert.equal(scheduler.get(jobA.id).prompt, "from phone");
  assert.deepEqual((await call(second, grantB, "automations.list", {})).automations, []);
  const forgedSession = await prepare(first, "session-second");
  for (const [grant, cwd, method, params] of [
    [forgedSession, first, "automations.list", {}],
    [grantB, second, "automations.delete", { id: jobA.id }],
    [grantA, first, "automations.createUnique", { ...automationInput, cwd: second }],
  ]) {
    const denied = await request(`/api/v1/panels/runtime/${grant.instanceId}/call`, {
      cwd,
      method: "POST",
      body: { method, params },
    });
    assert.notEqual(denied.status, 200, await denied.text());
  }
  assert.equal(scheduler.list().length, 1);
  assert.equal(await call(first, grantA, "storage.get", { key: "marker" }), "desktop-first");
  assert.equal(await call(second, grantB, "storage.get", { key: "marker" }), "desktop-second");
  // R22: a Session on the first project's secondary root opens the first
  // project's Panel and storage, while execution follows that root like native.
  assert.equal((await list(firstSecondary)).bound, true);
  const grantSecondary = await prepare(firstSecondary, "session-first");
  assert.equal(grantSecondary.context.cwd, firstSecondary);
  assert.deepEqual(
    grantSecondary.context.projectScope,
    (await resolveProjectScope(first, firstSecondary)).scope,
  );
  assert.equal(grantSecondary.context.projectScope.projectId, nativeScope.scope.projectId);
  assert.notEqual(grantSecondary.context.projectScope.rootId, nativeScope.scope.rootId);
  assert.equal(
    await call(firstSecondary, grantSecondary, "storage.get", { key: "marker" }),
    "desktop-first",
  );
  for (const grant of [grantA, grantB]) {
    assert.equal(grant.context.host, "desktop");
    const html = await request(grant.src, { cwd: undefined, authenticated: false, origin: "null" });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy"), /sandbox allow-scripts/);
    const script = await request(grant.src.replace(/index\.html$/, "main.js"), {
      cwd: undefined,
      authenticated: false,
      origin: "null",
    });
    assert.equal(script.status, 200);
    assert.match(await script.text(), /desktop-panel/);
    const head = await request(grant.src.replace(/index\.html$/, "main.js"), {
      method: "HEAD",
      cwd: undefined,
      authenticated: false,
      origin: "null",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    // The ordinary route retains preflight support once the entrance gate has
    // passed. OPTIONS is deliberately not part of the cookie-free exception.
    const preflight = await request(grant.src, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  }
  assert.equal(
    (
      await request("/api/v1/panel-assets/unknown/app/main.js", {
        authenticated: false,
        origin: "null",
      })
    ).status,
    tunnel ? 401 : 404,
  );
  const before = await list(first);
  busy = true;
  assert.equal(
    (
      await request(`/api/v1/panels/${before.id}/binding`, {
        method: "PATCH",
        body: { bound: false, expectedRevision: before.revision },
      })
    ).status,
    409,
  );
  assert.equal((await request(grantA.src, { authenticated: false, origin: "null" })).status, 200);
  busy = false;
  assert.equal(
    (
      await request(`/api/v1/panels/${before.id}/binding`, {
        method: "PATCH",
        body: { bound: false, expectedRevision: before.revision },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(grantA.src, { authenticated: false, origin: "null" })).status,
    tunnel ? 401 : 404,
  );
  assert.equal((await request(grantB.src, { authenticated: false, origin: "null" })).status, 200);
  assert.equal((await list(second)).bound, true);
  const next = await prepare(second);
  assert.equal(
    await call(second, next, "storage.set", { key: "marker", value: "web-shared-value" }),
    true,
  );
  assert.equal(
    JSON.parse(readFileSync(panelAppStoragePath(userData, "desktop-panel", second), "utf8")).marker,
    "web-shared-value",
  );
  assert.equal((await request("/api/v1/auth/logout", { method: "POST", body: {} })).status, 200);
  assert.equal(
    (await request(next.src, { authenticated: false, origin: "null" })).status,
    tunnel ? 401 : 404,
  );
  assert.equal((await request("/api/v1/panels", { cwd: second })).status, 401);
  assert.equal(scheduler.list().length, 1, "logout revokes control, not accepted recurring jobs");
  await login();
  if (tunnel) {
    const { PanelResourceService } = await import(
      join(repository, "packages/server/src/panels/resources/service.ts")
    );
    const resources = new PanelResourceService({
      rootDirectory: join(userData, "panel-app-media"),
      isScopeAuthorized: () => true,
    });
    try {
      const file = join(second, "preview.mp4");
      writeFileSync(file, "0123456789");
      const asset = await resources.library.importFile(
        { appId: "desktop-panel", projectPath: second },
        file,
      );
      const oldModule = await prepare(second);
      const oldPreview = await prepare(second);
      const preview = await call(second, oldPreview, "resources.preview", { assetId: asset.id });
      const inlinePath = new URL(preview.url).pathname;
      assert.equal(
        (await request(inlinePath, { authenticated: false, origin: "null" })).status,
        200,
      );
      passcode.set("rotated-fixture-passcode");
      assert.equal((await request("/api/v1/panels", { cwd: second })).status, 401);
      // The paired HTTP session still exists, but neither grant may outlive the
      // passcode generation that authorized its original prepare request.
      for (const path of [oldModule.src, inlinePath])
        assert.equal((await request(path, { authenticated: false, origin: "null" })).status, 410);
      const access = await fetch(`${baseUrl}/health`, {
        headers: { "X-Access-Passcode": "rotated-fixture-passcode" },
      });
      assert.equal(access.status, 200);
      accessCookie = access.headers.get("set-cookie").split(";", 1)[0];
      const renewed = await prepare(second);
      assert.equal(
        (await request(renewed.src, { authenticated: false, origin: "null" })).status,
        200,
      );
      const freshPreview = await call(second, renewed, "resources.preview", { assetId: asset.id });
      assert.equal(
        (
          await request(new URL(freshPreview.url).pathname, {
            authenticated: false,
            origin: "null",
          })
        ).status,
        200,
      );
      assert.equal(
        (await request(oldModule.src, { authenticated: false, origin: "null" })).status,
        401,
      );
    } finally {
      await resources.shutdown();
    }
  }
  const closing = await prepare(second);
  await api.close();
  assert.equal(scheduler.list().length, 1, "closing Web must not own the Desktop scheduler");
  assert.equal(
    (await request(closing.src, { authenticated: false, origin: "null" })).status,
    tunnel ? 401 : 404,
  );
  api.start();
  await login();
  const revoked = await prepare(second);
  devices.revoke(device.id);
  // A known capability must recheck its original paired owner even before
  // explicit revokeDevice cleanup removes it from the asset map.
  assert.equal((await request(revoked.src, { authenticated: false, origin: "null" })).status, 410);
  api.revokeDevice(device.id);
  assert.equal(
    (await request(revoked.src, { authenticated: false, origin: "null" })).status,
    tunnel ? 401 : 404,
  );
  assert.equal((await request("/api/v1/panels", { cwd: second })).status, 401);
  assert.ok(mutations >= 1);
  assert.ok(notifications >= 1);
  console.log(
    JSON.stringify({
      pairedFacade: true,
      sharedDesktopStorage: true,
      workspaceIsolation: true,
      opaqueModuleAssets: true,
      assetPreflight: true,
      mutationGate: true,
      projectScopedInvalidation: true,
      logoutRevokesAssets: true,
      closeRevokesAssets: true,
      deviceRevocation: true,
      forgedBindingRejected: true,
      sharedAutomationScheduler: true,
      automationTaskScope: true,
      nativePairedProjectScope: true,
      sessionIndependentProjectScope: true,
      forgedProjectScopeRejected: true,
      secondaryRootProjectScope: true,
      ...(tunnel
        ? {
            tunnelOpaqueAssets: true,
            ordinaryRoutesGated: true,
            passcodeRotationRevokesAssets: true,
          }
        : {}),
    }),
  );
} finally {
  scheduler.stopAll();
  await api.close();
  if (remoteHost) await remoteHost.stop();
  else {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
