import { mock } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
// Runs in a child Bun process so Electron/service mocks cannot pollute other tests.
const main = resolve(import.meta.dir, "..");
const repo = resolve(main, "../../../..");
const root = realpathSync(process.argv[2]);
const cwd = join(root, "project");
const other = join(root, "other");
for (const path of [cwd, other, join(root, "desktop"), join(root, "sessions")])
  mkdirSync(path, { recursive: true });
for (const path of [cwd, other]) {
  execFileSync("git", ["init", path], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { stdio: "ignore" },
  );
}
const ipc = new EventEmitter();
const frames = [];
const window = new EventEmitter();
window.isDestroyed = () => false;
window.webContents = {
  id: 11,
  isDestroyed: () => false,
  send: (channel, line) => frames.push({ channel, line }),
};
mock.module("electron", () => ({
  ipcMain: ipc,
  BrowserWindow: { fromWebContents: () => window },
  app: { getPath: () => root },
}));
mock.module(join(main, "desktop-logger.ts"), () => ({ dlog: () => {} }));
mock.module(join(main, "browser-runtime/index.ts"), () => ({
  browserRuntime: {},
  builtInBrowserHandoffGrants: {},
  chromeExtensionRuntimeService: {},
  annotateBrowserRuntimeStreamEvent: (event) => event,
  dispatchInteractiveBrowserRuntimeAction: () => {},
  releaseChildBrowserRuntime: () => {},
  activateChildBrowserRuntime: () => {},
  interactiveBrowserRuntimeOwner: () => {},
  replaceStreamEventInLine: (line) => line,
}));
mock.module(join(main, "credential-action.ts"), () => ({
  resolveCookieCredentialForBrowser: () => ({ ok: false }),
}));
mock.module(join(main, "cookie-credential-browser.ts"), () => ({
  restoreCookieCredentialToBrowser: () => {},
}));
mock.module(join(main, "credential-access-service.ts"), () => ({
  buildCredentialSnapshot: () => ({ revision: 1, entries: [] }),
  materializeCredentialCookieForWorker: () => {},
  resolveCredentialValueForWorker: () => {},
}));
mock.module(join(main, "automation-service.ts"), () => ({ reloadAutomations: () => {} }));
mock.module(join(main, "trust-store.ts"), () => ({ getTrustCachedSync: () => "trusted" }));
const { SessionManager } = await import(join(repo, "packages/core/dist/index.js"));
const projectModule = await import(join(main, "project-store.ts"));
const indexModule = await import(join(main, "session-cwd-index.ts"));
const sessions = new SessionManager(join(root, "sessions"));
const index = new indexModule.SessionCwdIndex({ sessionsRoot: join(root, "sessions") });
const project = new projectModule.ProjectStore({
  file: join(root, "desktop/projects.json"),
  recentsFile: join(root, "desktop/recents.json"),
  migrationMarkerFile: join(root, "desktop/migration.json"),
  noRepoPath: join(root, "no-repo"),
  sessionIndex: index,
  sessionManager: sessions,
});
await project.createFromPath(cwd);
await project.createFromPath(other);
mock.module(join(main, "project-store.ts"), () => ({
  ...projectModule,
  getProjectStore: () => project,
}));
mock.module(join(main, "session-cwd-index.ts"), () => ({
  ...indexModule,
  getSessionCwdIndex: () => index,
}));
const worker = join(root, "worker.mjs");
writeFileSync(
  worker,
  String.raw`
import { createInterface } from 'node:readline';
const pending = new Map();
let exitOnConfigure = false;
const emit = message => process.stdout.write(JSON.stringify(message)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='test/exitOnConfigure') { exitOnConfigure=true; } else if(m.method==='agent/configure' && exitOnConfigure) { process.exit(0); } else if(m.method==='agent/run') { pending.set(m.params.sessionId,m.id); emit({method:'test/runReceived',params:{sessionId:m.params.sessionId}}); } else if(m.method==='test/finish') {const id=pending.get(m.params.sessionId); pending.delete(m.params.sessionId); emit({id,result:{reason:'completed',turnCount:1}}); } else if(m.id!==undefined) emit({id:m.id,result:{ok:true}});});
`,
);
const workerModule = await import(join(repo, "packages/server/src/worker-bridge-core.ts"));
mock.module("@cjhyy/code-shell-server/worker", () => ({
  ...workerModule,
  WorkerBridgeCore: class extends workerModule.WorkerBridgeCore {
    constructor(options) {
      super({ ...options, entryPath: worker, buildEnv: () => process.env });
    }
  },
}));
const { AgentBridge } = await import(join(main, "agent-bridge.ts"));
const bridge = new AgentBridge(window);
let remote;
const workspaceService = await import(join(main, "session-workspace-service.ts"));
workspaceService.__setSessionWorkspaceServiceSessionManagerForTests(sessions);
workspaceService.__setSessionWorkspaceServiceProjectStoreForTests(project);
const { MobileRemoteOrchestrator } = await import(join(main, "mobile-remote-orchestrator.ts"));
const orchestrator = new MobileRemoteOrchestrator({ remote: {}, getBridge: () => bridge });
const wait = async (predicate) => {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};
try {
  const existing = sessions.create(cwd, "fixture", "openai", "renderer-session");
  await index.lookup(existing.state.sessionId);
  ipc.emit(
    "agent:msg",
    { sender: window.webContents },
    JSON.stringify({
      id: "window-uuid-1",
      method: "agent/run",
      params: { sessionId: "renderer-session", cwd, task: "fixture" },
    }),
  );
  assert.equal(bridge.isSessionRunning("renderer-session"), true);
  await assert.rejects(
    bridge.withWebConfigurationMutation(cwd, async () => {}),
    (e) => e.status === 409,
  );
  bridge.injectWorkerMessage(
    JSON.stringify({ method: "test/finish", params: { sessionId: "renderer-session" } }),
    { origin: "host", producer: "fixture" },
  );
  await wait(() => !bridge.isSessionRunning("renderer-session"));

  sessions.create(cwd, "fixture", "openai", "mobile-session");
  await index.lookup("mobile-session");
  bridge.injectWorkerMessage(
    JSON.stringify({
      id: "mobile-run-fixture",
      method: "agent/run",
      params: { sessionId: "mobile-session", cwd, task: "fixture" },
    }),
    { origin: "mobile", producer: "fixture" },
  );
  assert.equal(bridge.isSessionRunning("mobile-session"), true);
  await assert.rejects(
    bridge.withWebConfigurationMutation(cwd, async () => {}),
    (e) => e.status === 409,
  );
  bridge.injectWorkerMessage(
    JSON.stringify({ method: "test/finish", params: { sessionId: "mobile-session" } }),
    { origin: "host", producer: "fixture" },
  );
  await wait(() => !bridge.isSessionRunning("mobile-session"));
  bridge.reserveHostSession("host-session", cwd, "fixture");
  const hostRun = bridge.requestWorker(
    "agent/run",
    { sessionId: "host-session", cwd, task: "fixture" },
    5000,
    { meta: { origin: "host", producer: "fixture" }, failFast: true },
  );
  assert.equal(bridge.isSessionRunning("host-session"), true);
  await assert.rejects(
    bridge.withWebConfigurationMutation(cwd, async () => {}),
    (e) => e.status === 409,
  );
  bridge.injectWorkerMessage(
    JSON.stringify({ method: "test/finish", params: { sessionId: "host-session" } }),
    { origin: "host", producer: "fixture" },
  );
  assert.equal((await hostRun).ok, true);
  assert.equal(bridge.isSessionRunning("host-session"), false);
  let release;
  let writes = 0;
  const mutation = bridge.withWebConfigurationMutation(cwd, async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    writes++;
    return "saved";
  });
  for (const id of ["blocked-renderer", "blocked-mobile"]) {
    sessions.create(cwd, "fixture", "openai", id);
    await index.lookup(id);
  }
  ipc.emit(
    "agent:msg",
    { sender: window.webContents },
    JSON.stringify({
      id: "blocked-ipc-id",
      method: "agent/run",
      params: { sessionId: "blocked-renderer", cwd, task: "fixture" },
    }),
  );
  bridge.injectWorkerMessage(
    JSON.stringify({
      id: "blocked-mobile-id",
      method: "agent/run",
      params: { sessionId: "blocked-mobile", cwd, task: "fixture" },
    }),
    { origin: "mobile", producer: "fixture" },
  );
  bridge.reserveHostSession("blocked-host", cwd, "fixture");
  const blockedHost = await bridge.requestWorker(
    "agent/run",
    { sessionId: "blocked-host", cwd, task: "fixture" },
    5000,
    { meta: { origin: "host", producer: "fixture" }, failFast: true },
  );
  assert.equal(blockedHost.ok, false);
  assert.equal(
    frames.some((frame) => frame.line?.includes("blocked-ipc-id") && JSON.parse(frame.line).error),
    true,
  );
  assert.equal(
    frames.some(
      (frame) => frame.line?.includes("blocked-mobile-id") && JSON.parse(frame.line).error,
    ),
    true,
  );
  for (const id of ["blocked-renderer", "blocked-mobile", "blocked-host"])
    assert.equal(bridge.isSessionRunning(id), false);
  release();
  assert.equal(await mutation, "saved");
  assert.equal(writes, 1);
  assert.equal(
    frames.some((frame) => frame.line?.includes("serve/configurationChanged")),
    true,
  );

  // Synchronous transport failures must release admissions for all producers.
  const sendLine = bridge.core.sendLine.bind(bridge.core);
  bridge.core.sendLine = (line) => {
    if (JSON.parse(line).method === "agent/run") throw new Error("fixture stdin failure");
    return sendLine(line);
  };
  ipc.emit(
    "agent:msg",
    { sender: window.webContents },
    JSON.stringify({
      id: "failed-ipc",
      method: "agent/run",
      params: { sessionId: "renderer-session", cwd, task: "fixture" },
    }),
  );
  assert.equal(bridge.isSessionRunning("renderer-session"), false);
  assert.throws(
    () =>
      bridge.injectWorkerMessage(
        JSON.stringify({
          id: "failed-mobile",
          method: "agent/run",
          params: { sessionId: "mobile-session", cwd, task: "fixture" },
        }),
        { origin: "mobile", producer: "fixture" },
      ),
    /fixture stdin failure/,
  );
  assert.equal(bridge.isSessionRunning("mobile-session"), false);
  const failedHost = await bridge.requestWorker(
    "agent/run",
    { sessionId: "host-session", cwd, task: "fixture" },
    5000,
    { meta: { origin: "host", producer: "fixture" }, failFast: true },
  );
  assert.equal(failedHost.ok, false);
  assert.equal(bridge.isSessionRunning("host-session"), false);
  bridge.core.sendLine = sendLine;

  // A worker exiting after the write is safe: its replacement reads the saved settings.
  bridge.injectWorkerMessage(JSON.stringify({ method: "test/exitOnConfigure" }), {
    origin: "host",
    producer: "fixture",
  });
  assert.equal(
    await bridge.withWebConfigurationMutation(cwd, async () => "saved-before-exit"),
    "saved-before-exit",
  );
  assert.equal(bridge.hasLiveWorker(), false);
  const resumed = bridge.requestWorker(
    "agent/run",
    { sessionId: "host-session", cwd, task: "fixture" },
    5000,
    { meta: { origin: "host", producer: "fixture" }, failFast: true },
  );
  assert.equal(bridge.isSessionRunning("host-session"), true);
  bridge.injectWorkerMessage(
    JSON.stringify({ method: "test/finish", params: { sessionId: "host-session" } }),
    { origin: "host", producer: "fixture" },
  );
  assert.equal((await resumed).ok, true);

  const { createDesktopWebApi } = await import(
    join(repo, "packages/server/src/desktop-web/http-api.ts")
  );
  const { RemoteHostManager } = await import(
    join(repo, "packages/server/src/mobile-remote/remote-host-manager.ts")
  );
  const { TrustedDeviceStore } = await import(
    join(repo, "packages/server/src/mobile-remote/trusted-device-store.ts")
  );
  const devices = new TrustedDeviceStore(join(root, "devices.json"));
  const device = devices.addDevice({
    name: "Paired fixture",
    secretHash: "synthetic-fixture-secret",
  });
  for (const [path, model] of [
    [cwd, "primary-model"],
    [other, "secondary-model"],
  ]) {
    mkdirSync(join(path, ".code-shell"), { recursive: true });
    writeFileSync(
      join(path, ".code-shell/settings.local.json"),
      JSON.stringify({
        modelConnections: [
          {
            id: "desktop-shared-fixture",
            catalogId: "openai",
            tag: "text",
            model,
            baseUrl: "http://127.0.0.1:1/v1",
          },
        ],
      }),
    );
  }
  sessions.create(other, "fixture", "openai", "secondary-session");
  const api = createDesktopWebApi({
    devices,
    dataDir: join(root, "desktop"),
    sessionRootDir: join(root, "sessions"),
    resolveWorkspace: (input, id) => orchestrator.resolveWebWorkspace(input, id),
    withConfigurationMutation: (path, write) => bridge.withWebConfigurationMutation(path, write),
    isRunning: (id) => bridge.isSessionRunning(id),
  });
  remote = new RemoteHostManager({ devices, onClientEvent: () => {}, webApi: api });
  const started = await remote.start({ host: "127.0.0.1", port: 0 });
  const login = await fetch(started.url + "/api/v1/desktop/session", {
    method: "POST",
    headers: { origin: started.url, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: device.id, secretHash: "synthetic-fixture-secret" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const request = (path, workspace, body) =>
    fetch(started.url + path, {
      method: body ? "PUT" : "GET",
      headers: {
        origin: started.url,
        cookie,
        "x-codeshell-workspace": encodeURIComponent(workspace),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const primaryConfig = await (await request("/api/v1/configuration", cwd)).json();
  const secondaryConfig = await (await request("/api/v1/configuration", other)).json();
  const connection = (config) =>
    config.connections.find((row) => row.id === "desktop-shared-fixture");
  assert.equal(connection(primaryConfig).model, "primary-model");
  assert.equal(connection(secondaryConfig).model, "secondary-model");
  const primaryHistory = await (await request("/api/v1/sessions", cwd)).json();
  const secondaryHistory = await (await request("/api/v1/sessions", other)).json();
  assert.equal(
    primaryHistory.sessions.some((row) => row.sessionId === "renderer-session"),
    true,
  );
  assert.equal(
    primaryHistory.sessions.some((row) => row.sessionId === "secondary-session"),
    false,
  );
  assert.deepEqual(
    secondaryHistory.sessions.map((row) => row.sessionId),
    ["secondary-session"],
  );
  assert.equal((await request("/api/v1/sessions/renderer-session", other)).status, 404);
  const saved = await request("/api/v1/configuration/connections", cwd, {
    id: "desktop-shared-fixture",
    catalogId: "openai",
    model: "primary-updated",
    expectedRevision: connection(primaryConfig).revision,
  });
  assert.equal(saved.status, 200);
  assert.equal(
    connection(await (await request("/api/v1/configuration", cwd)).json()).model,
    "primary-updated",
  );
  assert.equal(
    connection(await (await request("/api/v1/configuration", other)).json()).model,
    "secondary-model",
  );
  assert.equal((await request("/api/v1/configuration", join(root, "unregistered"))).status, 403);
  assert.equal(await orchestrator.resolveWebWorkspace(cwd, "device"), cwd);
  assert.equal(await orchestrator.resolveWebWorkspace(other, "device"), other);
  assert.equal(await orchestrator.resolveWebWorkspace(join(root, "unknown"), "device"), undefined);
  const worktree = join(root, "worktree");
  execFileSync("git", ["-C", cwd, "worktree", "add", "-b", "fixture", worktree, "HEAD"], {
    stdio: "ignore",
  });
  sessions.updateSessionState("renderer-session", {
    workspace: {
      root: worktree,
      kind: "worktree",
      worktree: { path: worktree, branch: "fixture", baseRef: "main", createdBy: "codeshell" },
    },
  });
  orchestrator.deviceState("device").selectedSessionId = "renderer-session";
  assert.equal(await orchestrator.resolveWebWorkspace(worktree, "device"), worktree);
  rmSync(worktree, { recursive: true });
  assert.equal(await orchestrator.resolveWebWorkspace(worktree, "device"), undefined);

  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, worktree);
  assert.equal(await orchestrator.resolveWebWorkspace(worktree, "device"), undefined);
  rmSync(worktree);
  execFileSync("git", ["init", worktree], { stdio: "ignore" });
  assert.equal(await orchestrator.resolveWebWorkspace(worktree, "device"), undefined);
  console.log(
    JSON.stringify({
      rendererGate: true,
      mobileGate: true,
      hostGate: true,
      allEntrypointsBlockedDuringWrite: true,
      sharedWorkerReload: true,
      sendFailureReleasesAdmission: true,
      workerExitDuringReloadRecovers: true,
      knownWorkspaceIsolation: true,
      pairedHttpWorkspaceIsolation: true,
      deletedWorktreeRejected: true,
      symlinkWorktreeRejected: true,
      replacedWorktreeRejected: true,
    }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await remote?.stop();
  bridge.core.kill();
  rmSync(root, { recursive: true, force: true });
}
