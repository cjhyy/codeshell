import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-native-smoke-"))
  throw new Error("Use maintained run-isolated-node-smoke.mjs");
const repo = process.cwd(), evidence = dirname(fileURLToPath(import.meta.url));
// Parent imports no Core/Host. Maintained Playwright owns dynamic CDP transport.
const { makeIsolatedElectronHome, launchCodeShellElectron } = await import(
  pathToFileURL(join(repo, "packages/desktop/scripts/electron-harness.mjs")).href
);
const { prepareConfinedElectronFixture } = await import(
  pathToFileURL(join(repo, "packages/desktop/scripts/confined-electron-fixture.mjs")).href
);
const isolated = await makeIsolatedElectronHome("codeshell-model-storage-round20-");
const appDir = join(repo, "packages/desktop"), origin = "http://127.0.0.1:9";
const confined = await prepareConfinedElectronFixture({ appDir, isolated, origin });
// The maintained generated mainEntry imports product Main; it is deliberately
// NOT launched here. Only its maintained scrubbed environment/preimport guard
// bootstrap are reused. This independent owned Main never imports the product.
const html = join(isolated.home, "owned-storage.html");
const mainEntry = join(isolated.home, "owned-storage-main.mjs");
const privateSessionData = join(isolated.home, "electron-session-data");
await mkdir(isolated.userDataDir, { recursive: true });
await mkdir(privateSessionData, { recursive: true });
await writeFile(html, `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'">
<title>Owned storage contract</title><div id="root">Owned storage contract</div>
<script>
// Narrow storage-contract probe. This is not React/ModelPill/the product App.
const key = "codeshell.overrides.model";
let map = JSON.parse(localStorage.getItem(key) || "{}");
const initialMap = structuredClone(map), storageEvents = [];
window.addEventListener("storage", event => storageEvents.push({ key: event.key, newValue: event.newValue }));
window.fixture = {
  snapshot: () => ({ map: structuredClone(map), initialMap, stored: JSON.parse(localStorage.getItem(key) || "{}"),
    storageEvents: structuredClone(storageEvents), url: location.href, origin: location.origin }),
  select: (bucket, model) => { map = { ...map, [bucket]: model }; localStorage.setItem(key, JSON.stringify(map)); },
  lookup: bucket => map[bucket] ?? "fixture-default",
  clear: () => localStorage.removeItem(key),
};
</script>`);
await writeFile(mainEntry, `import { app, BrowserWindow, session, utilityProcess } from "electron";
import children from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
const pathsSetBeforeReady = !app.isReady();
if (!pathsSetBeforeReady) throw new Error("Owned storage fixture requires private paths before app ready");
app.setName("codeshell-owned-model-storage-round20");
app.setPath("userData", ${JSON.stringify(isolated.userDataDir)});
app.setPath("sessionData", ${JSON.stringify(privateSessionData)});
await import(${JSON.stringify(pathToFileURL(join(isolated.home, "guarded-runtime.mjs")).href)});
const networkAttempts = [];
const deniedNetwork = (...args) => {
  networkAttempts.push({ target: String(args[0] ?? "") });
  throw new Error("OWNED_STORAGE_FIXTURE_FORBIDS_DIRECT_NETWORK");
};
net.connect = net.createConnection = deniedNetwork;
tls.connect = deniedNetwork;
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
const childAttempts = [];
const forbiddenChild = name => (...args) => {
  childAttempts.push({ name, command: String(args[0] ?? "") });
  throw new Error("OWNED_STORAGE_FIXTURE_FORBIDS_CHILD_" + name);
};
for (const name of ["spawn", "fork", "exec", "execFile", "spawnSync", "execSync", "execFileSync"])
  children[name] = forbiddenChild(name);
utilityProcess.fork = forbiddenChild("utilityProcess.fork");
syncBuiltinESMExports();
// Playwright's maintained loader releases app.whenReady only after entry load.
// Register the callback and finish entry evaluation instead of top-level await.
void app.whenReady().then(async () => {
const allowedFile = ${JSON.stringify(pathToFileURL(html).href)};
const requests = [], windows = [], rendererErrors = [];
const protect = ses => ses.webRequest.onBeforeRequest((details, callback) => {
  const allowed = details.url === allowedFile;
  requests.push({ url: details.url, allowed });
  callback({ cancel: !allowed });
});
protect(session.defaultSession);
async function createWindow(partition) {
  const preferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true,
    ...(partition ? { partition } : {}) };
  const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: preferences });
  if (partition) protect(win.webContents.session);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => { if (url !== allowedFile) event.preventDefault(); });
  win.webContents.on("render-process-gone", (_event, details) => rendererErrors.push(details));
  windows.push(win);
  await win.loadFile(${JSON.stringify(html)});
  return win.id;
}
globalThis.__ownedStorageReview = {
  createWindow,
  info: () => ({ electron: process.versions.electron, node: process.version,
    userData: app.getPath("userData"), sessionData: app.getPath("sessionData"), home: process.env.HOME,
    codeShellHome: process.env.CODE_SHELL_HOME, appName: app.getName(),
    childAttempts, networkAttempts, pathsSetBeforeReady, requests, rendererErrors,
    windows: windows.filter(win => !win.isDestroyed()).map(win => ({
      id: win.id, webContentsId: win.webContents.id, rendererPid: win.webContents.getOSProcessId(),
      usesDefaultSession: win.webContents.session === session.defaultSession,
      url: win.webContents.getURL(),
    })),
  }),
};
app.on("window-all-closed", () => app.quit());
await createWindow();
}).catch(error => { console.error("Owned storage Main startup failed:", error); app.exit(1); });
`);

