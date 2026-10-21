/* Actual compiled Main/preload/renderer and memory IPC/files; no Engine or account use.
 * Run with run-isolated-node-smoke.mjs and --evidence-dir <new owned directory>. */
/* global localStorage, window */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertSourceElectronTransportSettled,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
  waitForAsyncFunction,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import { getElectronKeychainPreflightDiagnostic } from "./electron-keychain-preflight.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated native smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.equal(process.argv.length, 4, "Expected --evidence-dir <new-directory>");
assert.equal(process.argv[2], "--evidence-dir");
const evidence = resolve(process.argv[3]);
const outsideHome = relative(await realpath(process.env.HOME), evidence);
assert.ok(isAbsolute(outsideHome) || outsideHome === ".." || outsideHome.startsWith(`..${sep}`));
await mkdir(evidence, { mode: 0o700 });
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-memory-pin-native-");
await mkdir(join(isolated.home, "owned-project"), { mode: 0o700 });
const project = await realpath(join(isolated.home, "owned-project"));
children.execFileSync("git", ["init", "--quiet", project], { timeout: 5_000 });
const privateRelative = relative(await realpath(process.env.HOME), isolated.home);
assert.ok(
  isAbsolute(privateRelative) || privateRelative === ".." || privateRelative.startsWith(`..${sep}`),
  "Native fixture HOME must survive the outer runner on failure",
);
const names = { a: "Owned-memory-A", b: "Owned-memory-B", dream: "Owned-dream-memory" };
const bodies = { a: "Owned A body 中文 🐈", b: "Owned B body", dream: "Owned dream body" };
const failures = [];
const operations = [];
const observerFailures = [];
const rendererErrors = [];
const logs = { stdout: "", stderr: "" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const receipt = {
  fixture: "native-memory-pin-operation-cycles",
  status: "failed",
  platform: process.platform,
  arch: process.arch,
  appDir,
  privateHome: isolated.home,
  privateHomeRemoved: false,
  operations,
};
let app, win, monitor, captured, processClosed, filePaths;
let stage = "prepare";
const write = async (path, data) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
};
const mainState = () =>
  app.evaluate(() => {
    const state = globalThis.__memoryPinOperations;
    return {
      calls: state.calls,
      networkAttempts: state.networkAttempts,
      forbiddenWorkers: state.forbiddenWorkers,
      gateArmed: state.gate !== null,
      pending: state.release !== null,
    };
  });
const settle = async () => {
  await waitForAsyncFunction(
    app,
    () => {
      const state = globalThis.__memoryPinOperations;
      return (
        !state.release &&
        state.calls.every((call) => call.status !== "pending") &&
        Date.now() - state.lastActivity >= 200
      );
    },
    undefined,
    { timeout: 8_000, polling: 25 },
  );
  await win.evaluate(
    () =>
      new Promise((done) => window.requestAnimationFrame(() => window.requestAnimationFrame(done))),
  );
};
async function arm(channel, fail = false) {
  await app.evaluate(
    (_electron, input) => {
      const state = globalThis.__memoryPinOperations;
      if (state.gate || state.release) throw new Error("Only one owned memory gate may be pending");
      state.gate = input;
    },
    { channel, name: names.a, fail },
  );
}
async function waitPending() {
  await waitForAsyncFunction(
    app,
    () => Boolean(globalThis.__memoryPinOperations.release),
    undefined,
    { timeout: 5_000, polling: 25 },
  );
}
async function release() {
  await app.evaluate(() => {
    const state = globalThis.__memoryPinOperations;
    if (!state.release) throw new Error("The single owned memory gate was not reached");
    state.release();
  });
  await settle();
}
const row = (name = names.a) =>
  win.locator("main li").filter({ has: win.getByText(name, { exact: true }) });
const pin = () =>
  row()
    .getByRole("button", { name: /^(Pin|Unpin)$/, exact: true })
    .click();
