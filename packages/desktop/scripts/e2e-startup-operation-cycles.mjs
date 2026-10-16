/* Real cold Main, renderer reload and second-window startup. No substituted IPC handlers. */
/* global window */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Use the isolated native smoke runner");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-startup-cycles-");
const evidence = join(isolated.home, "evidence");
await mkdir(evidence, { mode: 0o700 });
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin: "http://127.0.0.1:9",
});
const loadLog = join(evidence, "renderer-loads.jsonl");
// Observe the actual native load boundary before production Main is imported.
// Old startup loaded the renderer before Pet handlers existed, independently
// of whether a fast machine happened to finish registering them in time.
await writeFile(
  fixture.mainEntry,
  (await readFile(fixture.mainEntry, "utf8")).replace(
    'import { app } from "electron";',
    `import { app, BrowserWindow, ipcMain } from "electron";
for (const method of ["loadFile", "loadURL"]) {
  const original = BrowserWindow.prototype[method];
  BrowserWindow.prototype[method] = function (...args) {
    const missing = ["pet:get-snapshot", "pet:set-active-session", "pet:get-attention"]
      .filter(channel => !ipcMain._invokeHandlers.has(channel));
    appendFileSync(${JSON.stringify(loadLog)}, JSON.stringify({ method, missing, windowId: this.id }) + "\\n");
    return original.apply(this, args);
  };
}`,
  ),
  { mode: 0o600 },
);
const reports = [];
let app;
try {
  for (let cycle = 1; cycle <= 3; cycle++) {
    app = await launchCodeShellElectron({
      appDir,
      ...isolated,
      env: fixture.env,
      mainEntry: fixture.mainEntry,
    });
    const win = await findCodeShellWindow(app);
    const errors = captureRendererErrors(win);
    await win.waitForFunction(() => Boolean(window.codeshell?.pet));
    await win.evaluate(async () => {
      await window.codeshell.pet.setActiveSession(null);
      await window.codeshell.pet.getSnapshot();
    });
    await win.reload();
    await win.waitForFunction(() => Boolean(window.codeshell?.pet));
    await win.evaluate(() => window.codeshell.pet.setActiveSession(null));
    if (cycle === 1) {
      const opened = app.waitForEvent("window");
      await win.evaluate(() => window.codeshell.newWindow());
      const other = await opened;
      const otherErrors = captureRendererErrors(other);
      await other.waitForFunction(() => Boolean(window.codeshell?.pet));
      await other.evaluate(async () => {
        await window.codeshell.pet.setActiveSession(null);
        await window.codeshell.pet.getSnapshot();
      });
      assert.deepEqual(otherErrors, []);
      await other.close();
    }
    assert.deepEqual(errors, []);
    await app.close();
    app = undefined;
    reports.push({ operation: `cold launch ${cycle} and renderer reload`, errors: [] });
  }
  const loads = (await readFile(loadLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(loads.length, 4, "Three cold loads and one additional main window");
  assert.ok(
    loads.every((entry) => entry.missing.length === 0),
    JSON.stringify(loads),
  );
  reports.push({
    operation: "first native renderer load in all windows",
    result: "all Pet handlers registered before load",
    loads,
  });
  await writeFile(join(evidence, "report.json"), JSON.stringify({ reports }, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ result: "pass", reports, evidence }));
} finally {
  await app?.close();
}
