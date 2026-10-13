/** Manual Native UI phase only: actual Main/preload route and real OS dialog.
 * Does not accept Native readability from detail/AX text, or cover worker RPC.
 * No build/install, provider/model requests, or real credential onboarding. */
/* global window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import {
  bindPrivateKeychainContext,
  readKeychainReference,
} from "./macos-keychain-context.mjs";
import {
  makeNativeBatchManifest,
  nativeBatchIds,
  prepareOperationBatchHome,
} from "./operation-batch-native-fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const saveJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (
    !value ||
    !["--output", "--cancel-mode", "--default-keychain-reference"].includes(flag) ||
    options.has(flag)
  )
    throw new Error(
      "usage: node e2e-operation-batch-native.mjs [--output <new-directory>] [--cancel-mode inspect|enter|escape] [--default-keychain-reference <private-metadata-file>]",
    );
  options.set(flag, value);
}
const cancelMode = options.get("--cancel-mode") ?? "inspect";
assert.ok(["inspect", "enter", "escape"].includes(cancelMode));
// Capture/reference is a separate metadata-only step in the operator context.
// This fixture never enumerates, exports, unlocks or creates a Keychain.
if (process.platform === "darwin" && !options.has("--default-keychain-reference"))
  throw new Error("macOS requires an existing private default-Keychain metadata reference");
const keychainReference =
  process.platform === "darwin"
    ? readKeychainReference(options.get("--default-keychain-reference"))
    : undefined;
const root = options.has("--output")
  ? resolve(options.get("--output"))
  : await mkdtemp(join(tmpdir(), "codeshell-batch-native-"));
if (options.has("--output")) await mkdir(root, { mode: 0o700 });
const directory = await realpath(root);
const evidence = join(directory, "evidence");
await mkdir(evidence, { mode: 0o700 });
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appDir, "../..");
const keepKeys = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SESSION_BUS_PID",
  "GNOME_KEYRING_CONTROL",
  "GNOME_KEYRING_PID",
  "SECURITYSESSIONID",
  "XDG_CURRENT_DESKTOP",
  "WAYLAND_DISPLAY",
];
const environment = {
  ...createBunTestEnvironment(process.env, directory),
  ...Object.fromEntries(
    keepKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  ),
};
if (keychainReference)
  bindPrivateKeychainContext({
    home: environment.HOME,
    root: directory,
    reference: keychainReference,
    receiptFile: join(evidence, "keychain-context.json"),
  });
for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
Object.assign(process.env, environment);
const isolated = {
  home: environment.HOME,
  codeShellHome: environment.CODE_SHELL_HOME,
  userDataDir: join(environment.HOME, "electron-user-data"),
};
const projectRoot = join(isolated.home, "synthetic-project");
const manifest = makeNativeBatchManifest();
await saveJson(join(evidence, "manifest.json"), manifest);
await prepareOperationBatchHome({ ...isolated, projectRoot });
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url, at: Date.now() });
  // No provider/model/action is implemented in this UI-only acceptance.
  request.resume();
  response.writeHead(503, { "content-type": "application/json" });
  response.end('{"error":"Native cancellation phase accepts no requests"}');
});
await new Promise((done, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", done);
});
server.unref();
const origin = `http://127.0.0.1:${server.address().port}`;
const { prepareConfinedElectronFixture } = await import("./confined-electron-fixture.mjs");
const { launchCodeShellElectron, findCodeShellWindow, captureRendererErrors } =
  await import("./electron-harness.mjs");
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin,
  guardModule: new URL("./operation-read-guard.mjs", import.meta.url).href,
});
const sourcePaths = [
  "packages/desktop/src/main/operation-batch-host.ts",
  "packages/desktop/src/main/operation-batch-ipc.ts",
  "packages/desktop/src/preload/operation-batch-api.ts",
  "packages/core/src/links/github-issue-batch.ts",
  "packages/core/src/links/github-create-issue.ts",
  "packages/core/src/operations/session-owner.ts",
  "packages/desktop/scripts/e2e-operation-batch-native.mjs",
  "packages/desktop/scripts/operation-batch-native-fixture.mjs",
  "packages/desktop/scripts/operation-read-guard.mjs",
  "packages/desktop/scripts/confined-electron-fixture.mjs",
  "packages/desktop/scripts/electron-harness.mjs",
  "packages/desktop/scripts/macos-keychain-context.mjs",
  "packages/desktop/scripts/macos-keychain-guard.mjs",
  "packages/desktop/scripts/owned-electron-control.mjs",
  "scripts/runtime-cost-smoke-isolation.mjs",
  "scripts/bun-test-completion.mjs",
];
const sourceFiles = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [path, hash(await readFile(join(repository, path)))]),
  ),
);
// Resolve, hash and compare only; Core is never imported into this controller.
const coreUrl = import.meta.resolve("@cjhyy/code-shell-core");
const coreFiles = {};
for (const name of [
  "index.js",
  "index.internal.js",
  "credentials/store.js",
  "credentials/cipher.js",
])
  coreFiles[name] = hash(await readFile(new URL(name, coreUrl)));
for (const [name, digest] of Object.entries(coreFiles))
  assert.equal(digest, hash(await readFile(join(repository, "packages/core/dist", name))));
const artifacts = Object.fromEntries(
  await Promise.all(
    ["out/main/index.mjs", "out/preload/index.cjs", "out/renderer/index.html"].map(async (path) => [
      path,
      hash(await readFile(join(appDir, path))),
    ]),
  ),
);
await saveJson(join(isolated.home, "operation-read-source.json"), {
  phase: "native-batch-ui-only",
  sourceFiles,
  artifacts,
  hostCore: { entry: await realpath(fileURLToPath(coreUrl)), files: coreFiles },
});
const helperUrl = new URL("./operation-batch-native-fixture.mjs", import.meta.url).href;
const seedInput = { home: isolated.home, projectRoot, origin };
await writeFile(
  fixture.mainEntry,
  (await readFile(fixture.mainEntry, "utf8")) +
    `\nglobalThis.__seedNativeBatchFixture = async () =>
  (await import(${JSON.stringify(helperUrl)})).installOperationBatchNativeFixture(
    await import(${JSON.stringify(coreUrl)}), ${JSON.stringify(seedInput)}
  );\n`,
  { mode: 0o600 },
);
// The controller never imports Core. Its existing HTTP-only guard runs before
// launch; child-process restriction remains the Main/worker guard's boundary.
// Capture only the owned live Electron inspector transport before installing
// that guard, then activate its exact observed websocket exception.
const ownedControl = (await import("./owned-electron-control.mjs")).prepareOwnedElectronControl({
  appDir,
  mainEntry: fixture.mainEntry,
  home: isolated.home,
  receiptFile: join(evidence, "owned-control.jsonl"),
});
const { probeMacosKeychainGuard } = await import("./macos-keychain-guard.mjs");
Object.assign(
  process.env,
  Object.fromEntries(Object.entries(fixture.env).filter(([, value]) => value !== undefined)),
  { CODESHELL_MACOS_ACCEPTANCE_ROOT: directory },
);
fixture.env.CODESHELL_MACOS_ACCEPTANCE_ROOT = undefined;
const parentGuard = await probeMacosKeychainGuard(
  origin,
  join(evidence, "parent-network-guard.jsonl"),
  "parent",
);
assert.equal(parentGuard.negativeProbes, 7);
ownedControl.activate();

let app;
let win;
let child;
let result;
let seed;
let processes;
let nativeWindow;
let stage = "launch guarded production Main";
let failure;
let terminal;
let timedOut = false;
let cleanupForced = false;
let closeObserved = false;
let exitObserved = false;
let streamCompletions = [];
const startedAt = Date.now();
const optionalBytes = async (path) =>
  readFile(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const spawnedWorkers = async () =>
  (await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const ledgerPath = join(isolated.codeShellHome, "sessions/.operations/ledger.json");
const sessionPath = join(isolated.codeShellHome, "sessions", nativeBatchIds.sessionId);
const deadline = setTimeout(() => {
  timedOut = true;
  if (child && !closeObserved) child.kill("SIGTERM");
}, 360_000);
const killDeadline = setTimeout(() => {
  if (child && !closeObserved) child.kill("SIGKILL");
}, 362_000);
try {
  console.log(`Native batch UI evidence: ${evidence}`);
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: fixture.env,
    mainEntry: fixture.mainEntry,
  });
  child = app.process();
  terminal = new Promise((done) => {
    child.once("exit", (code, signal) => {
      exitObserved = true;
      result = { code, signal };
    });
    child.once("close", (code, signal) => {
      closeObserved = true;
      done({ code, signal });
    });
  });
  streamCompletions = ["stdout", "stderr"].map((name) => {
    const stream = createWriteStream(join(evidence, `main-${name}.log`), {
      flags: "wx",
      mode: 0o600,
    });
    const completion = new Promise((done, reject) => {
      stream.once("finish", done);
      stream.once("error", reject);
    });
    if (child[name]) child[name].pipe(stream);
    else stream.end();
    return completion;
  });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1440, height: 980 });
  const fixtureTitle = `CodeShell Native Batch Fixture ${child.pid} ${cancelMode}`;
  nativeWindow = await app.evaluate(
    ({ BrowserWindow }, { title, url }) => {
      const matches = BrowserWindow.getAllWindows().filter(
        (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL() === url,
      );
      if (matches.length !== 1) throw new Error("Native fixture requires one exact renderer window");
      matches[0].setTitle(title);
      return {
        id: matches[0].id,
        title: matches[0].getTitle(),
        webContentsId: matches[0].webContents.id,
      };
    },
    { title: fixtureTitle, url: win.url() },
  );
  console.log(`Actual Electron PID=${child.pid}, window=${nativeWindow.title}; seeding synthetic storage.`);
  // Call only after actual renderer readiness: createWindow has installed the
  // actual AgentBridge, and production startup installed the Main cipher.
  await app.evaluate(() => globalThis.__seedNativeBatchFixture());
  await fixture.assertWorker(app, { requireWorker: false });
  assert.deepEqual(await spawnedWorkers(), [], "Native UI phase requires no actual worker");
  for (let attempt = 0; ; attempt++) {
    const bytes = await optionalBytes(join(isolated.home, "native-batch-main-seed.json"));
    if (bytes) {
      seed = JSON.parse(bytes);
      break;
    }
    if (attempt >= 150) throw new Error("Actual Main synthetic seed did not complete");
    await delay(100);
  }
  assert.equal(seed.pid, child.pid);
  assert.equal(seed.cipherType, "SafeStorageCipher");
  const guardReceipts = (await readFile(join(isolated.home, "operation-read-guard.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const mainGuard = guardReceipts.find((receipt) => receipt.pid === child.pid);
  assert.ok(mainGuard && mainGuard.origin === origin && mainGuard.negativeProbes === 8);
  assert.equal(mainGuard.childNegativeProbes, 3);
  assert.equal(mainGuard.homeId, hash(isolated.home));
  processes = { mainPid: child.pid, parentPid: process.pid, mainGuard, parentGuard, workerPids: [] };
  const beforeLedger = await optionalBytes(ledgerPath);
  if (beforeLedger) assert.deepEqual(JSON.parse(beforeLedger).records, {});
  const beforeState = await readFile(join(sessionPath, "state.json"));
  const beforeTranscript = await readFile(join(sessionPath, "transcript.jsonl"));
  assert.equal(hash(beforeState), seed.stateSha256);
  assert.equal(hash(beforeTranscript), seed.transcriptSha256);
  const connections = await win.evaluate(
    (sessionId) => window.codeshell.operationBatch.options(sessionId),
    nativeBatchIds.sessionId,
  );
  assert.deepEqual(connections.connections, [
    { id: nativeBatchIds.connectionId, label: "Synthetic Native capacity connection" },
  ]);
  assert.equal(requests.length, 0);
  stage = "manual real Native review and cancellation";
  await win.evaluate(
    (proposal) => {
      window.__nativeBatchUiResult = { state: "pending" };
      void window.codeshell.operationBatch.start(proposal).then(
        (value) => {
          window.__nativeBatchUiResult = { state: "resolved", value };
        },
        (error) => {
          window.__nativeBatchUiResult = { state: "rejected", message: String(error) };
        },
      );
    },
    {
      sessionId: nativeBatchIds.sessionId,
      connectionId: nativeBatchIds.connectionId,
      items: manifest.items,
    },
  );
  await saveJson(join(evidence, "manual-review-pending.json"), {
    mainPid: child.pid,
    nativeWindow,
    cancelMode,
    manifestSha256: manifest.manifestSha256,
    manifestBytes: manifest.manifestBytes,
    items: 8,
    markers: manifest.markers,
    invoked: "actual top-frame window.codeshell.operationBatch.start via production preload",
    expectedInteraction:
      cancelMode === "inspect"
        ? "Inspect actual OS display/scroll and all item markers, then choose Cancel."
        : `Use the ${cancelMode === "enter" ? "Enter" : "Escape"} key in the actual OS dialog.`,
    readabilityAccepted: false,
    limitation: "Invocation/whole detail/AX content cannot establish visible reachability or default focus. Root must retain separate actual CUA observations.",
  });
  console.log(`Actual Electron PID=${child.pid}, window=${nativeWindow.title}; Native prompt requested, mode=${cancelMode}. Inspect with CUA and cancel. Never approve this UI-only fixture.`);
  let returned;
  while (!timedOut) {
    returned = await win.evaluate(() => window.__nativeBatchUiResult);
    if (returned.state !== "pending") break;
    await delay(250);
  }
  assert.equal(timedOut, false, "Manual Native phase exceeded its finite deadline");
  assert.equal(returned?.state, "resolved", returned?.message);
  assert.deepEqual(returned.value, { status: "cancelled" });
  assert.deepEqual(await spawnedWorkers(), [], "Cancellation must not spawn a worker");
  assert.equal(requests.length, 0, "Cancellation makes zero loopback model/action requests");
  assert.deepEqual(
    await optionalBytes(ledgerPath),
    beforeLedger,
    "Cancellation reserves zero batches/slots",
  );
  assert.deepEqual(await readFile(join(sessionPath, "state.json")), beforeState);
  assert.deepEqual(await readFile(join(sessionPath, "transcript.jsonl")), beforeTranscript);
  assert.equal(rendererErrors.length, 0, rendererErrors.map((error) => error.message).join("\n"));
  await saveJson(join(evidence, "cancel-result.json"), {
    cancelledThroughProductionRoute: true,
    returned: returned.value,
    requestedInteraction: cancelMode,
    actualInputEvidence: "external CUA observation required",
    readabilityAccepted: false,
    manifestSha256: manifest.manifestSha256,
    manifestBytes: manifest.manifestBytes,
    batchReservations: 0,
    workerRuns: 0,
    createIssueRequests: 0,
    requests,
    seed,
    processes,
  });
  stage = "owned Main shutdown";
} catch (error) {
  failure = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (app && !closeObserved) {
    const close = app.close().catch((error) => {
      failure ??= String(error);
    });
    const closeTimer = setTimeout(() => {
      if (!closeObserved) {
        cleanupForced = true;
        child.kill("SIGTERM");
      }
    }, 10_000);
    const forceTimer = setTimeout(() => {
      if (!closeObserved) {
        cleanupForced = true;
        child.kill("SIGKILL");
      }
    }, 12_000);
    await terminal;
    await close;
    clearTimeout(closeTimer);
    clearTimeout(forceTimer);
  }
  const streamResults = await Promise.allSettled(streamCompletions);
  if (streamResults.some((entry) => entry.status === "rejected"))
    failure ??= "An owned Main output stream did not finish successfully";
  clearTimeout(deadline);
  clearTimeout(killDeadline);
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  const cleanExit = exitObserved && closeObserved && result?.code === 0 && !result?.signal;
  if (!cleanExit || timedOut || cleanupForced || failure) process.exitCode = 1;
  await saveJson(join(evidence, "receipt.json"), {
    phase: "Native UI only",
    passedCancellationAndClosure: !process.exitCode,
    nativeReadability: "pending separate actual CUA review",
    defaultFocusAndKeyInput: "pending separate actual CUA review",
    stage,
    failure,
    cancelMode,
    mainPid: child?.pid,
    nativeWindow,
    parentPid: process.pid,
    node: process.version,
    elapsedMs: Date.now() - startedAt,
    exitObserved,
    closeObserved,
    result,
    timedOut,
    cleanupForced,
    manifestSha256: manifest.manifestSha256,
    requests,
    limitation: "Real Main/preload/native dialog only. No worker batch RPC/version handshake, item approval or write verification accepted. JS fetch/http/https and child-launch guards are not an OS/Chromium/raw-net sandbox. Private HOME shares the existing OS Keychain through metadata-only context.",
  });
  console.log(`Native UI cancellation/closure ${process.exitCode ? "failed" : "recorded"}; evidence retained: ${evidence}`);
}
