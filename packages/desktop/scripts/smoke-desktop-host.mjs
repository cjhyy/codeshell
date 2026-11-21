/* global window */
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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
          resolve({ begin, end: Date.now(), ids, sessionIds:page.sessions.map(row=>row.id) });
        } catch (error) { reject(error); }
      }, 250)); void 0`);
    const begin = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600);
    const end = Date.now();
    return { begin, end, read: await contents.executeJavaScript("window.hostSmokeRead") };
  });
  await secondHandle.dispose();
  assert.deepEqual(measured.read.ids, catalog);
  assert.deepEqual(measured.read.sessionIds, ["index-visible"]);
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
  const oldPid = await application.evaluate(() => {
    const child = globalThis.smokeHostChild;
    const pid = child?.pid;
    if (!pid || !child.kill()) throw new Error("Failed to stop the owned Desktop Host");
    return pid;
  });
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
