import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = realpathSync(process.argv[2]);
process.env.HOME = join(root, "home");
process.env.CODE_SHELL_HOME = join(root, "code-shell-home");
const desktopMain = resolve(import.meta.dir, "..");
const repository = resolve(desktopMain, "../../../..");
const userData = join(root, "electron-profile");
const first = join(root, "first %20 project");
const second = join(root, "second project");
const forged = join(root, "forged-worktree");
const outside = join(root, "unregistered-project");
const source = join(root, "panel-source");
for (const directory of [
  userData,
  first,
  second,
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
    permissions: ["context.workspace", "storage", "workspace.read", "workspace.write"],
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
// Exercise current runtime sources without imposing a competing package build on the host.
const panelsModule = await import(join(repository, "packages/server/src/index.panels.ts"));
mock.module("@cjhyy/code-shell-server/panels", () => panelsModule);
const { createDesktopWebService } = await import(join(desktopMain, "desktop-web-service.ts"));
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
const allowed = new Set([first, second, forged]);
const api = createDesktopWebService({
  devices,
  getBridge: () => bridge,
  resolveWorkspace: async (cwd) => (allowed.has(cwd ?? first) ? (cwd ?? first) : undefined),
  onSessionsChanged: () => {},
});
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
let cookie;
async function request(
  path,
  { cwd = first, method = "GET", body, authenticated = true, origin = baseUrl } = {},
) {
  return fetch(baseUrl + path, {
    method,
    headers: {
      Origin: origin,
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
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
async function prepare(cwd) {
  const panel = await list(cwd);
  const response = await request("/api/v1/panels/runtime/prepare", {
    cwd,
    method: "POST",
    body: { appId: panel.id, revision: panel.revision },
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
  assert.equal(await call(first, grantA, "storage.get", { key: "marker" }), "desktop-first");
  assert.equal(await call(second, grantB, "storage.get", { key: "marker" }), "desktop-second");
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
  }
  assert.equal(
    (
      await request("/api/v1/panel-assets/unknown/app/main.js", {
        authenticated: false,
        origin: "null",
      })
    ).status,
    404,
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
  assert.equal((await request(grantA.src, { authenticated: false, origin: "null" })).status, 404);
  assert.equal((await request(grantB.src, { authenticated: false, origin: "null" })).status, 404);
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
  assert.equal((await request(next.src, { authenticated: false, origin: "null" })).status, 404);
  assert.equal((await request("/api/v1/panels", { cwd: second })).status, 401);
  await login();
  const closing = await prepare(second);
  await api.close();
  assert.equal((await request(closing.src, { authenticated: false, origin: "null" })).status, 404);
  api.start();
  await login();
  const revoked = await prepare(second);
  devices.revoke(device.id);
  api.revokeDevice(device.id);
  assert.equal((await request(revoked.src, { authenticated: false, origin: "null" })).status, 404);
  assert.equal((await request("/api/v1/panels", { cwd: second })).status, 401);
  assert.ok(mutations >= 1);
  assert.ok(notifications >= 1);
  console.log(
    JSON.stringify({
      pairedFacade: true,
      sharedDesktopStorage: true,
      workspaceIsolation: true,
      opaqueModuleAssets: true,
      mutationGate: true,
      crossWorkspaceInvalidation: true,
      logoutRevokesAssets: true,
      closeRevokesAssets: true,
      deviceRevocation: true,
      forgedBindingRejected: true,
    }),
  );
} finally {
  await api.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