async function select(name = names.a) {
  await row(name)
    .getByRole("button", { name: new RegExp(name) })
    .click();
  const body = name === names.a ? bodies.a : bodies.b;
  await win.getByText(body, { exact: true }).waitFor();
}
async function userScope() {
  await win.getByRole("button", { name: "Long-term", exact: true }).click();
  await row().waitFor();
  await settle();
}
async function cancelDraft() {
  await win.locator("main").getByRole("button", { name: "Cancel", exact: true }).click();
  const dialog = win.getByRole("dialog", { name: "Discard memory changes?", exact: true });
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await win
    .getByRole("textbox", { name: "Memory content", exact: true })
    .waitFor({ state: "hidden" });
}
async function diskSnapshot() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(filePaths).map(async ([key, path]) => {
        const bytes = await readFile(path);
        return [
          key,
          { sha256: hash(bytes), pinned: /^pinned: true$/m.test(bytes.toString()), bytes },
        ];
      }),
    ),
  );
}
async function verifyDisk(expectedPinned) {
  const files = await diskSnapshot();
  assert.equal(files.a.pinned, expectedPinned, "Production file did not persist the pin toggle");
  for (const key of Object.keys(bodies))
    assert.ok(
      files[key].bytes.includes(Buffer.from(bodies[key])),
      "Production memory content changed",
    );
  const full = await win.evaluate(
    ({ project, name }) => window.codeshell.readMemory("project", "user", name, project),
    { project, name: names.a },
  );
  assert.equal(
    full.content,
    bodies.a,
    "Original memory content was not preserved by production IPC",
  );
  assert.equal(Boolean(full.pinned), expectedPinned);
  return Object.fromEntries(
    Object.entries(files).map(([key, value]) => [
      key,
      { sha256: value.sha256, pinned: value.pinned },
    ]),
  );
}
async function cycle(action, run, { failedSave = false } = {}) {
  stage = action;
  await userScope();
  const before = await diskSnapshot();
  const mark = (await mainState()).calls.length;
  const ui = await run();
  await settle();
  const state = await mainState();
  const calls = state.calls.slice(mark);
  const saves = calls.filter((call) => call.channel === "memory:save");
  assert.equal(saves.length, 1, "One user pin must issue exactly one save request");
  assert.equal(saves.filter((call) => call.status === "committed").length, failedSave ? 0 : 1);
  const disk = await verifyDisk(failedSave ? before.a.pinned : !before.a.pinned);
  assert.equal(disk.b.sha256, before.b.sha256, "Pin changed the other memory file");
  assert.equal(disk.dream.sha256, before.dream.sha256, "Pin changed the dream memory file");
  if (failedSave)
    assert.equal(disk.a.sha256, before.a.sha256, "Rejected save changed the source file");
  operations.push({
    action,
    calls,
    saveAttempts: saves.length,
    committedWrites: failedSave ? 0 : 1,
    ui,
    disk,
  });
  await write(join(evidence, "operations.json"), operations);
}

