import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
if (!process.env.CODE_SHELL_TEST_HOME) throw Error("isolated native runner required");
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
// Parent imports no Core/Host. Its maintained harness owns dynamic CDP sockets;
// Main and any worker install the exact-origin guard before Host imports below.
process.env.DEBUG = "pw:browser*";
const { assert, captureRendererErrors, findCodeShellWindow, launchCodeShellElectron, makeIsolatedElectronHome } = await import(pathToFileURL(join(repo, "packages/desktop/scripts/electron-harness.mjs")).href);
const { prepareConfinedElectronFixture } = await import(pathToFileURL(join(repo, "packages/desktop/scripts/confined-electron-fixture.mjs")).href);
const isolated = await makeIsolatedElectronHome("codeshell-reload-identity-round14-");
const appDir = join(repo, "packages/desktop");
const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: "http://127.0.0.1:9" });
let app;
try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(join(isolated.codeShellHome, "settings.json"), JSON.stringify({ autoUpdates: false }));
  app = await launchCodeShellElectron({ appDir, home: isolated.home, userDataDir: isolated.userDataDir, env: fixture.env, mainEntry: fixture.mainEntry });
  const win = await findCodeShellWindow(app);
  await win.route("http://**/*", route => route.abort());
  await win.route("https://**/*", route => route.abort());
  const errors = captureRendererErrors(win);
  const snapshots = [];
  async function snapshot() {
    await win.waitForFunction(() => Boolean(window.codeshell?.windowToken));
    const token = await win.evaluate(() => window.codeshell.windowToken);
    const handle = await app.browserWindow(win);
    const owner = await handle.evaluate(window => {
      const key = Symbol.for("codeshell.review.round14.reload-owner");
      const previous = globalThis[key];
      globalThis[key] = window.webContents;
      return { webContentsId: window.webContents.id, rendererPid: window.webContents.getOSProcessId(), sameOwnerObject: previous === undefined || previous === window.webContents };
    });
    await handle.dispose();
    snapshots.push({ token, ...owner });
  }
  await snapshot();
  await win.reload();
  await snapshot();
  await win.reload();
  await snapshot();
  const guard = await fixture.assertWorker(app, { requireWorker: false });
  assert(guard.workerCreated === false, "Identity-only fixture must not create a worker");
  assert(snapshots.every(value => value.token === snapshots[0].token), "Ordinary reload unexpectedly changed windowToken");
  assert(snapshots.every(value => value.webContentsId === snapshots[0].webContentsId), "Ordinary reload unexpectedly changed webContents owner");
  assert(snapshots.every(value => value.sameOwnerObject), "Ordinary reload unexpectedly changed WebContents object identity");
  assert(errors.length === 0, "Renderer errors in identity-only fixture");
  const result = { snapshots, sameTokenAcrossTwoReloads: true, sameOwnerAcrossTwoReloads: true, workerCreated: false, terminalOpened: false, actualPtyStarted: false, rendererErrors: errors, guard };
  await writeFile(new URL("./reload-identity.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally { await app?.close(); await isolated.cleanup(); }
