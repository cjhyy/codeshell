/*
 * Real Electron L1 + L2 smoke suite.
 *
 * L1 boots the production main/preload/renderer stack and mounts the four core
 * dock panels plus Settings. L2 sends real provider HTTP requests through the
 * engine to a local scripted SSE server, including tool execution and cache
 * usage. HOME, CODE_SHELL_HOME, Electron userData, and provider credentials are
 * all temporary, so the suite cannot read or mutate a developer's profile.
 */
/* global document, localStorage */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const isolated = await makeIsolatedElectronHome("codeshell-smoke-");
const mock = await startMockProviderServer();
let app;

async function writeFixtureConfig() {
  await mkdir(isolated.codeShellHome, { recursive: true });
  const presets = ["plain-text", "tool-call", "usage-with-cache", "error-then-ok"].map(
    (scenario) => ({
      value: scenario,
      label: `Smoke ${scenario}`,
      maxContextTokens: 200_000,
      maxOutputTokens: 4_096,
      supportsVision: false,
    }),
  );
  await writeFile(
    join(isolated.codeShellHome, "model-catalog.user.json"),
    `${JSON.stringify(
      [
        {
          id: "codeshell-smoke-openai",
          tag: "text",
          adapterKind: "openai",
          protocol: "openai-compat",
          displayName: "CodeShell Smoke OpenAI",
          description: "Local provider-wire smoke fixture",
          defaultBaseUrl: mock.baseUrl,
          defaultModel: "plain-text",
          needsKey: true,
          modelPresets: presets,
        },
      ],
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const credentials = [
    {
      id: "codeshell-smoke-key",
      catalogId: "codeshell-smoke-openai",
      apiKey: "sk-codeshell-smoke",
      baseUrl: mock.baseUrl,
    },
  ];
  const modelConnections = presets.map((preset) => ({
    id: `mock-${preset.value}`,
    catalogId: "codeshell-smoke-openai",
    tag: "text",
    model: preset.value,
    credentialId: "codeshell-smoke-key",
  }));
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    `${JSON.stringify(
      {
        autoUpdates: false,
        memories: { autoExtract: false },
        permissions: { defaultMode: "bypassPermissions", rules: [] },
        credentials,
        modelConnections,
        defaults: { text: "mock-plain-text" },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function sendScenario(win, modelKey, prompt) {
  const modelButton = win.locator("button[data-active-model]");
  await modelButton.waitFor({ state: "visible", timeout: 20_000 });
  if ((await modelButton.getAttribute("data-active-model")) !== modelKey) {
    await modelButton.click();
    const option = win.locator(`[data-model-key="${modelKey}"]`);
    await option.waitFor({ state: "visible", timeout: 10_000 });
    await option.click();
    await win.waitForFunction(
      (key) =>
        document.querySelector("button[data-active-model]")?.getAttribute("data-active-model") ===
        key,
      modelKey,
    );
  }
  const before = await win.locator('[data-message-kind="assistant"]').count();
  const composer = win.locator("textarea:visible").last();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await composer.fill(prompt);
  await composer.press("Enter");
  await win.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-message-kind="assistant"][data-message-state="done"]')
        .length > count,
    before,
    { timeout: 30_000 },
  );
}

async function openPanelDock(win) {
  const toggle = win.locator('[data-panel-action="toggle"]');
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await win
    .locator('[data-panel-id="files"]')
    .or(win.getByRole("button", { name: /文件|Files/i }))
    .first()
    .waitFor({
      state: "visible",
      timeout: 10_000,
    });
}

async function mountCorePanels(win) {
  await openPanelDock(win);
  for (const panel of ["files", "browser", "review", "terminal"]) {
    const active = win.locator(`[data-panel-id="${panel}"][data-panel-active="true"]`);
    if ((await active.count()) === 0) {
      await win.locator('[role="menu"]:visible').waitFor({ state: "detached", timeout: 2_000 }).catch(() => undefined);
      const plus = win.locator('[data-panel-action="new-tab"]:visible');
      await plus.click();
      const menuItem = win.locator(`[data-panel-menu-kind="${panel}"]`);
      await menuItem.waitFor({ state: "visible", timeout: 10_000 });
      await menuItem.click();
    } else {
      const tab = win
        .locator(`[data-panel-id="${panel}"]`)
        .locator("xpath=preceding-sibling::*[1]");
      await tab.click().catch(() => undefined);
    }
    const slot = win.locator(`[data-panel-id="${panel}"][data-panel-active="true"]`);
    await slot.waitFor({ state: "attached", timeout: 10_000 });
    if (panel === "terminal") {
      await slot.locator(".xterm").waitFor({ state: "attached", timeout: 15_000 });
    }
    if (panel === "browser") {
      const address = slot.locator('input[placeholder*="URL"]');
      await address.fill(`${mock.origin}/fixture`);
      await address.press("Enter");
      await win.waitForFunction(
        (origin) =>
          document
            .querySelector('[data-panel-id="browser"][data-panel-active="true"] webview')
            ?.getAttribute("src")
            ?.startsWith(origin) === true,
        mock.origin,
      );
    }
    console.log(`smoke L1: ${panel} panel mounted`);
  }
}

async function openSettings(win) {
  const settings = win.getByRole("button", { name: /设置|Settings/i }).last();
  await settings.click();
  const open = win.getByText(/打开设置|Open settings/i).first();
  if (await open.isVisible().catch(() => false)) await open.click();
  await win.waitForFunction(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === "settings_page"
      );
    } catch {
      return false;
    }
  });
  console.log("smoke L1: settings page opened");
}

