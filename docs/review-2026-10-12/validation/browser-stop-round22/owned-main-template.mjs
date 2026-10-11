// Owned review Main. Product Main/worker/CLI are deliberately not loaded.
import { app, BrowserWindow, session, ipcMain, utilityProcess } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import children from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
const cfg = JSON.parse(readFileSync(new URL("./review-config.json", import.meta.url), "utf8"));
const pathsSetBeforeReady = !app.isReady();
if (!pathsSetBeforeReady) throw Error("PRIVATE_PATHS_MUST_BE_SET_BEFORE_READY");
app.setName("codeshell-owned-browser-stop-round22");
app.setPath("userData", cfg.userData);
app.setPath("sessionData", cfg.sessionData);
await import(pathToFileURL(join(cfg.home, "guarded-runtime.mjs")).href);
if (process.env.HOME !== cfg.home || process.env.TMPDIR !== cfg.temp || process.env.TMP !== cfg.temp || process.env.TEMP !== cfg.temp)
  throw Error("UNEXPECTED_PRIVATE_HOME_OR_TMP_CONTEXT");
const networkAttempts = [], highLevelNetworkAttempts = [], childAttempts = [], chromiumRequests = [], rendererErrors = [];
const denyNetwork = (...args) => { networkAttempts.push(String(args[0] ?? "")); throw Error("ROUND22_DIRECT_NETWORK_DENIED"); };
net.connect = net.createConnection = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
globalThis.fetch = (...args) => { highLevelNetworkAttempts.push({ api: "fetch", target: String(args[0]?.url ?? args[0] ?? "") }); throw Error("ROUND22_FETCH_DENIED"); };
for (const [protocol, client] of [["http", http], ["https", https]]) for (const name of ["request", "get"]) {
  client[name] = function (...args) { highLevelNetworkAttempts.push({ api: protocol + "." + name, target: String(args[0]?.href ?? args[0]?.hostname ?? args[0] ?? "") }); throw Error("ROUND22_HTTP_DENIED"); };
}
for (const name of ["spawn", "fork", "exec", "execFile", "spawnSync", "execSync", "execFileSync"])
  children[name] = (...args) => { childAttempts.push({ name, command: String(args[0] ?? "") }); throw Error("ROUND22_CHILD_DENIED"); };
utilityProcess.fork = (...args) => { childAttempts.push({ name: "utilityProcess.fork", command: String(args[0] ?? "") }); throw Error("ROUND22_UTILITY_DENIED"); };
syncBuiltinESMExports();
process.chdir(cfg.project);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.on("window-all-closed", () => {});