try {
  const settingsBundle = (await readdir(join(appDir, "out/renderer/assets"))).find((file) =>
    /^SettingsPage-.*\.js$/.test(file),
  );
  assert.ok(settingsBundle, "Own compiled SettingsPage is required");
  receipt.build = {
    fixtureSourceSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
    sourceHead: children
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8", timeout: 5_000 })
      .trim(),
    mainSHA256: hash(await readFile(join(appDir, "out/main/index.mjs"))),
    preloadSHA256: hash(await readFile(join(appDir, "out/preload/index.cjs"))),
    settingsBundleSHA256: hash(await readFile(join(appDir, "out/renderer/assets", settingsBundle))),
    coreMemorySHA256: hash(await readFile(resolve(appDir, "../core/dist/session/memory.js"))),
  };
  await write(join(isolated.codeShellHome, "settings.json"), { autoUpdates: false });
  await write(join(isolated.codeShellHome, "desktop/recents.json"), [
    { path: project, name: "Owned memory project", lastOpenedAt: Date.now() },
  ]);
  const guard = join(isolated.home, "memory-pin-guard.mjs");
  await write(
    guard,
    `
import children from "node:child_process";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
await import(${JSON.stringify(new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href)});
const state = globalThis.__memoryPinOperations = {calls:[], gate:null, release:null, networkAttempts:0, forbiddenWorkers:0, lastActivity:Date.now()};
const deny = () => { state.networkAttempts++; throw new Error("Memory pin fixture denies network"); };
globalThis.fetch = deny;
for (const transport of [http, https]) { transport.request = deny; transport.get = deny; }
const spawn = children.spawn;
children.spawn = function (command, args, options) {
  if (args?.some(argument => String(argument).includes("agent-server-stdio"))) {
    state.forbiddenWorkers++; throw new Error("Memory pin fixture forbids Engine workers");
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
const { app, ipcMain, net } = await import("electron");
net.request = deny; net.fetch = deny;
app.on("web-contents-created", (_event, contents) => contents.session.webRequest.onBeforeRequest({urls:["http://*/*", "https://*/*"]}, (_details, done) => { state.networkAttempts++; done({cancel:true}); }));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, !["memory:list", "memory:read", "memory:save"].includes(channel) ? listener : async (...args) => {
  const input = args[1];
  const call = {channel, scope:channel === "memory:save" ? input.scope : args[2], name:channel === "memory:save" ? input.name : channel === "memory:read" ? args[3] : null, status:"pending"};
  state.calls.push(call); state.lastActivity = Date.now();
  try {
    const gate = state.gate;
    if (gate && gate.channel === channel && gate.name === call.name) {
      state.gate = null;
      await new Promise(resolve => { state.release = resolve; });
      state.release = null;
      if (gate.fail) { call.status = "injected-error"; throw new Error("Owned pending memory save failed"); }
    }
    const result = await listener(...args);
    call.status = channel === "memory:save" ? "committed" : "completed";
    return result;
  } catch (error) { if (call.status === "pending") call.status = "handler-error"; throw error; }
  finally { state.lastActivity = Date.now(); }
});
`,
  );
  const fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: "http://127.0.0.1:9",
    guardModule: pathToFileURL(guard).href,
  });
  fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
  const executable = await realpath(createRequire(import.meta.url)("electron"));
  const originalSpawn = children.spawn;
  children.spawn = function (command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (command === executable && options?.env?.HOME === isolated.home) {
      assert.equal(captured, undefined, "Exactly one owned Electron Main may be launched");
      captured = child;
      processClosed = new Promise((done) =>
        child.once("close", (code, signal) => done({ code, signal })),
      );
      child.once("error", () => observerFailures.push("Owned Electron spawn error"));
      for (const stream of ["stdout", "stderr"])
        child[stream]?.on("data", (chunk) => {
          logs[stream] = (logs[stream] + chunk).slice(-1024 * 1024);
        });
      monitor = watchElectronTestProcess(child, {
        timeoutMs: 180_000,
        reportFailure: (message) => observerFailures.push(message),
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  stage = "launch own compiled Desktop";
  try {
    app = await launchCodeShellElectron(
      { appDir, ...isolated, mainEntry: fixture.mainEntry, env: fixture.env },
      {
        reportFailure: (message) => observerFailures.push(message),
        watch: (child) => {
          assert.equal(child, captured, "Harness must reuse this exact early Main custody");
          return monitor;
        },
      },
    );
  } finally {
    children.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(captured, app.process(), "Early watcher did not bind the launched Main");
  receipt.mainPid = captured.pid;
  stage = "wait for own compiled workbench renderer";
  await findCodeShellWindow(app);
  win = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(win, "The actual workbench renderer was not found");
  receipt.rendererURL = win.url();
  assert.equal(
    new URL(win.url()).pathname,
    new URL(pathToFileURL(join(appDir, "out/renderer/index.html"))).pathname,
  );
  rendererErrors.push(captureRendererErrors(win));
  stage = "read own compiled Desktop runtime metadata";
  receipt.runtime = await app.evaluate(({ app }) => ({
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  }));
  assert.equal(receipt.runtime.appPath, appDir);
  assert.equal(receipt.runtime.userData, isolated.userDataDir);
  win.setDefaultTimeout(10_000);
  await win.setViewportSize({ width: 1440, height: 960 });
  stage = "verify own compiled Desktop confinement";
  receipt.confinement = await fixture.assertWorker(app, { requireWorker: false });
  assert.equal(receipt.confinement.workerCreated, false);
  const guiGuard = (await readFile(join(isolated.home, "cost-gui-guard.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    guiGuard.some(
      (entry) =>
        entry.pid === captured.pid &&
        entry.negativeProbes === 7 &&
        entry.homeId === receipt.confinement.homeId,
    ),
  );
  receipt.guiGuard = guiGuard;
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "en");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
  });
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 2_000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  await win
    .locator("aside")
    .getByRole("button", { name: "Owned memory project", exact: true })
    .click();
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 2_000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  stage = "seed through production memory IPC";
  const seeded = await win.evaluate(
    async ({ project, names, bodies }) => {
      for (const key of Object.keys(names))
        await window.codeshell.saveMemory({
          level: "project",
          scope: key === "dream" ? "dream" : "user",
          cwd: project,
          name: names[key],
          description: `Owned ${key} description`,
          type: "project",
          content: bodies[key],
          pinned: false,
          origin: key === "dream" ? "dream" : "manual",
        });
      return {
        user: await window.codeshell.listMemory("project", "user", project),
        dream: await window.codeshell.listMemory("project", "dream", project),
      };
    },
    { project, names, bodies },
  );
  // The isolated home holds exactly one project, so its memory root is the only
  // entry under project-memory/ (keyed by MemoryManager's collision-free key).
  const projectMemoryDirs = await readdir(join(isolated.codeShellHome, "project-memory"));
  assert.equal(projectMemoryDirs.length, 1);
  const memoryRoot = join(isolated.codeShellHome, "project-memory", projectMemoryDirs[0]);
  filePaths = Object.fromEntries(
    Object.entries(names).map(([key, name]) => {
      const scope = key === "dream" ? "dream" : "user";
      const found = seeded[scope].find((entry) => entry.name === name);
      assert.ok(found && /^[a-z0-9_-]+\.md$/.test(found.fileName));
      return [key, join(memoryRoot, scope, found.fileName)];
    }),
  );
  receipt.seedWrites = (await mainState()).calls.filter(
    (call) => call.channel === "memory:save" && call.status === "committed",
  ).length;
  assert.equal(receipt.seedWrites, 3);
  await navigateSettingsMenu(win, /^(设置|Settings)$/);
  await win
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "Memory", exact: true })
    .click();
  await win
    .locator("main")
    .getByRole("button", { name: /Owned memory project/ })
    .click();
  await cycle("normal selected pin", async () => {
    await select();
    await pin();
    await settle();
    await row().getByRole("button", { name: "Unpin", exact: true }).waitFor();
    await win.getByText(bodies.a, { exact: true }).waitFor();
    return { selected: "A", refreshed: true };
  });
  await cycle("late read after user to dream", async () => {
    await select();
    await arm("memory:read");
    await pin();
    await waitPending();
    await win.getByRole("button", { name: "Auto-organized", exact: true }).click();
    await row(names.dream).waitFor();
    await release();
    assert.equal(await row().count(), 0, "Old pin replaced the dream list");
    await row(names.dream).waitFor();
    return { scope: "dream", userRows: 0 };
  });
  await cycle("pending pin then select B", async () => {
    await select();
    await arm("memory:read");
    await pin();
    await waitPending();
    await select(names.b);
    await release();
    await win.getByText(bodies.b, { exact: true }).waitFor();
    assert.equal(
      await win.getByText(bodies.a, { exact: true }).count(),
      0,
      "Old pin reopened A over B",
    );
    return { selected: "B" };
  });
  for (const editFirst of [false, true]) {
    await cycle(
      editFirst ? "edit then pin then continue draft" : "pin then edit draft",
      async () => {
        await select();
        if (editFirst) await win.getByRole("button", { name: "Edit", exact: true }).click();
        await arm("memory:read");
        await pin();
        await waitPending();
        if (!editFirst) await win.getByRole("button", { name: "Edit", exact: true }).click();
        const draft = `Owned unsaved draft ${editFirst ? "before" : "after"}`;
        const editor = win.getByRole("textbox", { name: "Memory content", exact: true });
        await editor.fill(draft);
        await release();
        assert.equal(await editor.inputValue(), draft, "Pin replaced the unsaved draft");
        assert.equal(
          await win.getByRole("dialog").count(),
          0,
          "Pin opened an unsolicited draft confirmation",
        );
        await win.screenshot({
          path: join(evidence, editFirst ? "edit-before-pin.png" : "edit-after-pin.png"),
        });
        await cancelDraft();
        return { draftPreserved: true, draftSaved: false, editFirst };
      },
    );
  }
  await cycle("pending pin then close detail", async () => {
    await select();
    await arm("memory:read");
    await pin();
    await waitPending();
    await win.getByRole("button", { name: "close", exact: true }).click();
    await release();
    assert.equal(
      await win.getByRole("button", { name: "close", exact: true }).count(),
      0,
      "Pin reopened the closed detail",
    );
    assert.equal(await win.getByText(bodies.a, { exact: true }).count(), 0);
    return { detailClosed: true };
  });
  await cycle(
    "late failed save after user to dream",
    async () => {
      await select();
      await arm("memory:save", true);
      await pin();
      await waitPending();
      await win.getByRole("button", { name: "Auto-organized", exact: true }).click();
      await row(names.dream).waitFor();
      await release();
      assert.equal(await row().count(), 0);
      assert.equal(
        await win.getByText(/Owned pending memory save failed/).count(),
        0,
        "Old save failure leaked into dream UI",
      );
      return { scope: "dream", staleError: false };
    },
    { failedSave: true },
  );
  const finalState = await mainState();
  assert.equal(finalState.networkAttempts, 0);
  assert.equal(finalState.forbiddenWorkers, 0);
  assert.deepEqual(rendererErrors.flat(), []);
  receipt.finalState = finalState;
  await fixture.assertWorker(app, { requireWorker: false });
  for (const [key, path] of Object.entries(filePaths))
    await write(join(evidence, `${key}.md`), await readFile(path, "utf8"));
  receipt.scenariosPassed = operations.length;
  assert.equal(operations.length, 7);
} catch (error) {
  if (app) {
    try {
      receipt.failureState = await mainState();
    } catch {
      failures.push({ stage: "failure state", message: "Main operation receipt unavailable" });
    }
  }
  failures.push({
    stage,
    name: error.name,
    message: getElectronKeychainPreflightDiagnostic(error)
      ? "Keychain metadata preflight refused launch"
      : error.message,
    keychainDiagnostic: getElectronKeychainPreflightDiagnostic(error),
  });
  if (win) {
    try {
      await win.screenshot({ path: join(evidence, "failure.png"), timeout: 3_000 });
    } catch {
      failures.push({ stage: "failure screenshot", message: "Screenshot unavailable" });
    }
  }
} finally {
  if (app) {
    try {
      await app.evaluate(() => globalThis.__memoryPinOperations.release?.()).catch(() => {});
      if (win) await settle();
      receipt.finalState = await mainState();
      let timer;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Owned Electron close timed out")), 8_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      failures.push({ stage: "close", message: "Graceful owned Electron close failed" });
    }
  }
  if (monitor) {
    receipt.processSettlement = await monitor.terminate();
    if (receipt.processSettlement.status !== "cleaned")
      failures.push({ stage: "cleanup", message: "Owned process exit is unproven" });
    if (processClosed && (captured.exitCode !== null || captured.signalCode !== null))
      receipt.processExit = await processClosed;
    if (receipt.processExit?.code !== 0 || receipt.processExit?.signal)
      failures.push({ stage: "close", message: "Owned Main did not exit normally" });
  } else {
    receipt.processSettlement = { status: "unproven" };
    if (captured) {
      captured.unref();
      captured.stdout?.unref?.();
      captured.stderr?.unref?.();
    }
    failures.push({ stage: "cleanup", message: "Owned process identity was never established" });
  }
  if (observerFailures.length) failures.push({ stage: "observer", messages: observerFailures });
  try {
    receipt.windowsTransport = assertSourceElectronTransportSettled(captured);
  } catch (error) {
    failures.push({ stage: "Windows transport", message: error.message });
  }
  receipt.rendererErrors = rendererErrors.flat().map((error) => error.message);
  if (receipt.rendererErrors.length)
    failures.push({
      stage: "renderer",
      message: "Renderer reported an error before shutdown completed",
    });
  receipt.failures = failures;
  for (const stream of ["stdout", "stderr"])
    await write(join(evidence, `main.${stream}.log`), logs[stream]);
  for (const name of ["network-guard.jsonl", "cost-gui-guard.jsonl", "spawned-workers.jsonl"]) {
    const contents = await readFile(join(isolated.home, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await write(join(evidence, name), contents);
  }
  if (!failures.length && receipt.processSettlement.status === "cleaned") {
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
  "Native memory pin operations failed; evidence/private HOME retained",
);