try {
  await writeFixtureConfig();
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  const win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.locator("#root").waitFor({ state: "visible", timeout: 20_000 });

  await win.waitForFunction(
    () =>
      document.querySelector("button[data-active-model]")?.getAttribute("data-active-model") ===
      "mock-plain-text",
    undefined,
    { timeout: 20_000 },
  );
  await sendScenario(win, "mock-plain-text", "Run the plain provider smoke scenario.");
  assert(
    (await win.locator('[data-message-kind="assistant"][data-message-state="done"]').count()) > 0,
    "L2 plain-text did not render a completed assistant block",
  );
  console.log("smoke L2: plain streaming assistant rendered");

  await sendScenario(win, "mock-tool-call", "Run the provider tool-call smoke scenario.");
  try {
    await win
      .locator('[data-message-kind="process"][data-tool-names~="Glob"]')
      .last()
      .waitFor({
        state: "attached",
        timeout: 20_000,
      });
  } catch (error) {
    const providerRequests = mock.requests
      .filter((request) => request.scenario === "tool-call")
      .map((request) => ({
        protocol: request.protocol,
        roles: request.body.messages?.map((message) => message.role),
      }));
    const mainText = await win.locator("main").innerText().catch(() => "");
    throw new Error(
      `tool-call card was not rendered; providerRequests=${JSON.stringify(providerRequests)} ` +
        `main=${JSON.stringify(mainText.slice(-1_000))}`,
      { cause: error },
    );
  }
  console.log("smoke L2: tool call executed and rendered");

  await sendScenario(win, "mock-usage-with-cache", "Run the provider cache usage smoke scenario.");
  await win.waitForFunction(() => {
    const ring = document.querySelector("[data-context-used]");
    return (
      Number(ring?.getAttribute("data-context-used") ?? 0) > 0 &&
      Number(ring?.getAttribute("data-cache-read") ?? 0) > 0
    );
  });
  console.log("smoke L2: usage and cache metrics reached the composer");

  await sendScenario(win, "mock-error-then-ok", "Run the provider retry smoke scenario.");
  const retryRequests = mock.requests.filter(
    (request) => request.protocol === "openai" && request.scenario === "error-then-ok",
  );
  assert(retryRequests.length >= 2, "L2 retry scenario did not make a second provider request");
  console.log("smoke L2: provider retry recovered from scripted 429");

  await mountCorePanels(win);
  await openSettings(win);
  assert(rendererErrors.length === 0, `renderer emitted ${rendererErrors.length} page error(s)`);
  console.log("CodeShell Electron smoke: passed");
} finally {
  await app?.close().catch(() => undefined);
  await mock.close().catch(() => undefined);
  await isolated.cleanup();
}
