/*
 * Real Electron E2E for the independent Panel App security boundary.
 *
 * The unit suite mocks Electron so it can exercise every bridge branch quickly.
 * This suite boots the packaged renderer/main/preload stack, attaches a real
 * sandboxed <webview>, and proves that an installed app can only reach the
 * scoped Host API. An Agent Plugin fixture is installed separately so this test
 * also proves Panel App updates do not own plugin automation content.
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
const isolated = await makeIsolatedElectronHome("codeshell-panel-app-e2e-");
const home = isolated.home;
const pluginDir = join(home, ".code-shell", "plugins", "panel-e2e");
const panelAppDir = join(home, ".code-shell", "panel-apps", "panel-e2e");
const panelAssetsDir = join(panelAppDir, "app");
const panelSourceDir = join(home, "panel-source");
const panelSourceAssetsDir = join(panelSourceDir, "app");
const projectDir = join(home, "project-e2e");
const installedAt = new Date().toISOString();

let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installFixture(version, marker, installSnapshot = true) {
  const manifest = {
    schemaVersion: 2,
    id: "panel-e2e",
    version,
    title: { default: "E2E Panel App" },
    entry: "app/index.html",
    icon: "panel",
    placement: "right-dock",
    singleton: true,
    permissions: ["context.session", "context.workspace", "storage"],
    agent: {
      tools: [
        {
          name: "echo_marker",
          description: "Return the fixture marker and provided value.",
          inputSchema: {
            type: "object",
            properties: { value: {} },
          },
          readOnly: true,
        },
      ],
      skills: ["agent/skills/panel-e2e/SKILL.md"],
    },
  };
  const html =
    '<!doctype html><html><body><main id="marker"></main><script src="./app.js"></script></body></html>\n';
  const script = [
    `document.getElementById("marker").textContent = ${JSON.stringify(marker)};`,
    `window.codeshellPanel.registerTool("echo_marker", async (args) => ({ marker: ${JSON.stringify(
      marker,
    )}, value: args.value ?? null }));`,
    "",
  ].join("\n");

  await mkdir(join(panelSourceDir, ".codeshell-panel"), { recursive: true });
  await mkdir(panelSourceAssetsDir, { recursive: true });
  await mkdir(join(panelSourceDir, "agent", "skills", "panel-e2e"), { recursive: true });
  await writeFile(
    join(panelSourceDir, ".codeshell-panel", "panel.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  await writeFile(join(panelSourceAssetsDir, "index.html"), html);
  await writeFile(join(panelSourceAssetsDir, "app.js"), script);
  await writeFile(
    join(panelSourceDir, "agent", "skills", "panel-e2e", "SKILL.md"),
    "---\nname: panel-e2e\ndescription: E2E Panel App Skill.\n---\n",
  );

  if (installSnapshot) {
    await mkdir(join(panelAppDir, ".codeshell-panel"), { recursive: true });
    await mkdir(panelAssetsDir, { recursive: true });
    await mkdir(join(panelAppDir, "agent", "skills", "panel-e2e"), { recursive: true });
    await writeFile(
      join(panelAppDir, ".codeshell-panel", "panel.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    await writeFile(
      join(panelAppDir, ".cs-panel-app-meta.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "panel-e2e",
        version,
        source: panelSourceDir,
        installedAt,
      })}\n`,
    );
    await writeFile(join(panelAssetsDir, "index.html"), html);
    await writeFile(join(panelAssetsDir, "app.js"), script);
    await writeFile(
      join(panelAppDir, "agent", "skills", "panel-e2e", "SKILL.md"),
      "---\nname: panel-e2e\ndescription: E2E Panel App Skill.\n---\n",
    );
    await writeFile(
      join(home, ".code-shell", "panel-apps", "installed.json"),
      `${JSON.stringify({
        version: 1,
        apps: [
          {
            id: "panel-e2e",
            version,
            source: panelSourceDir,
            installedAt,
            lastUpdated: new Date().toISOString(),
          },
        ],
      })}\n`,
    );
  }

  // A separate Agent Plugin owns the automation template.
  await mkdir(pluginDir, { recursive: true });
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

async function descriptor(win, appId = "panel-e2e") {
  const apps = await win.evaluate((cwd) => window.codeshell.listPanelApps(cwd, "en"), projectDir);
  const panel = apps.find((candidate) => candidate.appId === appId);
  assert(panel, `expected installed Panel App '${appId}', got ${apps.length} app(s)`);
  return panel;
}

async function attachPanel(win, panel, prepared) {
  await win.evaluate(({ src, partition }) => {
    document.getElementById("panel-app-e2e")?.remove();
    const view = document.createElement("webview");
    view.id = "panel-app-e2e";
    view.setAttribute("partition", partition);
    view.setAttribute("src", src);
    view.style.width = "640px";
    view.style.height = "480px";
    document.body.appendChild(view);
  }, prepared);
  const view = win.locator("#panel-app-e2e");
  await view.waitFor({ state: "attached" });
  await win.waitForFunction(() => {
    const candidate = document.getElementById("panel-app-e2e");
    return typeof candidate?.getWebContentsId === "function" && candidate.getWebContentsId() > 0;
  });
  const guestId = await view.evaluate((candidate) => candidate.getWebContentsId());
  await win.evaluate(
    ({ guestId: id, appDescriptorId, cwd }) =>
      window.codeshell.bindPanelApp({
        guestId: id,
        appDescriptorId,
        tabId: `tab:${appDescriptorId}`,
        bucket: "panel-app-e2e",
        sessionId: "session-e2e",
        projectPath: cwd,
        cwd,
        visible: true,
        busy: false,
        theme: "dark",
        locale: "en",
      }),
    { guestId, appDescriptorId: panel.id, cwd: projectDir },
  );
  return view;
}

async function execute(view, source) {
  return view.evaluate((candidate, script) => candidate.executeJavaScript(script), source);
}

try {
  await installFixture("1.0.0", "panel-v1");
  await mkdir(join(projectDir, ".code-shell"), { recursive: true });
  await writeFile(
    join(projectDir, ".code-shell", "settings.json"),
    `${JSON.stringify({ panelAppBindings: ["panel-e2e"] })}\n`,
  );
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

  const extensionsEntry = win.getByRole("button", { name: /^(扩展|Extensions)$/ });
  await extensionsEntry.waitFor({ state: "visible" });
  await extensionsEntry.click();
  const panelAppsTab = win.getByRole("button", { name: "Panel Apps" });
  await panelAppsTab.waitFor({ state: "visible" });
  await panelAppsTab.click();
  await win
    .getByRole("button", { name: /^(从 GitHub|From GitHub)$/ })
    .waitFor({ state: "visible" });

  const first = await descriptor(win);
  assert(first.agent?.tools[0]?.name === "echo_marker", "Panel App Agent tools were not listed");
  assert(
    first.agent?.skills[0] === "agent/skills/panel-e2e/SKILL.md",
    "Panel App Skill contribution was not listed",
  );
  const firstDetail = await win.evaluate(() => window.codeshell.getPluginDetail("panel-e2e@local"));
  const firstTemplate = firstDetail?.content.automationTemplates[0];
  assert(firstTemplate?.id === "daily-review", "automation template was not inventoried");
  assert(
    /^[a-f0-9]{64}$/.test(firstTemplate.revision),
    "automation template revision was not exposed",
  );
  const createdAutomation = await win.evaluate(
    ({ revision, cwd }) =>
      window.codeshell.createAutomationFromPluginTemplate(
        "panel-e2e@local",
        "daily-review",
        revision,
        cwd,
      ),
    { revision: firstTemplate.revision, cwd: projectDir },
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
    ({ id, cwd }) => window.codeshell.preparePanelApp(id, cwd),
    { id: first.id, cwd: projectDir },
  );
  assert(firstPrepared.revision === first.revision, "prepare/list revision mismatch");
  const firstView = await attachPanel(win, first, firstPrepared);

  await win.waitForFunction(async () => {
    const candidate = document.getElementById("panel-app-e2e");
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
  assert(sandbox.marker === "panel-v1", "Panel App asset did not load");
  assert(sandbox.hasBridge, "scoped preload bridge was not exposed");
  assert(!sandbox.hasProcess && !sandbox.hasRequire, "Node globals escaped into the panel");
  assert(!sandbox.popup, "plugin popup was not denied");

  const context = await execute(firstView, "window.codeshellPanel.getContext()");
  assert(context.sessionId === "session-e2e", "session permission was not scoped correctly");
  assert(context.cwd === projectDir, "workspace permission was not scoped correctly");
  assert(context.trusted === false, "workspace trust must be decided by main");
  assert(context.theme === "dark" && context.locale === "en", "host context was not bound");
  assert(context.apiVersion === 5, "Panel App bridge API v5 was not exposed");
  const agentToolResult = await win.evaluate(
    ({ appDescriptorId }) =>
      window.codeshell.invokePanelAppAgentTool({
        appDescriptorId,
        bucket: "panel-app-e2e",
        toolName: "echo_marker",
        arguments: { value: 42 },
      }),
    { appDescriptorId: first.id },
  );
  assert(
    agentToolResult.marker === "panel-v1" && agentToolResult.value === 42,
    "Panel App Agent tool did not execute through the sandbox bridge",
  );
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

  await installFixture("1.0.1", "panel-v2", false);
  const updatePreview = await win.evaluate(() =>
    window.codeshell.previewPanelAppUpdate("panel-e2e"),
  );
  assert(updatePreview.ok, `Panel App source update preview failed: ${updatePreview.error}`);
  assert(updatePreview.preview.version === "1.0.1", "source update preview used a stale manifest");
  const updateResult = await win.evaluate(
    ({ id, reviewToken }) => window.codeshell.installPanelAppUpdate({ id, reviewToken }),
    { id: "panel-e2e", reviewToken: updatePreview.preview.reviewToken },
  );
  assert(updateResult.ok, `Panel App source update failed: ${updateResult.error}`);
  const staleReviewRejected = await win.evaluate(
    async ({ revision, cwd }) => {
      try {
        await window.codeshell.createAutomationFromPluginTemplate(
          "panel-e2e@local",
          "daily-review",
          revision,
          cwd,
        );
        return false;
      } catch (error) {
        return String(error).includes("changed after review");
      }
    },
    { revision: firstTemplate.revision, cwd: projectDir },
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
    ({ id, cwd }) => window.codeshell.preparePanelApp(id, cwd),
    { id: second.id, cwd: projectDir },
  );
  assert(second.revision !== first.revision, "Panel App update did not change its revision");
  assert(second.hostId !== first.hostId, "Panel App update reused the stale authority");
  assert(
    secondPrepared.partition !== firstPrepared.partition,
    "Panel App update reused stale storage",
  );
  const secondView = await attachPanel(win, second, secondPrepared);
  await win.waitForFunction(async () => {
    const candidate = document.getElementById("panel-app-e2e");
    if (typeof candidate?.executeJavaScript !== "function") return false;
    return (
      (await candidate.executeJavaScript("document.getElementById('marker')?.textContent")) ===
      "panel-v2"
    );
  });
  assert(
    (await execute(secondView, "document.getElementById('marker')?.textContent")) === "panel-v2",
    "updated Panel App served stale assets",
  );

  console.log("Panel App Electron E2E: passed");
} finally {
  await app?.close().catch(() => undefined);
  await isolated.cleanup();
}
