/* global window */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  assertOfflinePluginBootstrapHeld,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const isolated = await makeIsolatedElectronHome("codeshell-desktop-host-");
let application;

async function observeHost(page) {
  await page.waitForFunction(() => typeof window.codeshell?.onDesktopHostStatus === "function");
  await page.evaluate(() => {
    window.hostSmokeStates = [];
    window.codeshell.onDesktopHostStatus((state) => window.hostSmokeStates.push(state));
  });
  await page.waitForFunction(() => window.hostSmokeStates.at(-1) === "ready");
}

const readCatalog = (page) =>
  page.evaluate(async () =>
    (await window.codeshell.links.listLocalProviders()).map(({ id }) => id),
  );

try {
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  const projectRoot = join(isolated.home, "host-smoke-project");
  await mkdir(projectRoot, { recursive: true });
  const mount = await realpath(projectRoot);
  await writeFile(join(mount, "host-file.txt"), "from-workspace");
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "desktop", "projects.json"),
    JSON.stringify({
      version: 2,
      projects: [
        {
          id: "host-smoke-project",
          name: "Host smoke",
          primaryRootId: "root",
          roots: [{ id: "root", name: "root", path: mount, canonicalIdentity: mount, addedAt: 1 }],
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1,
          revision: 1,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const directory = join(isolated.codeShellHome, "sessions", "index-visible");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      sessionId: "index-visible",
      origin: "desktop",
      parentSessionId: null,
      title: "Host indexed row",
      cwd: isolated.home,
    }),
  );
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({
      credentials: [
        {
          id: "fixture-key",
          catalogId: "openai",
          apiKey: "synthetic",
          baseUrl: "http://127.0.0.1:9/v1",
        },
      ],
      modelConnections: [
        {
          id: "fixture",
          catalogId: "openai",
          tag: "text",
          model: "gpt-4o",
          credentialId: "fixture-key",
        },
      ],
      defaults: { text: "fixture" },
    }),
    { mode: 0o600 },
  );
  const fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: "http://127.0.0.1:9",
  });
  // Keep the exact child handle created by this Main so the failure injection can
  // target only this test's own Host, including if the OS has recycled a PID.
  const bootstrap = join(isolated.home, "observe-host.cjs");
  await writeFile(
    bootstrap,
    `const { utilityProcess } = require("electron");
const fork = utilityProcess.fork;
utilityProcess.fork = function (...args) {
  const child = fork.apply(this, args);
  if (args[2]?.serviceName === "CodeShell Desktop Host") globalThis.smokeHostChild = child;
  return child;
};
`,
    { mode: 0o600 },
  );
  application = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: { ...fixture.env, CODESHELL_E2E_MOCK_KEYCHAIN: "1" },
    mainEntry: fixture.mainEntry,
    mainBootstrap: bootstrap,
    runtimeTimeoutMs: 90_000,
  });
  const first = await findCodeShellWindow(application);
  await fixture.assertWorker(application, { requireWorker: false });
  await observeHost(first);
  const catalog = await readCatalog(first);
  assert.ok(catalog.includes("github"), "Built-in Link provider missing");
  const secondOpened = application.waitForEvent("window", { timeout: 15_000 });
  await first.evaluate(() => window.codeshell.newWindow());
  const second = await secondOpened;
  await observeHost(second);
  assert.deepEqual(await readCatalog(second), catalog);
  await first.evaluate(() =>
    window.codeshell.updateSettings("user", { hostSmokeReceipt: "committed" }),
  );
  assert.equal(
    await second.evaluate(
      async () => (await window.codeshell.getSettings("user"))?.hostSmokeReceipt,
    ),
    "committed",
  );
  await assert.rejects(
    first.evaluate(() => window.codeshell.updateSettings("user", { panelAppBindings: {} })),
    /reviewed project binding/,
  );

  await first.evaluate((root) => window.codeshell.setTrust(root, "trusted"), mount);
  assert.equal(await second.evaluate((root) => window.codeshell.getTrust(root), mount), "trusted");
  await first.evaluate((root) => window.codeshell.setTrust(root, "untrusted"), mount);
  assert.equal(
    await second.evaluate((root) => window.codeshell.getTrust(root), mount),
    "untrusted",
  );

  await second.evaluate(() => {
    window.hostRegistryRename = new Promise((resolve) => {
      const off = window.codeshell.projectRegistry.onChanged((projects) => {
        const project = projects.find(
          (p) => p.id === "host-smoke-project" && p.name === "Renamed Host project",
        );
        if (project) {
          off();
          resolve(project.name);
        }
      });
    });
  });
  await first.evaluate(() =>
    window.codeshell.projectRegistry.rename("host-smoke-project", "Renamed Host project"),
  );
  assert.equal(await second.evaluate(() => window.hostRegistryRename), "Renamed Host project");
  await first.evaluate(() =>
    window.codeshell.projectRegistry.setPinned("host-smoke-project", true),
  );
  assert.equal(
    await second.evaluate(
      async () =>
        (await window.codeshell.projectRegistry.list()).find((p) => p.id === "host-smoke-project")
          ?.pinned,
    ),
    true,
  );

  const uploaded = join(isolated.home, "native-picked-host-document.txt");
  await writeFile(uploaded, "Host source upload");
  await application.evaluate(({ dialog }, file) => {
    const original = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = (...args) => {
      if (args.at(-1)?.title === "选择数据源文件") {
        dialog.showOpenDialog = original;
        return Promise.resolve({ canceled: false, filePaths: [file] });
      }
      return original(...args);
    };
  }, uploaded);
  await first.evaluate(async () => {
    const api = window.codeshell;
    await api.saveSourceCatalog({ id: "host-source", kind: "mcp-resource", label: "Host source" });
    await api.bindProjectSource("host-smoke-project", {
      sourceId: "host-source",
      scopes: ["resources"],
      readPolicy: "ask",
    });
  });
  assert.ok(
    await second.evaluate(async () =>
      (await window.codeshell.projectSourceAccess("host-smoke-project")).bindings.some(
        (row) => row.sourceId === "host-source",
      ),
    ),
  );
  const names = await first.evaluate(() =>
    window.codeshell.pickAndUploadProjectSources("host-smoke-project"),
  );
  assert.deepEqual(names, ["native-picked-host-document.txt"]);
  assert.equal(
    await readFile(join(mount, ".code-shell", "uploads", names[0]), "utf8"),
    "Host source upload",
  );
  await second.evaluate(async () => {
    const api = window.codeshell;
    await api.deleteProjectUpload("host-smoke-project", "native-picked-host-document.txt");
    await api.unbindProjectSource("host-smoke-project", "host-source");
    await api.deleteSourceCatalog("host-source");
    const [builtIn] = await api.getModelCatalog();
    const saved = await api.saveCatalogEntry({ ...builtIn, id: "host-smoke-model" });
    if (!saved.ok) throw new Error(saved.error);
  });
  assert.equal(
    await first.evaluate(
      async () => (await window.codeshell.getCatalogOrigins())["host-smoke-model"],
    ),
    "user",
  );
  assert.equal(
    await first.evaluate(
      async () => (await window.codeshell.deleteCatalogEntry("host-smoke-model")).removed,
    ),
    true,
  );

  const terminalId = "term:host-smoke";
  const started = await first.evaluate(
    async ({ cwd, sessionId }) => {
      window.hostTerminalText = "";
      window.codeshell.onPtyData((msg) => {
        if (msg.sessionId === sessionId) window.hostTerminalText += msg.data;
      });
      return window.codeshell.ptyStart({ cwd, sessionId });
    },
    { cwd: mount, sessionId: terminalId },
  );
  assert.equal(started.ok, true, started.detail);
  const denied = await second.evaluate(
    ({ cwd, sessionId }) => window.codeshell.ptyStart({ cwd, sessionId }),
    { cwd: mount, sessionId: terminalId },
  );
  assert.equal(
    denied.ok,
    false,
    "A second window cannot attach to the first window's live terminal",
  );
  await second.evaluate((id) => window.codeshell.ptyKill(id), terminalId);
  await first.evaluate(
    (id) => window.codeshell.ptyWrite(id, "echo HOST_TERMINAL_READY\r"),
    terminalId,
  );
  await first.waitForFunction(() =>
    window.hostTerminalText.replace(/\r/g, "").includes("\nHOST_TERMINAL_READY\n"),
  );
  // Arm a renderer timer before blocking Main. Both timestamps come from the
  // renderer so a response delivered by Main after the pause cannot pass.
  const secondHandle = await application.browserWindow(second);
  const measured = await secondHandle.evaluate(async (nativeWindow) => {
    const contents = nativeWindow.webContents;
    await contents.executeJavaScript(`window.hostSmokeRead = new Promise((resolve, reject) =>
      setTimeout(async () => {
        try {
          const begin = Date.now();
          const ids = (await window.codeshell.links.listLocalProviders()).map(({ id }) => id);
          const page = await window.codeshell.listDiskSessions({limit:1,sessionId:"index-visible"});
          const api = window.codeshell;
          const business = await Promise.all([
            api.projectRegistry.list(), api.recents(), api.listSourceCatalog(), api.getModelCatalog(),
            api.listPluginMcpTrust(), api.getPluginDetail("uninstalled-business-test"), api.getSettings("user"),
            api.listSkills(null),api.listPlugins(null),api.listMergedMcpServers({},[]),api.getConfigurationSettings({noRepo:true})
          ]);
          const [projects, recents, sources, models, trust, plugin, settings, skills, plugins, mcp, projectSettings] = business;
          const root = projects.find(p => p.id === "host-smoke-project").roots[0];
          const entries = await api.readProjectDir("host-smoke-project", root.id);
          const entry = entries.find(row => row.name === "host-file.txt");
          const [file, hits, exists, git] = await Promise.all([
            api.readProjectFileContent("host-smoke-project", root.id, entry.path),
            api.searchProjectFiles("host-smoke-project", "host-file", root.id),
            api.projectFileExists("host-smoke-project", root.id, entry.path),
            api.getProjectGitStatus("host-smoke-project"),
          ]);
          resolve({ begin, end: Date.now(), ids, sessionIds:page.sessions.map(row=>row.id),
            workspaceViews:file.text === "from-workspace" && exists && hits.some(row => row.rootId === root.id && row.name === entry.name) && Array.isArray(git.entries),
            configurationViews: [projects, recents, sources, models, trust, skills, plugins].every(Array.isArray)
              && mcp !== null && typeof mcp === "object" && (projectSettings === null || typeof projectSettings === "object")
              && models.length > 0 && plugin === null && (settings === null || typeof settings === "object") });
        } catch (error) { reject(error); }
      }, 250)); void 0`);
    const begin = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600);
    const end = Date.now();
    return { begin, end, read: await contents.executeJavaScript("window.hostSmokeRead") };
  });
  await secondHandle.dispose();
  assert.deepEqual(measured.read.ids, catalog);
  assert.equal(
    measured.read.workspaceViews,
    true,
    "Workspace files and Git answered during the Main pause",
  );
  assert.deepEqual(measured.read.sessionIds, ["index-visible"]);
  assert.equal(
    measured.read.configurationViews,
    true,
    "Configuration views must resolve on the workbench Host port",
  );
  // A correct metadata page could also come from JSON fallback. Verify that this
  // Electron utility's actual worker committed the row in its WAL database.
  const storage = join(isolated.codeShellHome, ".codeshell-state");
  const roots = await readdir(storage);
  assert.equal(roots.length, 1);
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(storage, roots[0], "current", "state.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(
      database.prepare("SELECT title FROM sessions WHERE id=?").get("index-visible")?.title,
      "Host indexed row",
    );
  } finally {
    database.close();
  }
  assert.ok(
    measured.begin <= measured.read.begin && measured.read.end < measured.end,
    `Catalog read must finish during Main stall: ${JSON.stringify(measured)}`,
  );

  await first.reload({ waitUntil: "domcontentloaded" });
  await observeHost(first);
  assert.deepEqual(await readCatalog(first), catalog);
  const reattached = await first.evaluate(
    async ({ cwd, sessionId }) => {
      window.hostTerminalText = "";
      window.codeshell.onPtyData((msg) => {
        if (msg.sessionId === sessionId) window.hostTerminalText += msg.data;
      });
      return window.codeshell.ptyStart({ cwd, sessionId });
    },
    { cwd: mount, sessionId: terminalId },
  );
  assert.equal(reattached.pid, started.pid);
  await first.waitForFunction(() => window.hostTerminalText.includes("HOST_TERMINAL_READY"));
  await first.evaluate((id) => window.codeshell.ptyKill(id), terminalId);
  // A full local fork exercises actual worker stdio without performing inference.
  await first.evaluate(() => {
    window.hostSmokeFork = window.codeshell.forkSession({
      sourceSessionId: "index-visible",
      targetSessionId: "host-worker-copy",
      mode: "full",
    });
    void window.hostSmokeFork.catch(() => {});
  });
  const receipt = await fixture.assertWorker(application);
  assert.equal(receipt.spawned.length, 1);
  assert.equal((await first.evaluate(() => window.hostSmokeFork)).sessionId, "host-worker-copy");
  assert.deepEqual((await first.evaluate(() => window.codeshell.configure({}))).result, {
    ok: true,
  });
  const oldPid = await application.evaluate(() => {
    const child = globalThis.smokeHostChild;
    const pid = child?.pid;
    if (!pid || !child.kill()) throw new Error("Failed to stop the owned Desktop Host");
    return pid;
  });
  assert.equal(receipt.spawned[0].ppid, oldPid);
  assert.notEqual(oldPid, receipt.mainPid);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(receipt.spawned[0].pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") break;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.throws(
    () => process.kill(receipt.spawned[0].pid, 0),
    { code: "ESRCH" },
    "Original stdio worker must exit when its Host disappears",
  );
  for (const page of [first, second]) {
    await page.waitForFunction(
      () =>
        window.hostSmokeStates.includes("reconnecting") &&
        window.hostSmokeStates.at(-1) === "ready",
    );
    assert.deepEqual(await readCatalog(page), catalog);
  }
  const nextPid = await application.evaluate(() => globalThis.smokeHostChild.pid);
  assert.ok(nextPid && nextPid !== oldPid, "Expected a fresh Host process");

  // Destroying all fixture windows bypasses interactive save prompts. Exercise
  // the application's real last-window and activate listeners.
  await application.evaluate(async ({ app, BrowserWindow }) => {
    const closed = new Promise((resolve) => app.once("window-all-closed", resolve));
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await closed;
  });
  assert.equal(await application.evaluate(() => globalThis.smokeHostChild.pid), nextPid);
  const reopened = application.waitForEvent("window", { timeout: 15_000 });
  await application.evaluate(({ app }) => {
    app.emit("activate");
  });
  const restored = await reopened;
  await observeHost(restored);
  assert.deepEqual(await readCatalog(restored), catalog);
  assert.equal(await application.evaluate(() => globalThis.smokeHostChild.pid), nextPid);
  await assertOfflinePluginBootstrapHeld(isolated.codeShellHome);
  console.log(
    `Desktop Host passed: two workbenches, reload, process recovery and reopen. Catalog reply ${measured.read.end - measured.read.begin} ms during ${measured.end - measured.begin} ms Main stall.`,
  );
} finally {
  try {
    await application?.close();
  } finally {
    await isolated.cleanup();
  }
}
