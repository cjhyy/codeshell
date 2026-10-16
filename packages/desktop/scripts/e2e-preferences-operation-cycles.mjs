/* Actual compiled Electron windows and preference controls; no worker/account use.
 * nativeTheme affects only this owned process, not the operator's OS appearance.
 * Run with run-isolated-node-smoke.mjs and --evidence-dir <new outside directory>. */
/* global document, localStorage, window */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureRendererErrors,
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import { getElectronKeychainPreflightDiagnostic } from "./electron-keychain-preflight.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated native smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.equal(process.argv.length, 4, "Expected --evidence-dir <new-directory>");
assert.equal(process.argv[2], "--evidence-dir");
const evidence = resolve(process.argv[3]);
const outside = relative(await realpath(process.env.HOME), evidence);
assert.ok(isAbsolute(outside) || outside === ".." || outside.startsWith(`..${sep}`));
await mkdir(evidence, { mode: 0o700 });
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-preferences-native-");
const privateRelative = relative(await realpath(process.env.HOME), isolated.home);
assert.ok(
  isAbsolute(privateRelative) || privateRelative === ".." || privateRelative.startsWith(`..${sep}`),
  "The private native HOME must survive the outer runner on failure",
);
const project = join(isolated.home, "owned-project");
await mkdir(project, { mode: 0o700 });
children.execFileSync("git", ["init", "--quiet", project], { timeout: 5_000 });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const write = async (file, value) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
};
const operations = [],
  processes = [],
  failures = [],
  rendererErrors = [],
  observerFailures = [];
