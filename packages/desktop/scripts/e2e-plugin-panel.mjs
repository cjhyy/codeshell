/*
 * Real Electron E2E for the plugin-panel security boundary.
 *
 * The unit suite mocks Electron so it can exercise every bridge branch quickly.
 * This suite boots the packaged renderer/main/preload stack, attaches a real
 * sandboxed <webview>, and proves that an installed panel can only reach the
 * scoped API exposed by plugin-panel.cjs. It also simulates an installed-plugin
 * update and checks that the revision changes the origin/partition and reloads
 * the new assets.
 */
/* global document, window */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const isolated = await makeIsolatedElectronHome("codeshell-plugin-panel-e2e-");
const home = isolated.home;
const pluginDir = join(home, ".code-shell", "plugins", "panel-e2e");
const panelDir = join(pluginDir, "panels", "dashboard");
const installedAt = new Date().toISOString();

let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installFixture(version, marker) {
  await mkdir(panelDir, { recursive: true });
  await writeFile(
    join(pluginDir, ".cs-meta.json"),
    `${JSON.stringify({
      name: "panel-e2e",
      format: "codex",
      version,
      source: "e2e",
      installedAt: new Date().toISOString(),
    })}\n`,
  );
  await writeFile(
    join(pluginDir, ".cs-plugin-manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      name: "panel-e2e",
      version,
      panels: {
        version: 1,
        entries: [
          {
            id: "dashboard",
            title: { default: "E2E Dashboard" },
            entry: "panels/dashboard/index.html",
            icon: "plug",
            placement: "right-dock",
            singleton: true,
            permissions: ["context.session", "context.workspace", "storage"],
          },
        ],
      },
      automations: {
        version: 1,
        templates: [
          {
            id: "daily-review",
            title: { default: "E2E daily review" },
            schedule: "1d",
            prompt: `Review plugin marker ${marker} without changing files.`,
            permissionLevel: "read-only",
            workspace: "current",
          },
        ],
      },
    })}\n`,
  );
  await writeFile(
    join(panelDir, "index.html"),
    '<!doctype html><html><body><main id="marker"></main><script src="./app.js"></script></body></html>\n',
  );
  await writeFile(
    join(panelDir, "app.js"),
    `document.getElementById("marker").textContent = ${JSON.stringify(marker)};\n`,
  );
  const registryDir = join(home, ".code-shell", "plugins");
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, "installed_plugins.json"),
    `${JSON.stringify({
      version: 2,
      plugins: {
        "panel-e2e@local": [
          {
            scope: "user",
            installPath: pluginDir,
            version,
            installedAt,
            lastUpdated: new Date().toISOString(),
          },
        ],
      },
    })}\n`,
  );
}

async function descriptor(win) {
  const panels = await win.evaluate(() => window.codeshell.listPluginPanels("/tmp/e2e", "en"));
  assert(panels.length === 1, `expected one installed panel, got ${panels.length}`);
  return panels[0];
}

async function attachPanel(win, panel, prepared) {
  await win.evaluate(({ src, partition }) => {
    document.getElementById("plugin-panel-e2e")?.remove();
    const view = document.createElement("webview");
    view.id = "plugin-panel-e2e";
    view.setAttribute("partition", partition);
    view.setAttribute("src", src);
    view.style.width = "640px";
    view.style.height = "480px";
    document.body.appendChild(view);
  }, prepared);
  const view = win.locator("#plugin-panel-e2e");
  await view.waitFor({ state: "attached" });
  await win.waitForFunction(() => {
    const candidate = document.getElementById("plugin-panel-e2e");
    return typeof candidate?.getWebContentsId === "function" && candidate.getWebContentsId() > 0;
  });
  const guestId = await view.evaluate((candidate) => candidate.getWebContentsId());
  await win.evaluate(
    ({ guestId: id, panelId }) =>
      window.codeshell.bindPluginPanel({
        guestId: id,
        panelId,
        tabId: `tab:${panelId}`,
        bucket: "plugin-panel-e2e",
        sessionId: "session-e2e",
        cwd: "/tmp/e2e",
        visible: true,
        busy: false,
        theme: "dark",
        locale: "en",
      }),
    { guestId, panelId: panel.id },
  );
  return view;
}

async function execute(view, source) {
  return view.evaluate((candidate, script) => candidate.executeJavaScript(script), source);
}

try {
  await installFixture("1.0.0", "panel-v1");
  app = await launchCodeShellElectron({
    // Electron's instance lock follows userData, while core's plugin catalog
    // follows HOME. Isolate both so a developer's running CodeShell instance
    // and installed plugins cannot affect this test.
    appDir,
    home,
    userDataDir: isolated.userDataDir,
    env: {
      CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
    },
  });
  const win = await findCodeShellWindow(app);
  win.on("pageerror", (error) => console.error("renderer pageerror:", error.message));

  const first = await descriptor(win);
  const firstDetail = await win.evaluate(() => window.codeshell.getPluginDetail("panel-e2e@local"));
  const firstTemplate = firstDetail?.content.automationTemplates[0];
  assert(firstTemplate?.id === "daily-review", "automation template was not inventoried");
  assert(
    /^[a-f0-9]{64}$/.test(firstTemplate.revision),
    "automation template revision was not exposed",
  );
  const createdAutomation = await win.evaluate(
    ({ revision }) =>
      window.codeshell.createAutomationFromPluginTemplate(
        "panel-e2e@local",
        "daily-review",
        revision,
        "/tmp/e2e",
      ),
    { revision: firstTemplate.revision },
  );
  assert(
    createdAutomation.prompt === "Review plugin marker panel-v1 without changing files.",
    "automation did not copy the reviewed canonical prompt",
  );
  assert(
    createdAutomation.templateSource?.revision === firstTemplate.revision,
    "automation provenance did not retain the reviewed revision",
  );
  const firstPrepared = await win.evaluate(
    (id) => window.codeshell.preparePluginPanel(id),
    first.id,
  );
  assert(firstPrepared.revision === first.revision, "prepare/list revision mismatch");
  const firstView = await attachPanel(win, first, firstPrepared);

  await win.waitForFunction(async () => {
    const candidate = document.getElementById("plugin-panel-e2e");
    if (typeof candidate?.executeJavaScript !== "function") return false;
    return (
      (await candidate.executeJavaScript("document.getElementById('marker')?.textContent")) ===
      "panel-v1"
    );
  });
  const sandbox = await execute(
    firstView,
    `({
      marker: document.getElementById("marker")?.textContent,
      hasBridge: typeof window.codeshellPanel === "object",
      hasProcess: typeof window.process !== "undefined",
      hasRequire: typeof window.require !== "undefined",
      popup: window.open("https://example.com") !== null
    })`,
  );
  assert(sandbox.marker === "panel-v1", "plugin asset did not load");
  assert(sandbox.hasBridge, "scoped preload bridge was not exposed");
  assert(!sandbox.hasProcess && !sandbox.hasRequire, "Node globals escaped into the panel");
  assert(!sandbox.popup, "plugin popup was not denied");

  const context = await execute(firstView, "window.codeshellPanel.getContext()");
  assert(context.sessionId === "session-e2e", "session permission was not scoped correctly");
  assert(context.cwd === "/tmp/e2e", "workspace permission was not scoped correctly");
  assert(context.trusted === false, "workspace trust must be decided by main");
  assert(context.theme === "dark" && context.locale === "en", "host context was not bound");
  await execute(
    firstView,
    'window.codeshellPanel.call("storage.set", { key: "answer", value: 42 })',
  );
  assert(
    (await execute(firstView, 'window.codeshellPanel.call("storage.get", { key: "answer" })')) ===
      42,
    "scoped storage round-trip failed",
  );
  const networkBlocked = await execute(
    firstView,
    'fetch("https://example.com").then(() => false, () => true)',
  );
  assert(networkBlocked, "CSP did not block external network access");

  await installFixture("1.0.1", "panel-v2");
  const staleReviewRejected = await win.evaluate(
    async ({ revision }) => {
      try {
        await window.codeshell.createAutomationFromPluginTemplate(
          "panel-e2e@local",
          "daily-review",
          revision,
          "/tmp/e2e",
        );
        return false;
      } catch (error) {
        return String(error).includes("changed after review");
      }
    },
    { revision: firstTemplate.revision },
  );
  assert(staleReviewRejected, "stale automation review was accepted after plugin update");
  const persistedAutomation = await win.evaluate(
    (id) => window.codeshell.getAutomation(id),
    createdAutomation.id,
  );
  assert(
    persistedAutomation?.prompt === "Review plugin marker panel-v1 without changing files.",
    "plugin update mutated an already-created standalone automation",
  );
  const second = await descriptor(win);
  const secondPrepared = await win.evaluate(
    (id) => window.codeshell.preparePluginPanel(id),
    second.id,
  );
  assert(second.revision !== first.revision, "plugin update did not change its revision");
  assert(second.hostId !== first.hostId, "plugin update reused the stale panel authority");
  assert(
    secondPrepared.partition !== firstPrepared.partition,
    "plugin update reused stale storage",
  );
  const secondView = await attachPanel(win, second, secondPrepared);
  await win.waitForFunction(async () => {
    const candidate = document.getElementById("plugin-panel-e2e");
    if (typeof candidate?.executeJavaScript !== "function") return false;
    return (
      (await candidate.executeJavaScript("document.getElementById('marker')?.textContent")) ===
      "panel-v2"
    );
  });
  assert(
    (await execute(secondView, "document.getElementById('marker')?.textContent")) === "panel-v2",
    "updated plugin panel served stale assets",
  );
  console.log("plugin-panel Electron E2E: passed");
} finally {
  await app?.close().catch(() => undefined);
  await isolated.cleanup();
}
