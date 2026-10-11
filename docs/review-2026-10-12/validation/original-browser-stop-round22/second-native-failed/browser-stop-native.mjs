import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, symlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-native-smoke-")) throw Error("Use maintained run-isolated-node-smoke.mjs");
const repo = process.cwd(), evidence = dirname(fileURLToPath(import.meta.url)), appDir = join(repo, "packages/desktop");
const requireRepo = createRequire(join(repo, "package.json")), requireDesktop = createRequire(join(appDir, "package.json"));
const { makeIsolatedElectronHome, launchCodeShellElectron } = await import(pathToFileURL(join(appDir, "scripts/electron-harness.mjs")).href);
const { prepareConfinedElectronFixture } = await import(pathToFileURL(join(appDir, "scripts/confined-electron-fixture.mjs")).href);
const isolated = await makeIsolatedElectronHome("codeshell-browser-stop-round22-");
let preparationComplete = false;
try {
const confined = await prepareConfinedElectronFixture({ appDir, isolated, origin: "http://127.0.0.1:9" });
const esbuildPath = join(repo, "node_modules/.bun/esbuild@0.27.7/node_modules/esbuild/lib/main.js");
const esbuild = requireRepo(esbuildPath), ts = requireRepo("typescript");
const sourceFiles = ["packages/core/src/protocol/server.ts", "packages/core/src/protocol/server-run-controls.ts", "packages/core/src/protocol/chat-session.ts", "packages/core/src/engine/engine.ts", "packages/core/src/tool-system/builtin/browser-tools.ts", "packages/desktop/src/main/agent-bridge.ts", "packages/desktop/src/preload/index.ts", "packages/desktop/src/main/browser-runtime/dispatch.ts", "packages/desktop/src/main/browser-runtime/runtime.ts", "packages/desktop/src/main/browser-driver/background-runtime.ts", "packages/desktop/src/main/browser-driver/electron-puppeteer.ts", "packages/desktop/src/browser-library/puppeteer-browser-driver.ts"];
const manifest = [];
for (const source of sourceFiles) { const text = await readFile(join(repo, source), "utf8"); manifest.push({ source, sha256: createHash("sha256").update(text).digest("hex") }); }
const targetHtml = join(isolated.home, "owned-target.html"), controlHtml = join(isolated.home, "owned-control.html"), mainEntry = join(isolated.home, "owned-main.mjs");
const preload = join(isolated.home, "actual-preload.cjs"), callbacks = join(isolated.home, "actual-main-callbacks.mjs"), sessionData = join(isolated.home, "session-data"), project = join(isolated.home, "owned-project"), temp = join(isolated.home, "tmp");
await Promise.all([mkdir(isolated.userDataDir, { recursive: true }), mkdir(sessionData), mkdir(project), mkdir(temp), mkdir(join(isolated.home, "node_modules"))]);
for (const name of ["puppeteer-core", "playwright"]) await symlink(dirname(requireDesktop.resolve(name + "/package.json")), join(isolated.home, "node_modules", name));
await writeFile(targetHtml, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'"><title>Owned disabled action</title><button id="owned" disabled style="width:180px;height:50px">Owned action</button><script>window.hits=0;window.actionEvents=[];document.getElementById('owned').addEventListener('click',()=>{window.hits++;window.actionEvents.push({at:Date.now(),hits:window.hits});});</script>`);
await writeFile(controlHtml, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'"><title>Owned native Stop transport</title><div>Owned native Stop transport</div>`);
// Local source transpilation only. No install, product build/dist clean, or
// product output is written. esbuild may run its installed local service.
const desktopEntry = join(isolated.home, "desktop-fixture-entry.ts");
const exports = [
  ["DesktopBrowserRuntime", "packages/desktop/src/main/browser-runtime/runtime.ts"],
  ["BackgroundBrowserRuntime", "packages/desktop/src/main/browser-driver/background-runtime.ts"],
  ["getElectronBrowser, acquireElectronBrowser, releaseElectronBrowser", "packages/desktop/src/main/browser-driver/electron-puppeteer.ts"],
  ["PuppeteerBrowserDriver", "packages/desktop/src/browser-library/puppeteer-browser-driver.ts"],
  ["dispatchInteractiveBrowserRuntimeAction, interactiveBrowserRuntimeOwner", "packages/desktop/src/main/browser-runtime/dispatch.ts"],
  ["activateChildBrowserRuntime, releaseChildBrowserRuntime", "packages/desktop/src/main/browser-runtime/dispatch.ts"],
  ["parseBrowserActionLine, buildBrowserActionReply", "packages/desktop/src/main/browser-driver/intercept.ts"],
  ["prepareAgentRunMetadata, AgentRunMetadataError", "packages/desktop/src/main/agent-run-metadata.ts"],
  ["quickChatRunSessionId, quickChatRunRequest, quickChatForkRequest, forkSourceSessionId, compactQuerySessionId, buildNoChildFallbackReply", "packages/desktop/src/main/agent-bridge-fallback.ts"],
  ["isOptimizationLabQuery", "packages/desktop/src/shared/optimization-lab.ts"],
  ["DEFAULT_POLICY", "packages/desktop/src/main/browser-driver/policy.ts"],
  ["registerSessionBucket, bucketForSession, partitionForSession", "packages/desktop/src/main/browser-driver/active-guest.ts"],
  ["buildWindowOptions", "packages/desktop/src/main/browser-host/index.ts"],
];
await writeFile(desktopEntry, exports.map(([names, path]) => `export { ${names} } from ${JSON.stringify(join(repo, path))};`).join("\n"));
const buildCommon = { bundle: true, platform: "node", target: "node20", logLevel: "warning", absWorkingDir: repo, external: ["electron", "playwright", "puppeteer-core", "puppeteer-core/*"] };
esbuild.buildSync({ ...buildCommon, entryPoints: [join(repo, "packages/desktop/src/preload/index.ts")], format: "cjs", outfile: preload });
const bridge = await readFile(join(repo, "packages/desktop/src/main/agent-bridge.ts"), "utf8");
const browserStart = bridge.indexOf("  private maybeHandleBrowserAction(line: string): boolean {"), browserEnd = bridge.indexOf("\n  /** Intercept the worker's `agent/cronChanged`", browserStart);
const ipcStart = bridge.indexOf('    ipcMain.on("agent:msg",'), ipcEnd = bridge.indexOf('\n    ipcMain.on(\n      "desktop:log",', ipcStart);
if ([browserStart, browserEnd, ipcStart, ipcEnd].some(value => value < 0)) throw Error("maintained Main markers changed");
const names = [...new Set(exports.flatMap(([names]) => names.split(/,\s*/))), "ipcMain", "BrowserWindow", "dlog", "ErrorCodes", "previewLine"];
const destructure = `const {${names.join(",")}} = deps;`;
const source = `export function createBrowserHandler(deps){${destructure}\nreturn ${bridge.slice(browserStart, browserEnd).replace("  private maybeHandleBrowserAction", "function maintainedBrowserAction")};}\nexport function bindIpcHandler(deps){${destructure}\nreturn function maintainedIpcBinding(){\n${bridge.slice(ipcStart, ipcEnd)}\n};}`;
await writeFile(callbacks, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
await writeFile(mainEntry, await readFile(join(evidence, "owned-main-template.mjs")));
const config = { repo, home: isolated.home, userData: isolated.userDataDir, sessionData, project, temp, targetUrl: pathToFileURL(targetHtml).href, controlUrl: pathToFileURL(controlHtml).href,
  preload, desktopEntry, callbacks, jitiEntry: join(repo, "node_modules/.bun/jiti@2.7.0/node_modules/jiti/lib/jiti.mjs") };
await writeFile(join(isolated.home, "review-config.json"), JSON.stringify(config, null, 2));
await writeFile(join(evidence, "source-manifest.json"), JSON.stringify({ repo, manifest, config, esbuildPath, compilation: buildCommon, productOutputsWritten: false }, null, 2));
preparationComplete = true;

let app, appExited, appPid, closeReceipt = null, assertions = 0, completed = false, failure = null;
const cleanupErrors = [];
const nativeStdout = [], nativeStderr = [];
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
const observations = [];
const info = () => app.evaluate(() => globalThis.__browserStopReview.info());
const call = (method, arg) => app.evaluate(async (_electron, { method, arg }) => globalThis.__browserStopReview[method](arg), { method, arg });
async function until(read, label, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error(label); }
try {
  if (process.argv.includes("--prepare-only")) {
    console.log("Prepared owned round22 fixture only: " + isolated.home);
    console.log("No Electron/Core/provider was executed. Prepared files retained for root review.");
    process.exitCode = 0;
  } else {
    app = await launchCodeShellElectron({ appDir, home: isolated.home, userDataDir: isolated.userDataDir, env: { ...confined.env, TMPDIR: temp, TMP: temp, TEMP: temp }, mainEntry, timeout: 60000 });
    const child = app.process(); appPid = child.pid;
    child.stdout?.on("data", chunk => nativeStdout.push(String(chunk)));
    child.stderr?.on("data", chunk => nativeStderr.push(String(chunk)));
    appExited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    await app.firstWindow({ timeout: 60000 });
    await until(() => app.evaluate(() => Boolean(globalThis.__browserStopReview)), "owned Main startup incomplete", 60000);
    const start = await info();
    const control = app.windows().find(page => page.url() === config.controlUrl);
    check(Boolean(control), "actual preload controller window is available");
    await control.waitForFunction(() => typeof window.codeshell?.cancel === "function");
    const guard = await confined.assertWorker(app, { requireWorker: false });
    equal(guard.workerCreated, false, "no CodeShell worker created");
    equal(start.home, isolated.home); equal(start.userData, isolated.userDataDir); equal(start.sessionData, sessionData); check(start.pathsSetBeforeReady);
    equal(start.cwd, project); equal(start.tmpdir, temp); equal(start.tmp, temp); equal(start.temp, temp);
    equal(start.sessionBinding.legacyUnbound, true, "legitimate persisted legacy Session has no project binding requiring Host WorkspaceContext");
    equal(start.browserBinding.bucket, "__no_repo__::owned-browser-stop-round22-session"); check(Boolean(start.browserBinding.partition), "actual Session browser registry resolves a profile");
    equal((await call("targetState")).hits, 0); equal((await call("targetState")).disabled, true);
    const runId = await call("startRun", "cancel-before-disabled-button-ready");
    await until(async () => { const value = await info(); return value.browserRequests.some(request => request.request.action === "click" && !request.settled) && value.waits.some(wait => wait.label === "actual-adapter" && wait.readiness && !wait.settled) && value.pendingCount === 1; }, "actual driver readiness wait not reached");
    const preStop = await info(), preStopTarget = await call("targetState");
    equal(preStopTarget.disabled, true); equal(preStopTarget.hits, 0); equal(preStop.inputCommands.length, 0, "no input command submitted before Stop"); check(preStop.busy); equal(preStop.pendingCount, 1);
    const stopStartedAt = Date.now();
    const stopResult = await control.evaluate(sid => window.codeshell.cancel(sid), await app.evaluate(() => globalThis.__browserStopReview.sid));
    equal(stopResult, { ok: true }, "actual preload/native IPC/Main callback/Core Cancel succeeded");
    await until(async () => { const value = await info(); return !value.busy && value.runs[0]?.settled && value.pendingCount === 0; }, "Core did not settle cancellation");
    const postStop = await info(), stillDisabled = await call("targetState");
    equal(stillDisabled.disabled, true); equal(stillDisabled.hits, 0); equal(postStop.inputCommands.length, 0); equal(postStop.pendingCount, 0); equal(postStop.busy, false);
    check(postStop.runs[0].signalAbortedAt !== null, "actual ChatSession run signal aborted");
    check(postStop.runs[0].result.reason.startsWith("aborted"), "actual Engine result is an abort outcome");
    check(postStop.browserRequests.some(request => request.request.action === "click" && !request.settled), "Main click remains in natural readiness wait after settled Core Stop");
    check(postStop.waits.some(wait => wait.label === "actual-adapter" && wait.readiness && !wait.settled && wait.abortedAt === null), "target driver readiness signal remains live");
    const enabled = await call("enable"), enabledAt = enabled.domAt;
    await until(async () => (await call("targetState")).hits === 1, "owned old click did not arrive after enable");
    await until(async () => (await info()).browserReplies.some(reply => reply.parsed.request.action === "click"), "late Main Browser reply missing");
    const afterEnable = await info(), afterEnableTarget = await call("targetState");
    equal(afterEnableTarget.hits, 1); check(afterEnableTarget.events[0].at >= enabledAt); check(afterEnable.inputCommands.length > 0);
    check(afterEnable.inputCommands.every(command => command.at >= enabledAt && command.sequence > enabled.sequence), "all old Input commands happened after enable and successful Stop");
    check(enabled.sequence > postStop.runs[0].settledSequence, "logical event order proves enable after actual Core run settled even within one millisecond");
    equal(afterEnable.modelCalls, postStop.modelCalls, "late Host success did not resume the old Engine"); equal(afterEnable.busy, false); equal(afterEnable.pendingCount, 0);
    const clickReply = afterEnable.browserReplies.find(reply => reply.parsed.request.action === "click");
    equal(clickReply.message.params.decision.approved, true); check(JSON.parse(clickReply.message.params.decision.answer).ok, "actual Browser action returned late success");
    await until(async () => (await info()).frames.some(frame => frame.message.id === clickReply.message.id && frame.message.error), "late approve rejection missing");
    observations.push({ scenario: "formal-Core-Stop-before-real-Puppeteer-ready", runId, stopStartedAt, stopResult, preStop, preStopTarget, postStop, stillDisabled, enabled, afterEnable: await info(), afterEnableTarget });

    const directStart = (await info()).waits.length, inputBeforeDirect = (await info()).inputCommands.length;
    await call("directAbortControl");
    await until(async () => (await info()).waits.slice(directStart).some(wait => wait.label === "direct-AbortSignal-control" && wait.readiness && !wait.settled), "direct AbortSignal ready not reached");
    const directAbortedAt = await call("abortDirect");
    await until(async () => (await info()).abortControl?.settled, "driver AbortSignal did not stop waiting action");
    const directSettled = await info(); check(directSettled.abortControl.signalAborted); equal(directSettled.abortControl.result.ok, false);
    await call("enable"); await new Promise(resolve => setTimeout(resolve, 150));
    equal((await call("targetState")).hits, 1, "native driver AbortSignal blocks the unsubmitted click"); equal((await info()).inputCommands.length, inputBeforeDirect);
    observations.push({ scenario: "normal-real-driver-AbortSignal-cancels-ready-with-page-alive", directAbortedAt, directSettled, target: await call("targetState") });

    const normalId = await call("startRun", "intentional-new-user-turn-after-Stop");
    await until(async () => { const value = await info(); return value.frames.some(frame => frame.message.id === normalId) && !value.busy; }, "new normal turn did not complete");
    const normal = await info(); equal((await call("targetState")).hits, 2, "new authorized turn uses retained target normally");
    const normalReply = normal.frames.find(frame => frame.message.id === normalId).message;
    check(!normalReply.error); equal(normalReply.result.reason, "completed");
    const completedInputCount = normal.inputCommands.length;
    equal(await control.evaluate(sid => window.codeshell.cancel(sid), await app.evaluate(() => globalThis.__browserStopReview.sid)), { ok: true });
    equal((await call("targetState")).hits, 2, "Stop after committed action does not roll back past side effect"); equal((await info()).inputCommands.length, completedInputCount);
    observations.push({ scenario: "normal-new-turn-and-already-committed-action-boundary", normalId, normalReply, normal, afterIdleStop: await info() });

    const final = await info(); equal(final.networkAttempts, []); equal(final.highLevelNetworkAttempts, []); equal(final.childAttempts, []); equal(final.rendererErrors, []);
    for (const path of ["packages/core/src/protocol/server.ts", "packages/core/src/engine/engine.ts", "packages/desktop/src/main/browser-runtime/runtime.ts", "packages/desktop/src/main/browser-driver/background-runtime.ts", "packages/desktop/src/main/browser-driver/electron-puppeteer.ts", "packages/desktop/src/browser-library/puppeteer-browser-driver.ts"]) check(final.loadedWorkspaceModules.includes(join(repo, path)), "critical actual source was loaded: " + path);
    check(final.loadedWorkspaceModules.every(path => path.startsWith(repo + "/") && !path.includes("/dist/")), "jiti workspace modules resolve to the frozen source, not product dist or operator checkout");
    check(final.chromiumRequests.length > 0 && final.chromiumRequests.every(request => request.allowed && [config.targetUrl, config.controlUrl].includes(request.url)), "Chromium requested only exact owned files");
    check(final.windows.length === 2 && final.windows.every(window => !window.visible), "only two owned hidden windows exist");
    completed = true;
    await writeFile(join(evidence, "native-observations.json"), JSON.stringify({ scope: "actual Core/Engine memory provider + actual preload/native IPC + source-extracted Main callbacks + actual runtime/adapter/Puppeteer/owned Chromium DOM; NOT full product App/worker/Chrome", assertions, appPid, guard, config, manifest, observations, final }, null, 2));
  }
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
  if (app) {
    try { await Promise.race([call("shutdown"), new Promise((_resolve, reject) => setTimeout(() => reject(Error("OWNED_SHUTDOWN_TIMEOUT")), 10000))]); }
    catch (error) { cleanupErrors.push({ stage: "shutdown", message: String(error) }); failure ??= { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
    // Closing the native app is independent of Core/runtime shutdown success.
    try { await app.close(); }
    catch (error) { cleanupErrors.push({ stage: "app.close", message: String(error) }); failure ??= { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
    closeReceipt = await Promise.race([appExited, new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
    if (!closeReceipt) {
      cleanupErrors.push({ stage: "owned-main-force-close", pid: appPid });
      app.process().kill("SIGTERM");
      closeReceipt = await Promise.race([appExited, new Promise(resolve => setTimeout(() => resolve(null), 2000))]);
      if (!closeReceipt) { app.process().kill("SIGKILL"); closeReceipt = await Promise.race([appExited, new Promise(resolve => setTimeout(() => resolve(null), 2000))]); }
      failure ??= { name: "CleanupError", message: "Owned Electron required forced close" }; process.exitCode = 1;
    }
  }
  const prepareOnly = process.argv.includes("--prepare-only");
  if (!prepareOnly) {
    await writeFile(join(evidence, "owned-native-stdout.log"), nativeStdout.join(""));
    await writeFile(join(evidence, "owned-native-stderr.log"), nativeStderr.join(""));
    const startupError = await readFile(join(isolated.home, "owned-main-startup-error.json"), "utf8").catch(() => null);
    if (startupError) await writeFile(join(evidence, "owned-main-startup-error.json"), startupError);
  }
  if ((!prepareOnly || failure) && (!app || closeReceipt)) await isolated.cleanup();
  const cleanup = { completed, prepareOnly, failure, assertions, appPid, closeReceipt, cleanupErrors, isolatedHome: isolated.home, isolatedHomeRemoved: !existsSync(isolated.home), productMainLoaded: false, actualWorkerModelCliStarted: false };
  await writeFile(join(evidence, prepareOnly ? "prepare-receipt.json" : "cleanup.json"), JSON.stringify(cleanup, null, 2));
  if (completed && !failure && closeReceipt?.code === 0 && closeReceipt.signal === null && cleanup.isolatedHomeRemoved) console.log(`Completed owned Browser Stop round22; ${assertions} Node assertions; no real worker/model/CLI/operator Chrome/network`);
  else if (!prepareOnly) process.exitCode = 1;
}
} catch (error) {
  // Preparation has not launched Electron. Unexpected failures after that
  // phase preserve the private directory rather than delete a possibly live
  // native process's state; the ordinary native finally handles known apps.
  if (!preparationComplete) await isolated.cleanup();
  await writeFile(join(evidence, "prepare-failed-receipt.json"), JSON.stringify({ completed: false, phase: preparationComplete ? "unexpected-post-preparation" : "preparation", failure: { name: error.name, message: error.message, stack: error.stack }, isolatedHome: isolated.home, isolatedHomeRemoved: !existsSync(isolated.home), electronMayHaveLaunched: preparationComplete }, null, 2));
  throw error;
}
