/*
 * Real Electron L1 + L2 smoke suite.
 *
 * L1 boots the production main/preload/renderer stack and mounts the four core
 * dock panels plus Settings. L2 sends real provider HTTP requests through the
 * engine to a local scripted SSE server, including tool execution and cache
 * usage. HOME, CODE_SHELL_HOME, Electron userData, and provider credentials are
 * all temporary. Native safeStorage deliberately accesses the current user's
 * application-specific OS key storage through the ordinary Electron API.
 */
/* global document, localStorage, window */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const macosAcceptance = process.env.CODESHELL_MACOS_KEYCHAIN_ACCEPTANCE === "1";
const acceptanceEvidence = process.env.CODESHELL_MACOS_ACCEPTANCE_EVIDENCE;
if (macosAcceptance && (process.platform !== "darwin" || !acceptanceEvidence))
  throw new Error("macOS Keychain acceptance requires its private launcher");
const isolated = await makeIsolatedElectronHome("codeshell-smoke-");
const mock = await startMockProviderServer();
const guardModule = macosAcceptance
  ? new URL("./macos-keychain-guard.mjs", import.meta.url).href
  : undefined;
const confinement = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin: mock.origin,
  guardModule,
  ...(macosAcceptance ? { guardReceiptReady: (receipt) => receipt.negativeProbes === 7 } : {}),
});
if (macosAcceptance) {
  const { bindPrivateKeychainContext, readKeychainReference } =
    await import("./macos-keychain-context.mjs");
  bindPrivateKeychainContext({
    home: isolated.home,
    root: process.env.CODESHELL_MACOS_ACCEPTANCE_ROOT,
    reference: readKeychainReference(process.env.CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE),
    receiptFile: join(acceptanceEvidence, "Electron-keychain-context.json"),
  });
}
const ownedControl = macosAcceptance
  ? (await import("./owned-electron-control.mjs")).prepareOwnedElectronControl({
      appDir,
      mainEntry: confinement.mainEntry,
      home: isolated.home,
      receiptFile: join(isolated.home, "owned-control.jsonl"),
    })
  : undefined;
const parentGuard = macosAcceptance
  ? await (
      await import(guardModule)
    ).probeMacosKeychainGuard(
      mock.origin,
      join(isolated.home, "parent-network-guard.jsonl"),
      "parent",
    )
  : undefined;
ownedControl?.activate();
const launchEnvironment = {
  ...confinement.env,
  ...(macosAcceptance
    ? { CODESHELL_MACOS_ACCEPTANCE_ROOT: process.env.CODESHELL_MACOS_ACCEPTANCE_ROOT }
    : {}),
};
const projectPath = join(isolated.home, "smoke-project");
let app;
let win;
let acceptanceResult;
let smokePassed = false;
let restartedRendererErrors = [];
let unavailableCustodyAudit;

const unavailablePrompt = "Check the synthetic unavailable-keyring case.";
function fixtureRequestReceipts() {
  return mock.requests.map(({ protocol, scenario, body, at }) => ({
    protocol,
    scenario,
    receivedAt: at,
    bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    containsUnavailableInput: JSON.stringify(body).includes(unavailablePrompt),
  }));
}