// Maintained Playwright loader releases ready after entry evaluation; do not
// top-level await app.whenReady(). No product import precedes the guards.
void app.whenReady().then(async () => {
  const allowedFiles = new Set([cfg.targetUrl, cfg.controlUrl]);
  const protectedSessions = new WeakSet();
  const protect = ses => {
    if (protectedSessions.has(ses)) return;
    protectedSessions.add(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = allowedFiles.has(details.url);
      chromiumRequests.push({ url: details.url, allowed });
      callback({ cancel: !allowed });
    });
  };
  protect(session.defaultSession);
  const windows = [], targetWindows = [], inputCommands = [], waits = [], browserRequests = [], browserReplies = [], frames = [], runs = [], engines = [], protocolInputs = [];
  let eventSequence = 0;
  const frameInstrumentation = new WeakMap();
  const { createJiti } = await import(pathToFileURL(cfg.jitiEntry).href);
  const jiti = createJiti(pathToFileURL(join(cfg.repo, "package.json")).href, {
    fsCache: join(cfg.home, "jiti-cache"), moduleCache: true, tryNative: false,
    nativeModules: ["electron"], tsconfigPaths: false,
    alias: {
      "@cjhyy/code-shell-core/internal": join(cfg.repo, "packages/core/src/index.internal.ts"),
      "@cjhyy/code-shell-core/extension": join(cfg.repo, "packages/core/src/index.extension.ts"),
      "@cjhyy/code-shell-core": join(cfg.repo, "packages/core/src/index.ts"),
      "@cjhyy/code-shell-server/worker": join(cfg.repo, "packages/server/src/index.worker.ts"),
      "@cjhyy/code-shell-cdp": join(cfg.repo, "packages/cdp/src/index.ts"),
      "@cjhyy/code-shell-link": join(cfg.repo, "packages/link/src/index.ts"),
    },
  });
  const load = path => jiti.import(join(cfg.repo, path));
  const { AgentServer } = await load("packages/core/src/protocol/server.ts");
  const { ChatSessionManager } = await load("packages/core/src/protocol/chat-session-manager.ts");
  const { Engine } = await load("packages/core/src/engine/engine.ts");
  const { SessionManager } = await load("packages/core/src/session/session-manager.ts");
  const { LLMClientBase } = await load("packages/core/src/llm/client-base.ts");
  const { registerProvider } = await load("packages/core/src/llm/client-factory.ts");
  const desktop = await jiti.import(cfg.desktopEntry);
  const { createBrowserHandler, bindIpcHandler } = await import(pathToFileURL(cfg.callbacks).href);
  const provider = "owned-browser-stop-round22", sid = "owned-browser-stop-round22-session";
  const providerRequests = [];
  let modelCalls = 0, auxiliaryCalls = 0, currentPlan = null, deliverCore = () => { throw Error("Core transport not ready"); }, lastSnapshotRef;
  class OwnedClient extends LLMClientBase {
    initClient() {}
    async createMessage(options) {
      const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
      providerRequests.push({ at: Date.now(), tools: options.tools?.map(tool => tool.name) ?? [], requestBoundaryId: options.requestBoundaryId ?? null, usagePurpose: options.usagePurpose ?? null, messageCount: options.messages?.length ?? null });
      if (!options.requestBoundaryId) {
        auxiliaryCalls++;
        return { text: "owned auxiliary", toolCalls: [], stopReason: "stop", usage };
      }
      modelCalls++;
      this.recordUsage(usage, options);
      if (!currentPlan) throw Error("unexpected memory provider request");
      if (!options.tools?.some(tool => tool.name === "browser_act")) {
        if (!options.tools?.some(tool => tool.name === "ToolSearch")) throw Error("formal Browser discovery tool is unavailable");
        return { text: "", toolCalls: [{ id: "owned-discover-" + modelCalls, toolName: "ToolSearch", args: { query: "select:browser_observe,browser_act" } }], stopReason: "tool_use", usage };
      }
      const step = currentPlan.steps.shift();
      if (step === "snapshot") return { text: "", toolCalls: [{ id: "owned-observe-" + modelCalls, toolName: "browser_observe", args: { mode: "snapshot" } }], stopReason: "tool_use", usage };
      if (step === "click") {
        if (!lastSnapshotRef) throw Error("actual snapshot ref missing");
        return { text: "", toolCalls: [{ id: "owned-click-" + modelCalls, toolName: "browser_act", args: { action: "click", ref: lastSnapshotRef } }], stopReason: "tool_use", usage };
      }
      return { text: "owned completion", toolCalls: [], stopReason: "stop", usage };
    }
  }
  registerProvider(provider, OwnedClient);
  const sessions = new SessionManager(join(cfg.home, "owned-sessions"));
  const state = sessions.create(cfg.project, "owned-memory-browser-model", provider, sid).state;
  state.origin = "desktop"; state.kind = "work"; state.workspace = { root: cfg.project, kind: "main" };
  if (!sessions.saveState(state)) throw Error("owned Session seed failed");
  // Same registry entry used by native Host runs with a no-repo legacy Session.
  desktop.registerSessionBucket(sid, "__no_repo__::" + sid);

  const instrumentDriver = (driver, label) => {
    // Observational wrappers call the real Puppeteer implementation unchanged;
    // there is no deferred fake Host callback or fabricated wait Promise.
    for (const frame of driver.page.frames()) {
      const existing = frameInstrumentation.get(frame);
      if (existing) { existing.label = label; continue; }
      const instrumentation = { label }; frameInstrumentation.set(frame, instrumentation);
      const original = frame.waitForFunction;
      frame.waitForFunction = function (predicate, options, ...args) {
        const source = String(predicate);
        const entry = { label: instrumentation.label, sequence: ++eventSequence, at: Date.now(), readiness: source.includes('hasAttribute("disabled")') || source.includes("hasAttribute('disabled')"), signalAbortedAtStart: options?.signal?.aborted === true, settled: false, abortedAt: null };
        waits.push(entry);
        options?.signal?.addEventListener("abort", () => { entry.abortedAt = Date.now(); }, { once: true });
        const result = original.call(this, predicate, options, ...args);
        return result.then(value => { entry.settled = true; entry.ok = true; entry.settledAt = Date.now(); return value; }, error => { entry.settled = true; entry.ok = false; entry.detail = String(error); entry.settledAt = Date.now(); throw error; });
      };
    }
    return driver;
  };
  const pool = new desktop.BackgroundBrowserRuntime({ deps: {
    policy: () => desktop.DEFAULT_POLICY,
    openHost: async options => {
      if (options.url !== cfg.targetUrl) throw Error("ONLY_EXACT_OWNED_INITIAL_PAGE_ALLOWED");
      const preferences = desktop.buildWindowOptions(options);
      const win = new BrowserWindow(preferences);
      protect(win.webContents.session); windows.push(win); targetWindows.push(win);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => { if (url !== cfg.targetUrl) event.preventDefault(); });
      win.webContents.on("render-process-gone", (_event, detail) => rendererErrors.push(detail));
      const sendCommand = win.webContents.debugger.sendCommand.bind(win.webContents.debugger);
      win.webContents.debugger.sendCommand = (method, params, sessionId) => {
        if (method.startsWith("Input.")) inputCommands.push({ method, params, sessionId, at: Date.now(), sequence: ++eventSequence });
        return sendCommand(method, params, sessionId);
      };
      await win.loadURL(options.url);
      return { webContents: win.webContents, loadURL: url => win.loadURL(url), executeJavaScript: code => win.webContents.executeJavaScript(code),
        getCookies: async () => [], close: () => { if (!win.isDestroyed()) win.close(); }, show: () => win.show(), hide: () => win.hide(),
        isVisible: () => !win.isDestroyed() && win.isVisible(), onClosed: callback => win.on("closed", callback) };
    },
    createDriver: async wc => {
      const driver = await desktop.getElectronBrowser(wc);
      return instrumentDriver(driver, "actual-adapter");
    },
    resumeDriver: async wc => {
      const driver = await desktop.acquireElectronBrowser(wc);
      return instrumentDriver(driver, "actual-adapter-resumed");
    },
    detach: desktop.releaseElectronBrowser,
  } });
  const runtime = new desktop.DesktopBrowserRuntime({ targetPool: pool });
  const ownerId = desktop.interactiveBrowserRuntimeOwner(sid);
  const seedLease = await runtime.acquire({ ownerId, profileId: sid, visibility: "hidden", initialUrl: cfg.targetUrl });
  const initialSnapshot = await seedLease.bridge.snapshot(); seedLease.release();
  if (!initialSnapshot.elements.some(element => element.name === "Owned action")) throw Error("owned disabled button absent from actual snapshot");
  const target = targetWindows[0];
  const manager = new ChatSessionManager({ runtime: {}, engineFactory: slice => {
    const engine = new Engine({ llm: { provider, model: "owned-memory-browser-model", apiKey: "owned-placeholder", enableStreaming: false },
      sessionStorageDir: sessions.getStorageDir(), cwd: slice.cwd ?? cfg.project, builtinToolHost: "desktop", enabledBuiltinTools: ["browser_observe", "browser_act"],
      permissionMode: "bypassPermissions", maxTurns: 8 });
    engine.hooks.clear();
    const realRun = engine.run.bind(engine);
    engine.run = async (task, options) => {
      const receipt = { task, startedAt: Date.now(), signalAbortedAtStart: options.signal?.aborted === true, signalAbortedAt: null, settled: false };
      options.signal?.addEventListener("abort", () => { receipt.signalAbortedAt = Date.now(); }, { once: true });
      runs.push(receipt);
      const result = await realRun(task, options); receipt.result = result; receipt.settled = true; receipt.settledAt = Date.now(); receipt.settledSequence = ++eventSequence; return result;
    };
    engines.push(engine); return engine;
  } });
  const receiver = {
    // The bridge models a logically live backend. There is no OS worker:
    // sendLine is an owned, in-process replacement for stdio only.
    core: { canSend: () => true, hasChild: () => true, sendLine: line => { const message = JSON.parse(line); protocolInputs.push({ at: Date.now(), message }); deliverCore(message); return true; }, ensureWorker: () => { throw Error("NO_REAL_WORKER_ALLOWED"); } },
    childBrowserLifetime: { register: () => { throw Error("unexpected child activation"); }, release: () => { throw Error("unexpected child release"); } },
    webConfiguration: { runBlocked: false, settleRun: () => {} }, sessionMainRootMigrationClaims: new Map(),
    agentRunMetadataDeps: () => ({ isProjectTrusted: () => false }), sessionsForFallback: () => sessions,
    safeSend: (channel, line) => { for (const win of windows) if (!win.isDestroyed()) win.webContents.send(channel, line); },
  };
  const handleBrowser = createBrowserHandler({ ...desktop,
    dispatchInteractiveBrowserRuntimeAction: async (sessionId, request, _default, child) => {
      const receipt = { at: Date.now(), sessionId, request, settled: false }; browserRequests.push(receipt);
      const json = await desktop.dispatchInteractiveBrowserRuntimeAction(sessionId, request, runtime, child);
      receipt.result = JSON.parse(json); receipt.settled = true; receipt.settledAt = Date.now();
      if (request.action === "snapshot") lastSnapshotRef = receipt.result.elements.find(element => element.name === "Owned action")?.ref;
      return json;
    },
    buildBrowserActionReply: (parsed, json) => { const line = desktop.buildBrowserActionReply(parsed, json); browserReplies.push({ at: Date.now(), parsed, message: JSON.parse(line) }); return line; },
  }).bind(receiver);
  const server = new AgentServer({ chatManager: manager, sessionDiskRoot: sessions.getStorageDir(), transport: {
    onMessage: handler => { deliverCore = handler; }, close() {}, send(message) {
      frames.push({ at: Date.now(), message });
      if (!handleBrowser(JSON.stringify(message))) receiver.safeSend("agent:msg", JSON.stringify(message));
    },
  } });
  bindIpcHandler({ ...desktop, ipcMain, BrowserWindow, dlog: () => {}, ErrorCodes: { Overloaded: -32001 }, previewLine: line => String(line).slice(0, 200) }).call(receiver);
  const control = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { preload: cfg.preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windows.push(control);
  control.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  control.webContents.on("will-navigate", (event, url) => { if (url !== cfg.controlUrl) event.preventDefault(); });
  control.webContents.on("render-process-gone", (_event, detail) => rendererErrors.push(detail));
  await control.loadURL(cfg.controlUrl);
  const targetState = () => target.webContents.executeJavaScript("({disabled:document.getElementById('owned').disabled,hits:window.hits,events:window.actionEvents,url:location.href})");
  let nextRunId = 100, abortControl;
  globalThis.__browserStopReview = {
    sid, controlWindowId: control.id, targetWindowId: target.id,
    startRun: name => {
      if (manager.get(sid)?.isBusy()) throw Error("owned engine unexpectedly busy");
      currentPlan = { name, steps: ["snapshot", "click"] };
      const id = ++nextRunId;
      deliverCore({ jsonrpc: "2.0", id, method: "agent/run", params: { sessionId: sid, task: "Owned browser action: " + name, cwd: cfg.project, clientMessageId: "owned-intent-" + id } });
      return id;
    },
    disable: () => target.webContents.executeJavaScript("document.getElementById('owned').disabled=true"),
    enable: async () => {
      const sequence = ++eventSequence, at = Date.now();
      const domAt = await target.webContents.executeJavaScript("window.enabledAt=Date.now();document.getElementById('owned').disabled=false;window.enabledAt");
      return { sequence, at, domAt };
    },
    targetState,
    async directAbortControl() {
      await target.webContents.executeJavaScript("document.getElementById('owned').disabled=true");
      const original = await desktop.getElectronBrowser(target.webContents);
      abortControl = { controller: new AbortController(), settled: false };
      const driver = new desktop.PuppeteerBrowserDriver(original.page, { signal: abortControl.controller.signal, documentNamespace: "owned-direct-abort-round22" });
      abortControl.driver = instrumentDriver(driver, "direct-AbortSignal-control");
      const snapshot = await driver.snapshot();
      const ref = snapshot.elements.find(element => element.name === "Owned action").ref;
      void driver.click(ref).then(result => { abortControl.result = result; abortControl.settled = true; abortControl.settledAt = Date.now(); });
      return ref;
    },
    abortDirect: () => { abortControl.controller.abort("owned control cancellation"); return Date.now(); },
    releaseActualTarget: () => { desktop.releaseElectronBrowser(target.webContents); return Date.now(); },
    async resumeActualTarget() {
      const lease = await runtime.acquire({ ownerId, profileId: sid, visibility: "hidden" });
      try { return await lease.bridge.resumeControl(); } finally { lease.release(); }
    },
    info: () => ({ electron: process.versions.electron, node: process.version, pathsSetBeforeReady, appName: app.getName(),
      home: process.env.HOME, userData: app.getPath("userData"), sessionData: app.getPath("sessionData"),
      cwd: process.cwd(), tmpdir: process.env.TMPDIR, temp: process.env.TEMP, tmp: process.env.TMP,
      sessionBinding: { project: state.project ?? null, workspace: state.workspace, kind: state.kind, origin: state.origin, legacyUnbound: state.project === undefined },
      browserBinding: { bucket: desktop.bucketForSession(sid), partition: desktop.partitionForSession(sid) },
      loadedWorkspaceModules: Object.keys(jiti.cache).filter(path => path.includes("/packages/") && !path.includes("/node_modules/")),
      networkAttempts, highLevelNetworkAttempts, childAttempts, chromiumRequests, rendererErrors, inputCommands, waits, browserRequests, browserReplies, frames, runs, protocolInputs,
      modelCalls, auxiliaryCalls, providerRequests, busy: manager.get(sid)?.isBusy() ?? false, pendingCount: manager.get(sid)?.pendingApprovals.size ?? 0,
      abortControl: abortControl ? { settled: abortControl.settled, result: abortControl.result, settledAt: abortControl.settledAt, signalAborted: abortControl.controller.signal.aborted } : null,
      windows: windows.filter(win => !win.isDestroyed()).map(win => ({ id: win.id, webContentsId: win.webContents.id, rendererPid: win.webContents.getOSProcessId(), url: win.webContents.getURL(), visible: win.isVisible() })),
    }),
    async shutdown() { await server.close(); for (const engine of engines) await engine.dispose(); abortControl?.driver.dispose(); runtime.closeAll(); for (const win of windows) if (!win.isDestroyed()) win.destroy(); },
  };
}).catch(error => {
  writeFileSync(join(cfg.home, "owned-main-startup-error.json"), JSON.stringify({ name: error.name, message: error.message, stack: error.stack, networkAttempts, highLevelNetworkAttempts, childAttempts }, null, 2));
  console.error("Owned Browser Stop startup failed:", error); app.exit(1);
});
