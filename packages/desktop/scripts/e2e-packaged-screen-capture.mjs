/* global window, document */
/* macOS candidate acceptance. Run via scripts/run-isolated-node-smoke.mjs
 * with a signed .app and a new receipt path. The capture preflight never requests
 * access. Both routes read actual media tracks from their own fixture windows. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { release } from "node:os";
import { join, resolve } from "node:path";
import {
  findCodeShellWindow,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { preparePackagedPetFixture } from "./packaged-pet-fixture.mjs";
import { capturePage, captureScript, markerPage } from "./screen-capture-marker.mjs";

assert.equal(process.platform, "darwin", "macOS signed application required");
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
const [appPath, receiptPath] = process.argv.slice(2);
assert.ok(appPath?.endsWith(".app") && receiptPath, "Expected .app and a new JSON receipt path");
const officialApp = resolve(appPath);
const panelId = "screen-capture-fixture";

async function installPanel(codeShellHome, projectPath) {
  const base = join(codeShellHome, "panel-apps"),
    panel = join(base, panelId);
  const installedAt = new Date().toISOString();
  const source = "https://example.invalid/screen-capture-fixture.git";
  const metadata = { id: panelId, version: "1.0.0", source, installedAt };
  const manifest = {
    schemaVersion: 2,
    id: panelId,
    version: metadata.version,
    title: { default: "Capture test" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    placement: "right-dock",
    permissions: ["context.workspace", "media.capture"],
  };
  const json = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await mkdir(join(panel, ".codeshell-panel"), { recursive: true });
  await mkdir(join(panel, "app"));
  await mkdir(join(projectPath, ".code-shell"), { recursive: true });
  await mkdir(join(codeShellHome, "desktop"), { recursive: true });
  await Promise.all([
    json(join(panel, ".codeshell-panel", "panel.json"), manifest),
    json(join(panel, ".cs-panel-app-meta.json"), { schemaVersion: 1, ...metadata }),
    json(join(base, "installed.json"), {
      version: 1,
      apps: [{ ...metadata, lastUpdated: installedAt }],
    }),
    json(join(projectPath, ".code-shell", "settings.json"), { panelAppBindings: [panelId] }),
    json(join(codeShellHome, "desktop", "recents.json"), [
      { path: projectPath, name: "Capture test", lastOpenedAt: Date.now() },
    ]),
    writeFile(join(panel, "app", "index.html"), capturePage),
    writeFile(join(panel, "app", "read-frame.js"), captureScript),
  ]);
}

async function openPanel(workbench, projectPath) {
  const prepared = await workbench.evaluate(
    async ({ cwd, id }) => {
      const api = window.codeshell;
      await api.setTrust(cwd, "trusted");
      const binding = (await api.getPanelAppBindings(cwd)).find((row) => row.appId === id);
      if (!binding) throw Error("Capture Panel not installed");
      if (!binding.bound) await api.setPanelAppProjectBinding(cwd, id, true, binding.revision);
      const descriptor = (await api.listPanelApps(cwd, "en")).find((row) => row.appId === id);
      if (!descriptor) throw Error("Capture Panel not bound");
      return api.preparePanelApp(descriptor.id, cwd);
    },
    { cwd: projectPath, id: panelId },
  );
  await workbench.evaluate(({ partition, src }) => {
    const guest = document.createElement("webview");
    guest.id = "capture-test-panel";
    guest.setAttribute("partition", partition);
    guest.setAttribute("src", src);
    guest.style.cssText = "position:fixed;inset:20px;width:600px;height:360px;z-index:2000";
    document.body.appendChild(guest);
  }, prepared);
  await workbench.waitForFunction((src) => {
    const guest = document.getElementById("capture-test-panel");
    try {
      return guest.getURL() === src && !guest.isLoading();
    } catch {
      return false;
    }
  }, prepared.src);
  return workbench.evaluate(
    async ({ cwd, id }) => {
      const guestId = document.getElementById("capture-test-panel").getWebContentsId();
      await window.codeshell.bindPanelApp({
        guestId,
        appDescriptorId: id,
        tabId: "capture-test-tab",
        bucket: "capture-test-bucket",
        sessionId: "capture-test-session",
        projectPath: cwd,
        cwd,
        visible: true,
        busy: false,
        theme: "dark",
        locale: "en",
      });
      return guestId;
    },
    { cwd: projectPath, id: prepared.id },
  );
}

async function preparePicker(application) {
  const nonce = randomUUID();
  const sources = ["PANEL", "CLOUD"].map((text) => {
    const title = `capture-${text}-${nonce}`;
    return { text, title, html: markerPage(text, title) };
  });
  await application.evaluate(async ({ BrowserWindow, desktopCapturer, dialog }, sources) => {
    const windows = new Map();
    for (const { html, text, title } of sources) {
      const win = new BrowserWindow({
        width: 480,
        height: 240,
        useContentSize: true,
        frame: false,
        title,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      win.showInactive();
      await win.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      windows.set(text, { win, title, id: win.getMediaSourceId() });
    }
    const state = { target: null, choices: 0, windows };
    globalThis.captureFixture = state;
    const nativeSources = desktopCapturer.getSources.bind(desktopCapturer);
    desktopCapturer.getSources = async (options) => {
      const target = windows.get(state.target);
      if (
        !target ||
        target.win.isDestroyed() ||
        !options.types.includes("window") ||
        options.thumbnailSize?.width !== 0 ||
        options.thumbnailSize?.height !== 0
      )
        throw Error("An unscoped capture request reached the test picker");
      // Enumerate OS window identifiers. Drop all other metadata without requesting
      // thumbnails or icons. No other window or display can reach the media callback.
      const candidates = await nativeSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const match = candidates.find(
        (source) => source.id === target.id && source.name === target.title,
      );
      if (!match) throw Error("Native capture source missing for owned window");
      return [match];
    };
    const nativeDialog = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (...args) => {
      const options = args.at(-1);
      const target = windows.get(state.target);
      if (options.title !== "选择要录制的画面") return nativeDialog(...args);
      const choices = options.buttons;
      if (!target || choices.length !== 2 || choices[1] !== target.title)
        throw Error("Unexpected capture source offered");
      state.choices++;
      return Promise.resolve({ response: 1, checkboxChecked: false });
    };
  }, sources);
}
async function getReceipt(application, route, webContentsId) {
  const receipt = await application.evaluate(
    async ({ webContents }, { route, webContentsId }) => {
      const state = globalThis.captureFixture;
      const contents = webContents.fromId(webContentsId);
      const before = state.choices;
      state.target = route;
      try {
        const text = await contents.executeJavaScript(
          `(async () => {
        document.querySelector("button").click();
        const start = Date.now();
        while (Date.now() - start < 12000) {
          if (document.body.dataset.receipt) return document.body.dataset.receipt;
          await new Promise(resolve => setTimeout(resolve,100));
        }
        throw Error("Timed out waiting for media track");
      })()`,
          true,
        );
        return { ...JSON.parse(text), selected: state.choices - before };
      } finally {
        state.target = null;
      }
    },
    { route, webContentsId },
  );
  assert.equal(receipt.error, undefined, receipt.error);
  assert.equal(receipt.selected, 1);
  assert.equal(receipt.text, route);
  assert.ok(receipt.width > 0 && receipt.height > 0);
  return receipt;
}

const server = createServer((req, res) => {
  if (req.url === "/")
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(capturePage);
  else if (req.url === "/read-frame.js")
    res.writeHead(200, { "content-type": "text/javascript" }).end(captureScript);
  else res.writeHead(404).end();
});
const root = await makeIsolatedElectronHome("codeshell-screen-capture-");
const home = join(root.home, "profile"),
  codeShellHome = join(home, ".code-shell");
const report = { status: "failed", app: officialApp, darwin: release(), arch: process.arch };
let application, fixture, cleanupError;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(codeShellHome, { recursive: true, mode: 0o700 });
  await seedOfflinePluginBootstrap(codeShellHome);
  const projectPath = join(home, "project");
  await installPanel(codeShellHome, projectPath);
  fixture = await preparePackagedPetFixture({
    officialApp,
    origin,
    isolated: { home, codeShellHome, userDataDir: join(home, "chromium") },
    fixtureRoot: root.home,
    mockKeychain: true,
    requireWorkerEvidence: false,
  });
  report.appTreeSHA256 = fixture.diagnosticContext().appTreeSHA256;
  application = await fixture.launch();
  const workbench = await findCodeShellWindow(application);
  await workbench.waitForFunction(
    () =>
      typeof window.codeshell?.preparePanelApp === "function" &&
      !!document.querySelector('[data-sidebar-action="toggle"]'),
  );
  await workbench.waitForFunction(async () => {
    try {
      return Array.isArray(await window.codeshell.projectRegistry.list());
    } catch {
      return false;
    }
  });
  const appIdentity = await application.evaluate(({ systemPreferences, app }) => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    permission: systemPreferences.getMediaAccessStatus("screen"),
  }));
  Object.assign(report, appIdentity);
  assert.match(
    appIdentity.version,
    /^0\.12\.\d+(?:-rc\.\d+)?$/,
    "Expected a 0.12 capture candidate",
  );
  if (appIdentity.permission !== "granted") {
    report.status = "permission-required";
    throw Error(`Screen Recording for ${officialApp} is ${appIdentity.permission}`);
  }
  const panel = await openPanel(workbench, projectPath);
  await workbench.evaluate((url) => window.codeshell.openCloudWorkbench(url), origin);
  const cloud = await application.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((row) => row.getURL() === url + "/");
    if (!wc) throw Error("Loopback cloud workbench did not open");
    return wc.id;
  }, origin);
  await preparePicker(application);
  report.panel = await getReceipt(application, "PANEL", panel);
  report.cloudWorkbench = await getReceipt(application, "CLOUD", cloud);
  report.status = "passed";
} finally {
  try {
    if (application) {
      await application.close();
      await fixture.verifyUnchanged();
      assert.ok(await fixture.canCleanup(), "The packaged fixture did not confirm a clean exit");
    }
  } catch (error) {
    report.status = "failed";
    cleanupError = error;
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (!fixture || (await fixture.canCleanup())) await root.cleanup();
    await writeFile(resolve(receiptPath), JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
}
if (cleanupError) throw cleanupError;
console.log("Panel and cloud workbench read distinct lettering from their native capture streams.");