const receipt = {
  fixture: "native-preferences-operation-cycles",
  status: "failed",
  platform: process.platform,
  arch: process.arch,
  privateHome: isolated.home,
  privateHomeRemoved: false,
  operations,
  processes,
  boundary:
    "Production Electron/Main/preload/renderer; nativeTheme overrides only owned process Chromium media, not the user's OS appearance; no native crypto or account acceptance",
};
let app, win, active, fixture;
let stage = "prepare";
async function bounded(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const mainState = () => app.evaluate(() => ({ ...globalThis.__preferenceOperations }));
async function assertGuard() {
  const state = await mainState();
  assert.equal(state.networkAttempts, 0);
  assert.equal(state.forbiddenWorkers, 0);
  assert.equal(state.coreTurnAttempts, 0);
  assert.equal(state.cryptoAttempts, 0);
  return state;
}
async function observe(page) {
  rendererErrors.push(captureRendererErrors(page));
  page.setDefaultTimeout(10_000);
  await page.waitForFunction(() => typeof window.codeshell?.newWindow === "function");
  await page.evaluate(() => {
    window.__preferenceEvents = { storage: [], media: [] };
    window.addEventListener("storage", (event) => {
      if (["codeshell.uiLanguage", "codeshell.theme"].includes(event.key))
        window.__preferenceEvents.storage.push({ key: event.key, newValue: event.newValue });
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      window.__preferenceEvents.media.push(event.matches);
    });
  });
}
const current = (page = win) =>
  page.evaluate(() => ({
    language: localStorage.getItem("codeshell.uiLanguage"),
    mode: localStorage.getItem("codeshell.theme"),
    dark: document.documentElement.classList.contains("dark"),
    mediaDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    url: window.location.href,
    origin: window.location.origin,
    events: window.__preferenceEvents,
  }));
async function frames(page = win) {
  await page.evaluate(
    () =>
      new Promise((done) => window.requestAnimationFrame(() => window.requestAnimationFrame(done))),
  );
}
async function general(page = win) {
  const back = page.getByRole("button", { name: /^(返回应用|Back to app)$/ });
  if (await back.isVisible()) await back.click();
  await navigateSettingsMenu(page, /^(设置|Settings)$/);
  await page
    .getByRole("navigation", { name: /^(设置导航|Settings navigation)$/ })
    .getByRole("button", { name: /^(常规|General)$/ })
    .click();
  await page.getByRole("heading", { name: /^(语言|Language)$/ }).waitFor();
}
async function viewOnly(page = win) {
  const dialog = page.getByRole("dialog", { name: /^(信任此项目？|Trust this project\?)$/ });
  if (
    !(await dialog.waitFor({ state: "visible", timeout: 2_000 }).then(
      () => true,
      () => false,
    ))
  )
    return;
  assert.ok(
    (await dialog.innerText()).includes(isolated.home),
    "Only an owned fixture directory may be decided",
  );
  await dialog
    .getByRole("button", { name: /^(仅查看\(拒绝写工具\)|View only \(deny write tools\))$/ })
    .click();
  await dialog.waitFor({ state: "hidden" });
}
async function appearance(page = win) {
  await page
    .getByRole("navigation", { name: /^(设置导航|Settings navigation)$/ })
    .getByRole("button", { name: /^(外观|Appearance)$/ })
    .click();
  await page.locator("[data-theme-mode]").first().waitFor();
}
async function english(page = win) {
  await page.getByRole("heading", { name: "Language", exact: true }).waitFor();
  assert.equal(
    (await page.getByRole("button", { name: /^English/ }).getAttribute("class"))
      .split(/\s+/)
      .includes("ring-1"),
    true,
  );
  assert.equal((await current(page)).language, "en");
}
async function nativeMode(mode) {
  const before = (await current()).events.media.length;
  const native = await app.evaluate(({ nativeTheme }, value) => {
    nativeTheme.themeSource = value;
    return { source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors };
  }, mode);
  assert.equal(native.source, mode);
  assert.equal(native.dark, mode === "dark");
  await win.waitForFunction(
    (dark) =>
      window.matchMedia("(prefers-color-scheme: dark)").matches === dark &&
      window.__preferenceEvents.media.at(-1) === dark,
    mode === "dark",
  );
  await frames();
  const after = await current();
  assert.equal(after.events.media.length, before + 1, "Expected one actual Chromium media event");
  return { native, renderer: after };
}
async function operation(action, run) {
  stage = action;
  const result = await run();
  await assertGuard();
  operations.push({ action, result });
  await write(join(evidence, "operations.json"), operations);
}
async function launch() {
  stage = `cold Main ${processes.length + 1}: launch`;
  const processProof = { cycle: processes.length + 1, logs: { stdout: "", stderr: "" } };
  processes.push(processProof);
  active = { proof: processProof };
  const executable = await realpath(createRequire(import.meta.url)("electron"));
  const originalSpawn = children.spawn;
  children.spawn = function (command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (command === executable && options?.env?.HOME === isolated.home) {
      assert.equal(active.child, undefined, "Exactly one owned Main may be captured per launch");
      active.child = child;
      active.closed = new Promise((done) =>
        child.once("close", (code, signal) => done({ code, signal })),
      );
      child.once("error", () => observerFailures.push("Owned Electron spawn error"));
      for (const stream of ["stdout", "stderr"])
        child[stream]?.on("data", (chunk) => {
          processProof.logs[stream] = (processProof.logs[stream] + chunk).slice(-1024 * 1024);
        });
      active.monitor = watchElectronTestProcess(child, {
        timeoutMs: 180_000,
        reportFailure: (message) => observerFailures.push(message),
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    app = await launchCodeShellElectron(
      { appDir, ...isolated, mainEntry: fixture.mainEntry, env: fixture.env },
      {
        watch: () => {},
        // Playwright otherwise forces light and hides nativeTheme media updates.
        launch: async (options) =>
          (await import("playwright"))._electron.launch({
            ...options,
            colorScheme: null,
          }),
      },
    );
  } finally {
    children.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(active.child, app.process(), "Early watcher must bind this Main");
  processProof.pid = active.child.pid;
  stage = `cold Main ${processProof.cycle}: renderer ready`;
  await findCodeShellWindow(app);
  win = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(win, "Actual workbench renderer must exist");
  assert.equal(
    new URL(win.url()).pathname,
    new URL(pathToFileURL(join(appDir, "out/renderer/index.html"))).pathname,
  );
  await observe(win);
  stage = `cold Main ${processProof.cycle}: runtime metadata`;
  processProof.runtime = await app.evaluate(({ app, nativeTheme }) => ({
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
    platform: process.platform,
    arch: process.arch,
    nativeSource: nativeTheme.themeSource,
  }));
  assert.equal(processProof.runtime.appPath, appDir);
  assert.equal(processProof.runtime.userData, isolated.userDataDir);
  assert.equal(processProof.runtime.nativeSource, "light");
  stage = `cold Main ${processProof.cycle}: confinement`;
  processProof.confinement = await fixture.assertWorker(app, { requireWorker: false });
  assert.equal(processProof.confinement.workerCreated, false);
  await assertGuard();
  await win.setViewportSize({ width: 1440, height: 960 });
  stage = `cold Main ${processProof.cycle}: owned project read-only navigation`;
  await viewOnly();
  const back = win.getByRole("button", { name: /^(返回应用|Back to app)$/ });
  if (await back.isVisible()) await back.click();
  await expandSidebar(win);
  await win
    .locator("aside")
    .getByRole("button", { name: "Owned preference project", exact: true })
    .click();
  await viewOnly();
  stage = `cold Main ${processProof.cycle}: General settings`;
  await general();
}
async function close() {
  const resource = active;
  const application = app;
  active = app = win = undefined;
  if (!resource) return;
  try {
    if (application) {
      resource.proof.finalState = await bounded(
        application.evaluate(() => ({ ...globalThis.__preferenceOperations })),
        5_000,
        "Main state unavailable before close",
      );
      await bounded(application.close(), 8_000, "Owned Electron graceful close timed out");
    }
  } catch (error) {
    failures.push({ stage: "close", message: error.message });
  } finally {
    if (resource.monitor) {
      resource.proof.settlement = await resource.monitor.terminate();
      if (resource.proof.settlement.status !== "cleaned")
        failures.push({ stage: "cleanup", message: "Owned Main exit is unproven" });
      else {
        try {
          assert.equal(resource.proof.settlement.remainingCount, 0);
          assert.deepEqual(resource.proof.settlement.remaining, []);
          assert.equal(resource.proof.settlement.queryFailed, false);
          resource.proof.exit = await bounded(
            resource.closed,
            3_000,
            "Main close event unavailable",
          );
          assert.deepEqual(resource.proof.exit, { code: 0, signal: null });
        } catch (error) {
          failures.push({ stage: "close", message: error.message });
        }
      }
    } else
      failures.push({ stage: "cleanup", message: "Owned Main identity was never established" });
    if (resource.proof.settlement?.status !== "cleaned") {
      resource.child?.unref();
      resource.child?.stdout?.unref?.();
      resource.child?.stderr?.unref?.();
    }
  }
}
try {
  const bundle = (await readdir(join(appDir, "out/renderer/assets"))).find((file) =>
    /^SettingsPage-.*\.js$/.test(file),
  );
  assert.ok(bundle, "Own compiled SettingsPage is required");
  const rendererHTML = await readFile(join(appDir, "out/renderer/index.html"), "utf8");
  const rendererEntry = rendererHTML.match(/src="\.\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)?.[1];
  assert.ok(rendererEntry, "Own compiled renderer entry is required");
  receipt.build = {
    sourceHead: children
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8", timeout: 5_000 })
      .trim(),
    fixtureSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
    mainSHA256: hash(await readFile(join(appDir, "out/main/index.mjs"))),
    preloadSHA256: hash(await readFile(join(appDir, "out/preload/index.cjs"))),
    rendererHTMLSHA256: hash(rendererHTML),
    rendererEntrySHA256: hash(await readFile(join(appDir, "out/renderer/assets", rendererEntry))),
    settingsBundleSHA256: hash(await readFile(join(appDir, "out/renderer/assets", bundle))),
  };
  await write(join(isolated.codeShellHome, "settings.json"), { autoUpdates: false });
  await write(join(isolated.codeShellHome, "desktop/recents.json"), [
    { path: project, name: "Owned preference project", lastOpenedAt: Date.now() },
  ]);
  const guard = join(isolated.home, "preference-guard.mjs");
  await write(
    guard,
    `
import children from "node:child_process";
import http from "node:http";
import https from "node:https";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
await import(${JSON.stringify(new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href)});
const state = globalThis.__preferenceOperations = { networkAttempts:0, forbiddenWorkers:0, coreTurnAttempts:0, cryptoAttempts:0, newWindows:0, nativeThemeEvents:[], rendererLoads:[] };
const attempt = kind => appendFileSync(${JSON.stringify(join(isolated.home, "denied-attempts.jsonl"))}, JSON.stringify({pid:process.pid, kind}) + "\\n", {mode:0o600});
const deny = () => { state.networkAttempts++; attempt("network"); throw new Error("Preference fixture denies network"); };
globalThis.fetch = deny;
for (const transport of [http, https]) { transport.request = deny; transport.get = deny; }
const spawn = children.spawn;
children.spawn = function (command, args, options) {
  if (args?.some(argument => String(argument).includes("agent-server-stdio"))) {
    state.forbiddenWorkers++; attempt("worker"); throw new Error("Preference fixture forbids Engine workers");
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
const { app, BrowserWindow, ipcMain, nativeTheme, net, safeStorage } = await import("electron");
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, ...args) {
  state.rendererLoads.push({windowId:this.id, file});
  return loadFile.call(this, file, ...args);
};
for (const name of ["isEncryptionAvailable", "getSelectedStorageBackend", "encryptString", "decryptString"])
  if (typeof safeStorage[name] === "function") safeStorage[name] = () => { state.cryptoAttempts++; attempt("crypto"); throw new Error("Preference fixture forbids native crypto"); };
net.request = deny; net.fetch = deny;
app.on("web-contents-created", (_event, contents) => contents.session.webRequest.onBeforeRequest({ urls:["http://*/*", "https://*/*"] }, (_details, done) => { state.networkAttempts++; attempt("network"); done({cancel:true}); }));
nativeTheme.themeSource = "light";
nativeTheme.on("updated", () => state.nativeThemeEvents.push({ source:nativeTheme.themeSource, dark:nativeTheme.shouldUseDarkColors }));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel !== "window:new" ? listener : async (...args) => { state.newWindows++; return listener(...args); });
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => on(channel, channel !== "agent:msg" ? listener : (event, line) => {
  let request;
  try { request = JSON.parse(line); } catch { return listener(event, line); }
  if (request?.method === "agent/run") { state.coreTurnAttempts++; attempt("core-turn"); throw new Error("Preference fixture forbids Core turns"); }
  return listener(event, line);
});
`,
  );
  fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: "http://127.0.0.1:9",
    guardModule: pathToFileURL(guard).href,
  });
  fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
  await launch();
  assert.deepEqual(
    {
      language: (await current()).language,
      mode: (await current()).mode,
      dark: (await current()).dark,
    },
    { language: null, mode: null, dark: false },
  );
  await operation(
    "General English selection synchronizes the existing production second window",
    async () => {
      const opened = app.waitForEvent("window", { timeout: 15_000 });
      opened.catch(() => {});
      await win.getByRole("button", { name: /^(返回应用|Back to app)$/ }).click();
      await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      const palette = win.getByRole("dialog", { name: /^(命令面板|Command palette)$/ });
      await palette.getByRole("option", { name: /新窗口|New window/ }).click();
      const other = await opened;
      await other.waitForURL(win.url());
      assert.equal(other.url(), win.url());
      await observe(other);
      await viewOnly(other);
      await general(other);
      await general();
      const nativeWindows = await app.evaluate(
        ({ BrowserWindow, session }, url) =>
          BrowserWindow.getAllWindows()
            .filter((item) => item.webContents.getURL() === url)
            .map((item) => {
              const preferences = item.webContents.getLastWebPreferences();
              return {
                id: item.id,
                defaultSession: item.webContents.session === session.defaultSession,
                contextIsolation: preferences.contextIsolation,
                nodeIntegration: preferences.nodeIntegration,
                sandbox: preferences.sandbox,
              };
            }),
        win.url(),
      );
      assert.equal(nativeWindows.length, 2);
      for (const windowProof of nativeWindows) {
        assert.equal(windowProof.defaultSession, true);
        assert.equal(windowProof.contextIsolation, true);
        assert.equal(windowProof.nodeIntegration, false);
        assert.equal(windowProof.sandbox, true);
      }
      const bridges = await Promise.all(
        [win, other].map((page) =>
          page.evaluate(async () => ({
            platform: window.codeshell.platform,
            noRepoCwd: await window.codeshell.noRepoCwd(),
            nodeRequire: typeof window.require,
          })),
        ),
      );
      for (const bridge of bridges) {
        assert.equal(bridge.platform, process.platform);
        assert.equal(bridge.noRepoCwd, join(isolated.codeShellHome, "no-repo"));
        assert.equal(bridge.nodeRequire, "undefined");
      }
      const loads = (await mainState()).rendererLoads;
      assert.ok(
        nativeWindows.every((item) =>
          loads.some(
            (load) =>
              load.windowId === item.id && load.file === join(appDir, "out/renderer/index.html"),
          ),
        ),
      );
      await win.getByRole("button", { name: /^English/ }).click();
      await other.waitForFunction(() =>
        window.__preferenceEvents.storage.some(
          (event) => event.key === "codeshell.uiLanguage" && event.newValue === "en",
        ),
      );
      await english(other);
      await english();
      const state = await current(other);
      assert.equal(
        state.events.storage.filter((event) => event.key === "codeshell.uiLanguage").length,
        1,
      );
      assert.equal(
        (await mainState()).newWindows,
        1,
        "One production New window command must issue one IPC",
      );
      await other.screenshot({ path: join(evidence, "language-second-window.png") });
      return {
        windowCreationIPC: 1,
        nativeStorageEvents: 1,
        selectedEnglish: true,
        nativeWindows,
        productionPreloadBridges: bridges,
        rendererURL: state.url,
        origin: state.origin,
      };
    },
  );
  await operation(
    "Default System to manual Dark survives actual Chromium media changes",
    async () => {
      await appearance();
      await win.locator('[data-theme-mode="system"][aria-pressed="true"]').waitFor();
      await win.locator('[data-theme-mode="dark"]').click();
      await nativeMode("dark");
      const light = await nativeMode("light");
      assert.equal(light.renderer.mode, "dark");
      assert.equal(light.renderer.dark, true);
      assert.equal(
        await win.locator('[data-theme-mode="dark"]').getAttribute("aria-pressed"),
        "true",
      );
      return {
        storedMode: "dark",
        resolvedDark: true,
        actualMediaDark: false,
        mediaEvents: light.renderer.events.media,
      };
    },
  );
  await close();
  assert.deepEqual(failures, []);
  await launch();
  await operation(
    "Cold native process restores English and manual Dark from owned disk",
    async () => {
      await english();
      await appearance();
      await win.locator('[data-theme-mode="dark"][aria-pressed="true"]').waitFor();
      const state = await current();
      assert.equal(state.mode, "dark");
      assert.equal(state.dark, true);
      assert.equal(state.mediaDark, false);
      return { coldNativeProcess: 2, language: state.language, mode: state.mode, dark: state.dark };
    },
  );
  await operation(
    "Manual cold startup to System follows actual nativeTheme dark and light",
    async () => {
      await win.locator('[data-theme-mode="system"]').click();
      const dark = await nativeMode("dark");
      assert.equal(dark.renderer.dark, true);
      const light = await nativeMode("light");
      assert.equal(light.renderer.dark, false);
      assert.equal(light.renderer.mode, "system");
      return {
        storedMode: "system",
        actualMediaEvents: light.renderer.events.media,
        followsBoth: true,
      };
    },
  );
  await operation("Actual renderer reload retains English and System selection", async () => {
    await win.reload();
    await observe(win);
    await general();
    await english();
    await appearance();
    await win.locator('[data-theme-mode="system"][aria-pressed="true"]').waitFor();
    assert.equal((await current()).dark, false);
    return { reloaded: true, language: "en", mode: "system" };
  });
  await close();
  assert.deepEqual(failures, []);
  await launch();
  await operation(
    "Third cold native process restores English and System from owned disk",
    async () => {
      await english();
      await appearance();
      await win.locator('[data-theme-mode="system"][aria-pressed="true"]').waitFor();
      const state = await current();
      assert.equal(state.mode, "system");
      assert.equal(state.dark, false);
      await win.screenshot({ path: join(evidence, "cold-system-restored.png") });
      return { coldNativeProcess: 3, language: state.language, mode: state.mode, dark: state.dark };
    },
  );
  assert.equal(operations.length, 6);
} catch (error) {
  const diagnostic = getElectronKeychainPreflightDiagnostic(error);
  failures.push({
    stage,
    name: error.name,
    message: diagnostic ? "Keychain metadata preflight refused launch" : error.message,
    keychainDiagnostic: diagnostic,
  });
  if (win)
    receipt.failureRendererState = await bounded(
      current(),
      3_000,
      "Renderer state unavailable",
    ).catch(() => null);
  if (win)
    await win.screenshot({ path: join(evidence, "failure.png"), timeout: 3_000 }).catch(() => {});
} finally {
  await close();
  receipt.rendererErrors = rendererErrors.flat().map((error) => error.message);
  if (receipt.rendererErrors.length)
    failures.push({ stage: "renderer", message: "Renderer error before shutdown completed" });
  if (observerFailures.length) failures.push({ stage: "observer", messages: observerFailures });
  for (const processProof of processes) {
    for (const stream of ["stdout", "stderr"])
      await write(
        join(evidence, `main-${processProof.cycle}.${stream}.log`),
        processProof.logs[stream],
      );
    delete processProof.logs;
    for (const key of ["networkAttempts", "forbiddenWorkers", "coreTurnAttempts", "cryptoAttempts"])
      if (processProof.finalState?.[key] !== 0)
        failures.push({ stage: "confinement", message: `Final ${key} must be zero` });
  }
  for (const name of ["network-guard.jsonl", "cost-gui-guard.jsonl", "spawned-workers.jsonl"]) {
    const contents = await readFile(join(isolated.home, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await write(join(evidence, name), contents);
  }
  const attempts = await readFile(join(isolated.home, "denied-attempts.jsonl"), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  await write(join(evidence, "denied-attempts.jsonl"), attempts);
  receipt.deniedAttempts = attempts.trim().split("\n").filter(Boolean).map(JSON.parse);
  if (receipt.deniedAttempts.length)
    failures.push({
      stage: "confinement",
      message: "Denied runtime attempt observed before Main exit",
    });
  receipt.failures = failures;
  if (
    !failures.length &&
    operations.length === 6 &&
    processes.length === 3 &&
    processes.every(
      (entry) =>
        entry.settlement?.status === "cleaned" &&
        entry.exit?.code === 0 &&
        entry.exit?.signal === null,
    )
  ) {
    try {
      await isolated.cleanup();
      receipt.privateHomeRemoved = true;
      receipt.status = "passed";
    } catch {
      failures.push({ stage: "cleanup", message: "Private HOME removal failed" });
    }
  }
  await write(join(evidence, "receipt.json"), receipt);
}
console.log(
  JSON.stringify({
    status: receipt.status,
    evidence,
    scenarios: operations.length,
    privateHomeRemoved: receipt.privateHomeRemoved,
  }),
);
assert.equal(
  receipt.status,
  "passed",
  "Native preference operations failed; evidence/private HOME retained",
);