async function acceptancePhase(phase) {
  if (!macosAcceptance) return;
  console.log(`macOS acceptance phase: ${phase}`);
  await writeFile(
    join(acceptanceEvidence, `phase-${phase}.json`),
    `${JSON.stringify({ phase, pid: process.pid, timestamp: Date.now() })}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

function inspectNativeStorage() {
  return app.evaluate(
    ({ app, safeStorage }, evidence) => {
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      const mark = (phase) => {
        if (!evidence) return;
        fs.writeFileSync(
          path.join(evidence, `Main-${process.pid}-${phase}.json`),
          `${JSON.stringify({ phase, pid: process.pid, ppid: process.ppid, timestamp: Date.now() })}\n`,
          { mode: 0o600, flag: "wx" },
        );
      };
      mark("before-encryption-available");
      const available = safeStorage.isEncryptionAvailable();
      mark("after-encryption-available");
      return {
        available,
        backend: process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : null,
        backendInspection:
          process.platform === "linux" ? "native API" : "not exposed on this platform",
        appName: app.getName(),
        mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
        passwordStore: app.commandLine.getSwitchValue("password-store"),
      };
    },
    macosAcceptance ? acceptanceEvidence : undefined,
  );
}

async function verifiedProcesses({ requireWorker = true } = {}) {
  const result = await confinement.assertWorker(app, { requireWorker });
  if (macosAcceptance) {
    const verified = result.receipts.filter((receipt) => receipt.negativeProbes === 7);
    assert(
      verified.some(
        (receipt) =>
          receipt.pid === result.mainPid && receipt.ppid === process.pid && receipt.role === "Main",
      ) &&
        result.spawned.every((worker) =>
          verified.some(
            (receipt) =>
              receipt.pid === worker.pid &&
              receipt.ppid === result.mainPid &&
              receipt.role === "worker",
          ),
        ),
      "Main/worker seven pre-Core negative probes are missing",
    );
    const bootstraps = (await readFile(join(isolated.home, "real-keyring-bootstrap.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bootstrap = bootstraps.find((receipt) => receipt.pid === result.mainPid);
    assert(
      bootstrap?.appName === "code-shell" && !bootstrap.mockKeychain && !bootstrap.passwordStore,
      "The synchronous pre-Main bootstrap did not remove mock/plaintext cryptography",
    );
    return {
      mainPid: result.mainPid,
      workerCreated: result.workerCreated,
      processes: verified,
      bootstrap,
    };
  }
  return result;
}

async function saveAcceptanceEvidence(phase, details = {}) {
  if (!macosAcceptance) return;
  for (const name of [
    "network-guard.jsonl",
    "spawned-workers.jsonl",
    "real-keyring-bootstrap.jsonl",
    "parent-network-guard.jsonl",
    "owned-control.jsonl",
  ])
    await writeFile(
      join(acceptanceEvidence, `${phase}-${name}`),
      await readFile(join(isolated.home, name)).catch(() => ""),
      { mode: 0o600, flag: "wx" },
    );
  await writeFile(
    join(acceptanceEvidence, `${phase}.json`),
    `${JSON.stringify({ parentGuard, unavailableCustodyAudit, ...details }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  if (win) await win.screenshot({ path: join(acceptanceEvidence, `${phase}.png`) }).catch(() => {});
}

async function writeFixtureConfig() {
  await mkdir(isolated.codeShellHome, { recursive: true });
  // Git review is available only in an actual repository. Keep its fixture
  // isolated while exercising the same project selection and authority as users.
  await mkdir(projectPath, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
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

/**
 * Guarantee an active session before typing. Idempotent: with a conversation
 * already open the empty-state button is absent and this returns immediately.
 */
async function dismissTrustDialog(win) {
  const dialog = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /信任此项目|Trust this project/i }) });
  const opened = await dialog
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return;
  await dialog.getByRole("button", { name: /信任并继续|Trust and continue/i }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function registerFixtureProject() {
  // Legacy recents are no longer project authority. Supply only this fixture's
  // private directory to the ordinary picker IPC, restoring the picker after
  // one use. This never changes Keychain APIs or any OS authorization dialog.
  await app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog;
    globalThis.__codeshellSmokeRestorePicker = () => {
      dialog.showOpenDialog = original;
      delete globalThis.__codeshellSmokeRestorePicker;
    };
    dialog.showOpenDialog = async () => {
      globalThis.__codeshellSmokeRestorePicker();
      return { canceled: false, filePaths: [path] };
    };
  }, projectPath);
  try {
    await win
      .getByRole("button", { name: /^(添加项目|Add project)$/ })
      .first()
      .click();
    await acceptancePhase("after-picker-click");
    const project = await win.evaluate(async (path) => {
      const projects = await window.codeshell.projectRegistry.list();
      return projects.find((entry) => entry.roots.some((root) => root.path === path));
    }, projectPath);
    assert(
      project?.roots.some((root) => root.path === projectPath),
      "The private fixture project was not registered through the production picker IPC",
    );
  } finally {
    await app.evaluate(() => globalThis.__codeshellSmokeRestorePicker?.());
  }
}

async function ensureConversation(win) {
  // The first launch in an isolated home raises the trust prompt over a modal
  // overlay that swallows every click, so it must go before anything else.
  // The other e2e scripts already do this; this one never did.
  await dismissTrustDialog(win);
  const newChat = win
    .locator("button")
    .filter({ hasText: /直接新建对话|New chat|新建对话/ })
    .first();
  if ((await newChat.count()) === 0) return;
  if (!(await newChat.isVisible().catch(() => false))) return;
  await newChat.click();
  // The composer only becomes usable once the session exists.
  await win.waitForFunction(
    () => [...document.querySelectorAll("textarea")].some((n) => n.offsetParent !== null),
    undefined,
    { timeout: 20_000 },
  );
}

async function sendScenario(win, modelKey, prompt, { expectedError } = {}) {
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
  const previousErrors = await win.getByText(/^Error: /).allTextContents();
  // A fresh isolated home has no project and no session, and the composer on
  // that welcome screen has nowhere to send: pressing Enter clears the textarea
  // and silently drops the input, so the run stalls waiting for a reply that
  // was never requested (the mock provider records zero requests). Create the
  // conversation first when none exists.
  await ensureConversation(win);
  const composer = win.locator("textarea:visible").last();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await composer.fill(prompt);
  await composer.press("Enter");
  await verifiedProcesses();
  await win.waitForFunction(
    ({ count, previousErrors }) =>
      document.querySelectorAll('[data-message-kind="assistant"][data-message-state="done"]')
        .length > count ||
      [...document.querySelectorAll("main div")].some(
        (node) =>
          node.children.length === 0 &&
          node.textContent?.startsWith("Error: ") &&
          !previousErrors.includes(node.textContent),
      ),
    { count: before, previousErrors },
    { timeout: 30_000 },
  );
  const errors = (await win.getByText(/^Error: /).allTextContents()).filter(
    (message) => !previousErrors.includes(message),
  );
  if (expectedError) {
    assert(
      errors.some((message) => message.includes(expectedError)),
      "Expected visible Host signing error",
    );
  } else {
    assert(errors.length === 0, `Provider scenario failed: ${errors.join("; ")}`);
  }
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
      await win
        .locator('[role="menu"]:visible')
        .waitFor({ state: "detached", timeout: 2_000 })
        .catch(() => undefined);
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
    mainEntry: confinement.mainEntry,
    env: launchEnvironment,
  });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.locator("#root").waitFor({ state: "visible", timeout: 20_000 });
  await dismissTrustDialog(win);
  await acceptancePhase("before-picker");
  await registerFixtureProject();
  await acceptancePhase("after-picker");
  await acceptancePhase("before-picker-trust");
  await dismissTrustDialog(win);
  await acceptancePhase("after-picker-trust");
  await acceptancePhase("before-project-click");
  await win
    .locator("#codeshell-sidebar-navigation")
    .getByRole("button", { name: basename(projectPath), exact: true })
    .click();
  await acceptancePhase("after-project-click");
  await acceptancePhase("before-trust");
  await dismissTrustDialog(win);
  await acceptancePhase("after-trust");
  await acceptancePhase("before-storage-inspection");
  const storage = await inspectNativeStorage();
  await acceptancePhase("after-storage-inspection");
  console.log(`Electron request custody: ${JSON.stringify(storage)}`);
  assert(
    storage.available &&
      !storage.mockKeychain &&
      storage.appName === "code-shell" &&
      (process.platform !== "linux" ||
        (storage.backend === "gnome_libsecret" && storage.passwordStore === "gnome-libsecret")),
    "Provider smoke requires actual OS key storage without Playwright's keychain mocks",
  );

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

  // The visible assistant block precedes fire-and-forget title completion.
  // Observe its actual durable callback before injecting failure so an already
  // signed title request cannot contaminate the zero-send measurement.
  const firstRunDeadline = Date.now() + 5_000;
  let firstRunSettled = false;
  do {
    firstRunSettled = await app.evaluate((_, home) => {
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      const directory = path.join(home, "sessions");
      const states = fs.readdirSync(directory).filter((name) => !name.startsWith("."));
      if (states.length !== 1) return false;
      const file = path.join(directory, states[0], "state.json");
      if (!fs.existsSync(file)) return false;
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      return (
        state.status === "completed" &&
        state.title === "The plain streaming smoke response completed."
      );
    }, isolated.codeShellHome);
    if (!firstRunSettled) await new Promise((done) => setTimeout(done, 100));
  } while (!firstRunSettled && Date.now() < firstRunDeadline);
  assert(firstRunSettled, "The first run and its actual auxiliary title callback did not settle");

  const beforeUnavailable = mock.requests.length;
  const beforeUnavailableRequests = fixtureRequestReceipts();
  await app.evaluate(({ safeStorage }) => {
    globalThis.__codeshellFixtureEncryptionAvailable = safeStorage.isEncryptionAvailable;
    globalThis.__codeshellFixtureUnavailableCalls = {
      injectedAt: Date.now(),
      calls: 0,
      pid: process.pid,
      ppid: process.ppid,
    };
    safeStorage.isEncryptionAvailable = () => {
      globalThis.__codeshellFixtureUnavailableCalls.calls++;
      globalThis.__codeshellFixtureUnavailableCalls.lastCalledAt = Date.now();
      return false;
    };
  });
  try {
    await sendScenario(win, "mock-plain-text", unavailablePrompt, {
      expectedError: "Host could not securely sign this Session",
    });
    assert(
      mock.requests.length === beforeUnavailable,
      "Unavailable custody sent a provider request",
    );
  } finally {
    const nativeCalls = await app.evaluate(({ safeStorage }) => {
      const calls = globalThis.__codeshellFixtureUnavailableCalls;
      safeStorage.isEncryptionAvailable = globalThis.__codeshellFixtureEncryptionAvailable;
      delete globalThis.__codeshellFixtureEncryptionAvailable;
      delete globalThis.__codeshellFixtureUnavailableCalls;
      return calls;
    });
    unavailableCustodyAudit = {
      nativeCalls,
      before: beforeUnavailableRequests,
      after: fixtureRequestReceipts(),
      zeroSends: mock.requests.length === beforeUnavailable,
    };
    if (macosAcceptance)
      await writeFile(
        join(acceptanceEvidence, "unavailable-custody.json"),
        `${JSON.stringify(unavailableCustodyAudit, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
  }
  console.log("smoke L2: unavailable keyring rendered a concrete error with zero provider sends");

  await sendScenario(win, "mock-tool-call", "Run the provider tool-call smoke scenario.");
  try {
    await win.locator('[data-message-kind="process"][data-tool-names~="Glob"]').last().waitFor({
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
    const mainText = await win
      .locator("main")
      .innerText()
      .catch(() => "");
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

  const verifyMainCustody = () =>
    app.evaluate(
      ({ safeStorage }, { home, requests }) => {
        // Recompute inside Main: the OS-decrypted key never leaves its Host.
        const fs = process.getBuiltinModule("node:fs");
        const path = process.getBuiltinModule("node:path");
        const crypto = process.getBuiltinModule("node:crypto");
        const ordered = (value) =>
          Array.isArray(value)
            ? value.map(ordered)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, ordered(value[key])]),
                )
              : value;
        const digest = (value) =>
          crypto
            .createHash("sha256")
            .update(JSON.stringify(ordered(JSON.parse(JSON.stringify(value)))))
            .digest("hex");
        const syntheticFile = path.join(home, "keychain-synthetic-roundtrip.json");
        if (!fs.existsSync(syntheticFile)) {
          const synthetic = crypto.randomBytes(32).toString("base64");
          const ciphertext = safeStorage.encryptString(synthetic);
          if (safeStorage.decryptString(ciphertext) !== synthetic)
            throw new Error("Native safeStorage synthetic round trip failed");
          fs.writeFileSync(
            syntheticFile,
            JSON.stringify({
              ciphertext: ciphertext.toString("base64"),
              digest: digest(synthetic),
            }),
            { mode: 0o600, flag: "wx" },
          );
        }
        const synthetic = JSON.parse(fs.readFileSync(syntheticFile, "utf8"));
        if (
          digest(safeStorage.decryptString(Buffer.from(synthetic.ciphertext, "base64"))) !==
          synthetic.digest
        )
          throw new Error(
            "Native safeStorage could not recover its persisted synthetic ciphertext",
          );
        const keysDirectory = path.join(home, "request-keys", "host-encrypted");
        if (process.platform !== "win32" && fs.statSync(keysDirectory).mode & 0o077)
          throw new Error("Request key directory is not owner-only");
        const keys = new Map();
        const keyRecordHashes = [];
        for (const file of fs.readdirSync(keysDirectory)) {
          if (!file.endsWith(".json")) continue;
          const filename = path.join(keysDirectory, file);
          if (process.platform !== "win32" && fs.statSync(filename).mode & 0o077)
            throw new Error("Request key file is not owner-only");
          const bytes = fs.readFileSync(filename);
          keyRecordHashes.push(crypto.createHash("sha256").update(bytes).digest("hex"));
          const record = JSON.parse(bytes.toString("utf8"));
          if (
            record.custodyMode !== "host-encrypted" ||
            !record.protectedKey.startsWith("enc:safeStorage:")
          )
            throw new Error("Electron request key did not use actual safeStorage custody");
          keys.set(
            record.keyId,
            Buffer.from(
              safeStorage.decryptString(
                Buffer.from(record.protectedKey.slice("enc:safeStorage:".length), "base64"),
              ),
              "base64",
            ),
          );
        }
        let boundaries = 0,
          attempts = 0;
        try {
          for (const sessionId of fs.readdirSync(path.join(home, "sessions"))) {
            if (sessionId.startsWith(".")) continue;
            const transcript = path.join(home, "sessions", sessionId, "transcript.jsonl");
            if (!fs.existsSync(transcript)) continue;
            const events = fs
              .readFileSync(transcript, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            const boundaryIds = new Set(
              events
                .filter((event) => event.type === "model_request_boundary")
                .map((event) => event.id),
            );
            boundaries += boundaryIds.size;
            for (const event of events.filter((event) => event.type === "model_request_attempt")) {
              const metadata = event.data;
              const key = keys.get(metadata.keyId);
              if (
                !key ||
                !boundaryIds.has(metadata.boundaryEventId) ||
                metadata.custodyMode !== "host-encrypted" ||
                metadata.persistence !== "durable"
              )
                throw new Error("Desktop request attempt has no durable Host-owned boundary");
              const sign = (domain, value) =>
                crypto
                  .createHmac("sha256", key)
                  .update(`codeshell:model-request:v1:${domain}:`)
                  .update(digest(value))
                  .digest("hex");
              if (
                !requests.some(
                  (body) =>
                    sign("wire", body) === metadata.wireDigest &&
                    sign(
                      "system",
                      body.messages.filter((message) =>
                        ["system", "developer"].includes(message.role),
                      ),
                    ) === metadata.systemPromptDigest &&
                    sign(
                      "messages",
                      body.messages.filter(
                        (message) => !["system", "developer"].includes(message.role),
                      ),
                    ) === metadata.messageDigest,
                )
              )
                throw new Error("Desktop proof does not match an actual fixture provider payload");
              attempts++;
            }
          }
          return {
            boundaries,
            attempts,
            encryptedKeys: keys.size,
            keyRecordsDigest: digest(keyRecordHashes.sort()),
            syntheticRoundTrip: true,
          };
        } finally {
          for (const key of keys.values()) key.fill(0);
        }
      },
      { home: isolated.codeShellHome, requests: mock.requests.map((request) => request.body) },
    );

  const proof = await verifyMainCustody();
  assert(
    proof.boundaries >= 5 && proof.attempts >= 6 && proof.encryptedKeys >= 1,
    "Desktop model proof coverage is incomplete",
  );
  console.log(
    `smoke L2: real OS custody and provider-wire HMACs verified ${JSON.stringify(proof)}`,
  );

  if (macosAcceptance) {
    const firstProcesses = await verifiedProcesses();
    await saveAcceptanceEvidence("before-restart", { storage, proof, ...firstProcesses });
    const beforeRestart = mock.requests.length;
    await app.close();
    app = undefined;
    win = undefined;
    // Preserve each generation's raw receipts before using fresh receipt files.
    await writeFile(join(isolated.home, "network-guard.jsonl"), "", { mode: 0o600 });
    await writeFile(join(isolated.home, "spawned-workers.jsonl"), "", { mode: 0o600 });
    app = await launchCodeShellElectron({
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: confinement.mainEntry,
      env: launchEnvironment,
    });
    win = await findCodeShellWindow(app);
    restartedRendererErrors = captureRendererErrors(win);
    const restartedProcesses = await verifiedProcesses({ requireWorker: false });
    assert(restartedProcesses.mainPid !== firstProcesses.mainPid, "Electron did not cold restart");
    const restartedProof = await verifyMainCustody();
    assert(
      JSON.stringify(restartedProof) === JSON.stringify(proof),
      "Cold Electron changed persistent keys or failed the original fixture-wire HMACs",
    );
    assert(
      mock.requests.length === beforeRestart,
      "Cold verification made another provider request",
    );
    const restartedStorage = await inspectNativeStorage();
    assert(
      restartedStorage.available &&
        !restartedStorage.mockKeychain &&
        !restartedStorage.passwordStore &&
        restartedStorage.appName === "code-shell",
      "Cold Electron did not retain real OS cryptography settings",
    );
    acceptanceResult = {
      realMacosKeychainApi: true,
      coldElectronRestart: true,
      originalWireHmacVerifiedInMain: true,
      persistentCiphertextAndKeyIdentityUnchanged: true,
      restartProviderRequests: mock.requests.length - beforeRestart,
      providerRequests: beforeRestart,
      firstProcesses,
      restartedProcesses,
      storage: restartedStorage,
      proof: restartedProof,
      boundary:
        "official macOS Keychain API contract and native runtime evidence; no independent OS attestation",
    };
    await saveAcceptanceEvidence("after-restart", acceptanceResult);
    console.log(`macOS Keychain acceptance: ${JSON.stringify(acceptanceResult)}`);
  }

  await mountCorePanels(win);
  await openSettings(win);
  const pageErrors = rendererErrors.length + restartedRendererErrors.length;
  assert(pageErrors === 0, `renderer emitted ${pageErrors} page error(s)`);
  console.log("CodeShell Electron smoke: passed");
  smokePassed = true;
} finally {
  if (macosAcceptance && !smokePassed)
    await saveAcceptanceEvidence("failed", { keychainResult: acceptanceResult }).catch((error) =>
      console.error(`Could not preserve failure evidence: ${error.message}`),
    );
  await app?.close().catch(() => undefined);
  if (macosAcceptance)
    await saveAcceptanceEvidence("closed", { keychainResult: acceptanceResult, smokePassed });
  await mock.close().catch(() => undefined);
  await isolated.cleanup();
}