let app, assertions = 0, appPid, closeReceipt = null, completed = false, failure = null;
const observations = [], rendererErrors = [];
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
const snapshot = page => page.evaluate(() => window.fixture.snapshot());
const select = (page, bucket, model) => page.evaluate(({ bucket, model }) => window.fixture.select(bucket, model), { bucket, model });
async function ready(page) {
  page.on("pageerror", error => rendererErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.fixture));
  return page;
}
async function createWindow(partition) {
  const [page] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(async (_electron, partition) => globalThis.__ownedStorageReview.createWindow(partition), partition),
  ]);
  return ready(page);
}
let appExited;
try {
  app = await launchCodeShellElectron({ appDir, home: isolated.home, userDataDir: isolated.userDataDir,
    env: confined.env, mainEntry, timeout: 20000 });
  const child = app.process(); appPid = child.pid;
  appExited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const a = await ready(await app.firstWindow());
  const b = await createWindow();
  const guard = await confined.assertWorker(app, { requireWorker: false });
  check(guard.workerCreated === false, "no product agent worker created");
  const firstInfo = await app.evaluate(() => globalThis.__ownedStorageReview.info());
  equal(firstInfo.userData, isolated.userDataDir, "actual Electron userData is private");
  equal(firstInfo.sessionData, privateSessionData, "actual Electron sessionData is private");
  check(firstInfo.pathsSetBeforeReady, "private Electron paths were set before app ready");
  equal(firstInfo.home, isolated.home, "actual Main HOME matches maintained guard");
  check(firstInfo.windows.length === 2 && firstInfo.windows.every(window => window.usesDefaultSession), "two independent BrowserWindow owners use actual defaultSession");
  equal(firstInfo.windows[0].url, firstInfo.windows[1].url, "both load the same owned file URL");
  equal((await snapshot(a)).initialMap, {});
  equal((await snapshot(b)).initialMap, {});
  const bucketA = "project-a::session-a", bucketB = "project-b::session-b";
  await select(a, bucketA, "fixture-alpha");
  await b.waitForFunction(() => window.fixture.snapshot().storageEvents.some(event => event.key === "codeshell.overrides.model"));
  const aSaved = await snapshot(a), bStale = await snapshot(b);
  equal(aSaved.stored, { [bucketA]: "fixture-alpha" });
  equal(bStale.stored, aSaved.stored, "second renderer sees actual shared localStorage");
  equal(bStale.map, {}, "storage event does not mutate unrelated JS snapshot");
  check(bStale.storageEvents.length >= 1, "Chromium emits actual cross-window storage event");
  await select(b, bucketB, "fixture-beta");
  const aAfterB = await snapshot(a), bAfterB = await snapshot(b);
  equal(aAfterB.stored, { [bucketB]: "fixture-beta" }, "B stale whole-map write removes A persisted entry");
  equal(bAfterB.stored, aAfterB.stored);
  equal(aAfterB.map, { [bucketA]: "fixture-alpha" }, "A live JS snapshot still has its chosen value");
  await a.reload(); await a.waitForFunction(() => Boolean(window.fixture));
  const aReloaded = await snapshot(a);
  equal(aReloaded.initialMap, { [bucketB]: "fixture-beta" }, "actual renderer reload reads B-only durable map");
  equal(await a.evaluate(bucket => window.fixture.lookup(bucket), bucketA), "fixture-default", "same nullish lookup expression falls back after real reload");
  observations.push({ scenario: "two-existing-default-session-windows", aSaved, bStale, aAfterB, bAfterB, aReloaded, fallback: "fixture-default" });

  await select(a, bucketA, "fixture-alpha");
  equal((await snapshot(a)).stored, { [bucketB]: "fixture-beta", [bucketA]: "fixture-alpha" }, "reselect restores A alongside current B");
  await a.evaluate(() => window.fixture.clear());
  await a.reload(); await a.waitForFunction(() => Boolean(window.fixture));
  await select(a, bucketA, "fixture-alpha");
  const late = await createWindow();
  const lateOpened = await snapshot(late);
  equal(lateOpened.initialMap, { [bucketA]: "fixture-alpha" }, "late-opened defaultSession renderer reads latest persisted A");
  await select(late, bucketB, "fixture-beta");
  equal((await snapshot(a)).stored, { [bucketA]: "fixture-alpha", [bucketB]: "fixture-beta" }, "late-window whole-map write preserves A");
  await a.reload(); await a.waitForFunction(() => Boolean(window.fixture));
  equal(await a.evaluate(bucket => window.fixture.lookup(bucket), bucketA), "fixture-alpha", "normal late-open control survives actual reload");
  observations.push({ scenario: "normal-late-open-window", lateOpened, afterLateSave: await snapshot(late), aReloaded: await snapshot(a) });

  const partitioned = await createWindow("codeshell-owned-storage-round20-control");
  equal((await snapshot(partitioned)).initialMap, {}, "explicit isolated partition has distinct storage");
  await select(partitioned, "control-only", "fixture-isolated");
  equal((await snapshot(a)).stored, { [bucketA]: "fixture-alpha", [bucketB]: "fixture-beta" }, "separate partition cannot overwrite defaultSession storage");
  const finalInfo = await app.evaluate(() => globalThis.__ownedStorageReview.info());
  equal(finalInfo.windows.filter(window => window.usesDefaultSession).length, 3);
  equal(finalInfo.windows.filter(window => !window.usesDefaultSession).length, 1);
  equal(finalInfo.childAttempts, [], "Node/utility child-start deny guards had no attempts");
  equal(finalInfo.networkAttempts, [], "direct Node network deny guards had no attempts");
  equal(finalInfo.rendererErrors, []);
  equal(rendererErrors, []);
  check(finalInfo.requests.length > 0 && finalInfo.requests.every(request => request.allowed && request.url === pathToFileURL(html).href), "only exact owned file was requested by Chromium");
  completed = true;
  observations.push({ scenario: "explicit-partition-boundary", distinctSession: true, preservedDefaultMap: (await snapshot(a)).stored });
  const result = { scope: "real Electron defaultSession + same owned file storage; independent JS projection; NOT product App/React/ModelPill E2E",
    assertions, appPid, nativeElectron: true, productMainLoaded: false, productPreloadLoaded: false, coreHostImported: false,
    workerCreated: false, actualModelRun: false, guard, firstInfo, finalInfo, observations };
  await writeFile(join(evidence, "native-observations.json"), JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  failure = { name: error.name, message: error.message, stack: error.stack };
  console.error("Owned Electron storage fixture failure:", error);
  process.exitCode = 1;
} finally {
  if (app) {
    try { await app.close(); closeReceipt = await appExited; }
    catch (error) { failure ??= { name: error.name, message: error.message }; process.exitCode = 1; }
  }
  await isolated.cleanup();
  const cleanup = { completed, failure, assertions, appPid, closeReceipt,
    isolatedHome: isolated.home, isolatedHomeRemoved: !existsSync(isolated.home), rendererErrors,
    productMainLoaded: false, productPreloadLoaded: false, coreHostImported: false, actualWorkerModelCliStarted: false };
  await writeFile(join(evidence, "cleanup.json"), JSON.stringify(cleanup, null, 2) + "\n");
  if (completed && !failure && closeReceipt?.code === 0 && closeReceipt.signal === null && cleanup.isolatedHomeRemoved)
    console.log(`Completed owned Electron model-storage round20; ${assertions} Node assertions; defaultSession/same-file native contract only; no product App/Core/worker/model`);
  else process.exitCode = 1;
}
