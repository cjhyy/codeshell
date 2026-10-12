/* Compiled Desktop Main → actual stdio worker → Pet capability → cold reload.
 * Local scripted model and a fixed-version synthetic installed MCP plugin only. */
/* global window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "run-isolated-node-smoke.mjs is required");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(
    value && ["--default-keychain-reference", "--receipt"].includes(flag) && !options.has(flag),
    "Expected --default-keychain-reference <private-metadata-file> or --receipt <new-file>",
  );
  options.set(flag, value);
}
if (process.platform === "darwin")
  assert.ok(
    options.has("--default-keychain-reference"),
    "macOS requires an existing default-Keychain metadata reference; see macos-keychain-context.mjs --capture",
  );
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appDir, "../..");
const isolated = await makeIsolatedElectronHome("codeshell-pet-runtime-");
const fixtureRoot = await realpath(isolated.home);
isolated.home = join(fixtureRoot, "home");
await mkdir(isolated.home, { mode: 0o700 });
let keychainContext;
let keychainReference;
if (process.platform === "darwin") {
  const { bindPrivateKeychainContext, readKeychainReference } =
    await import("./macos-keychain-context.mjs");
  keychainReference = readKeychainReference(options.get("--default-keychain-reference"));
  keychainContext = bindPrivateKeychainContext({
    home: isolated.home,
    root: fixtureRoot,
    reference: keychainReference,
    receiptFile: join(fixtureRoot, "keychain-context.json"),
  });
}
const model = await startMockProviderServer();
const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: model.origin });
const nativeLog = join(isolated.home, "native-storage.jsonl");
// Observe native entry/return without replacing cryptography or exposing data.
await writeFile(
  fixture.mainEntry,
  (await readFile(fixture.mainEntry, "utf8")).replace(
    'import { app } from "electron";',
    `import { app, safeStorage } from "electron";
for (const name of ["isEncryptionAvailable", "encryptString", "decryptString"]) {
  const original = safeStorage[name];
  safeStorage[name] = (...args) => {
    appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({ pid: process.pid, name, phase: "enter" }) + "\\n");
    try { return original(...args); }
    finally { appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({ pid: process.pid, name, phase: "return" }) + "\\n"); }
  };
}`,
  ),
);
const project = join(isolated.home, "runtime-project");
const plugin = join(isolated.codeShellHome, "plugins", "runtime-fixture");
const pluginLog = join(isolated.home, "plugin-startup.jsonl");
let app;
const launches = [];
const nativeSettings = [];
const rendererErrors = [];

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}

async function launch() {
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainEntry: fixture.mainEntry,
    env: fixture.env,
  });
  await findCodeShellWindow(app);
  // Pet's floating window also has #root. The project picker belongs to the
  // actual workbench, so never take a popout that happened to load first.
  const win = app.windows().find((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(win, "Production workbench window was not found");
  await win.locator("#root").waitFor({ state: "attached" });
  rendererErrors.push(captureRendererErrors(win));
  await win.waitForFunction(() => !!window.codeshell?.pet);
  const keyring = await app.evaluate(({ app }) => ({
    appName: app.getName(),
    mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
    passwordStore: app.commandLine.getSwitchValue("password-store"),
    electron: process.versions.electron,
    node: process.versions.node,
  }));
  assert.equal(keyring.appName, "code-shell");
  assert.equal(keyring.mockKeychain, false);
  assert.notEqual(keyring.passwordStore, "basic");
  nativeSettings.push(keyring);
  return win;
}

async function closeApp() {
  const closing = app;
  app = undefined;
  if (!closing) return;
  const child = closing.process();
  const term = setTimeout(() => child.kill("SIGTERM"), 3_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await closing.close();
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
}

async function petChat(win, clientMessageId, message, first = false) {
  // Start the real worker through production IPC. Its stdin remains corked
  // until assertWorker verifies the exact child's preimport guard receipt.
  const operation = win.evaluate(
    ({ clientMessageId, message }) =>
      window.codeshell.pet.dispatch({ type: "chat", clientMessageId, message }),
    { clientMessageId, message },
  );
  if (first) launches.push(await fixture.assertWorker(app));
  let deadline;
  const result = await Promise.race([
    operation,
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Local Pet runtime fixture timed out")), 20_000);
    }),
  ]).finally(() => clearTimeout(deadline));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.type, "chat");
  assert.equal(result.result.reason, "completed", JSON.stringify(result));
  assert.match(result.result.text, /plain streaming smoke response completed/);
  return result;
}

async function registerProject(win) {
  // Only the native folder picker is scripted, for this owned synthetic root.
  await app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog;
    globalThis.__petRuntimeRestorePicker = () => {
      dialog.showOpenDialog = original;
      delete globalThis.__petRuntimeRestorePicker;
    };
    dialog.showOpenDialog = async () => {
      globalThis.__petRuntimeRestorePicker();
      return { canceled: false, filePaths: [path] };
    };
  }, project);
  try {
    // This smoke verifies the runtime, so invoke the public picker IPC directly
    // rather than depending on the workbench sidebar's collapsed state.
    await win.evaluate(() => window.codeshell.projectRegistry.createFromPicker());
    const registered = await win.evaluate(async (path) => {
      const projects = await window.codeshell.projectRegistry.list();
      return projects.some((entry) => entry.roots.some((root) => root.path === path));
    }, project);
    assert.ok(registered, "The production folder picker did not register the synthetic project");
  } finally {
    await app.evaluate(() => globalThis.__petRuntimeRestorePicker?.());
  }
}

try {
  await put(join(isolated.codeShellHome, "settings.json"), {
    autoUpdates: false,
    credentials: [
      { id: "synthetic", catalogId: "deepseek", apiKey: "synthetic", baseUrl: model.baseUrl },
    ],
    modelConnections: [
      {
        id: "synthetic",
        catalogId: "deepseek",
        tag: "text",
        model: "deepseek-v4-flash",
        credentialId: "synthetic",
      },
    ],
    defaults: { text: "synthetic" },
  });
  await put(join(project, ".code-shell", "settings.json"), {});
  await put(join(isolated.codeShellHome, "desktop", "trust.json"), { [project]: "trusted" });
  await put(join(plugin, ".claude-plugin", "plugin.json"), {
    name: "runtime-fixture",
    version: "1.0.0",
    description: "Local fixed-version runtime acceptance fixture",
  });
  await copyFile(
    join(repository, "tests/fixtures/mcp-transport-reload-server.mjs"),
    join(plugin, "server.mjs"),
  );
  const mcp = JSON.stringify({
    "runtime-fixture:proof": {
      command: process.execPath,
      args: [join(plugin, "server.mjs"), "runtime-v1", pluginLog],
      connectTimeoutMs: 2_000,
      connectRetries: 0,
    },
  });
  await put(join(plugin, "mcp-servers.json"), mcp);
  const digest = createHash("sha256")
    .update("codeshell-plugin-mcp-v1\0mcp-servers.json\0")
    .update(mcp)
    .digest("hex");
  await put(join(isolated.codeShellHome, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "runtime-fixture@local": [
        {
          scope: "user",
          installPath: plugin,
          version: "1.0.0",
          installedAt: "2026-10-12T00:00:00.000Z",
          lastUpdated: "2026-10-12T00:00:00.000Z",
          mcpDigest: digest,
          approvedMcpDigest: digest,
        },
      ],
    },
  });

  let win = await launch();
  const first = await petChat(win, "runtime-first", "RUNTIME_FIRST: hello", true);
  const second = await petChat(win, "runtime-second", "RUNTIME_SECOND: continue this chat");
  assert.equal(second.petSessionId, first.petSessionId, "Mimi replaced the existing Session");
  const petRequests = model.requests.filter((entry) =>
    entry.body.messages.some((message) => JSON.stringify(message).includes("RUNTIME_SECOND:")),
  );
  assert.ok(petRequests.length > 0, "Second input did not reach the isolated model");
  assert.ok(
    petRequests.some((entry) => JSON.stringify(entry.body.messages).includes("RUNTIME_FIRST:")),
    "Same-Session continuation lost the first user input",
  );
  assert.ok(
    petRequests.some((entry) =>
      entry.body.tools?.some((tool) => tool.function?.name === "DelegateWork"),
    ),
    "Actual worker did not load the Pet capability tool catalog",
  );
  assert.ok(
    petRequests.every((entry) =>
      entry.body.tools?.every((tool) => !/^mcp_|^(Bash|Write|Edit)$/.test(tool.function?.name)),
    ),
    "Manager turn exposed execution or MCP tools",
  );
  const memory = await win.evaluate(() => window.codeshell.pet.addMemory("Runtime fixture memory"));
  await registerProject(win);
  const work = await win.evaluate(
    ({ project }) =>
      window.codeshell.run("RUNTIME_WORK: reply briefly", {
        cwd: project,
        sessionId: "runtime-work-proof",
        clientMessageId: "runtime-work-input",
      }),
    { project },
  );
  assert.equal(work.error, undefined, JSON.stringify(work));
  assert.equal(work.result.reason, "completed");
  const continuedWork = await win.evaluate(
    ({ project }) =>
      window.codeshell.run("RUNTIME_WORK_CONTINUE: continue this same work", {
        cwd: project,
        sessionId: "runtime-work-proof",
        clientMessageId: "runtime-work-continued",
      }),
    { project },
  );
  assert.equal(continuedWork.error, undefined, JSON.stringify(continuedWork));
  assert.equal(continuedWork.result.reason, "completed");
  assert.equal(continuedWork.result.sessionId, work.result.sessionId);
  assert.ok(
    model.requests.some(
      (entry) =>
        JSON.stringify(entry.body.messages).includes("RUNTIME_WORK_CONTINUE:") &&
        JSON.stringify(entry.body.messages).includes("RUNTIME_WORK: reply briefly"),
    ),
    "The actual Work Session continuation lost its original user input",
  );
  const pluginEvents = (await readFile(pluginLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(pluginEvents.some((event) => event.method === "initialize"));
  assert.ok(pluginEvents.some((event) => event.method === "tools/list"));
  assert.ok(pluginEvents.some((event) => event.phase === "started"));
  assert.ok(pluginEvents.every((event) => event.method !== "tools/call"));
  const pluginProcesses = pluginEvents
    .filter((event) => event.phase === "started")
    .map(({ pid, ppid }) => ({ pid, ppid }));
  assert.ok(
    pluginProcesses.every((process) =>
      launches[0].spawned.some((worker) => worker.pid === process.ppid),
    ),
    "The installed MCP process was not launched by the actual stdio worker",
  );
  assert.ok(
    pluginEvents
      .filter((event) => event.phase === "started")
      .every((event) => event.privateHome === isolated.home && event.negativeProbes === 2),
    "Installed MCP process did not confirm its private HOME and deny-all network guard",
  );
  await closeApp();
  // Each launch verifies only its own actual children. The first generation's
  // complete checked receipts are already retained in launches.
  await put(join(isolated.home, "network-guard.jsonl"), "");
  await put(join(isolated.home, "spawned-workers.jsonl"), "");

  win = await launch();
  const third = await petChat(win, "runtime-cold", "RUNTIME_COLD: continue after restart", true);
  assert.notEqual(launches[0].mainPid, launches[1].mainPid, "Electron did not cold restart");
  assert.equal(
    third.petSessionId,
    first.petSessionId,
    "Cold launch replaced Mimi's durable Session",
  );
  const memories = await win.evaluate(() => window.codeshell.pet.listMemories());
  assert.ok(memories.some((entry) => entry.id === memory.id && entry.text === memory.text));
  const cold = model.requests.filter((entry) =>
    entry.body.messages.some((message) => JSON.stringify(message).includes("RUNTIME_COLD:")),
  );
  assert.ok(cold.some((entry) => JSON.stringify(entry.body.messages).includes("RUNTIME_FIRST:")));
  assert.ok(cold.some((entry) => JSON.stringify(entry.body.messages).includes("RUNTIME_SECOND:")));
  assert.equal(rendererErrors.flat().length, 0, "Renderer emitted an uncaught error");
  const nativeCalls = (await readFile(nativeLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const nativeStorage = launches.map(({ mainPid }) => {
    const calls = nativeCalls.filter((call) => call.pid === mainPid);
    const completed = Object.fromEntries(
      ["isEncryptionAvailable", "encryptString", "decryptString"].map((name) => {
        const entered = calls.filter((call) => call.name === name && call.phase === "enter").length;
        const returned = calls.filter(
          (call) => call.name === name && call.phase === "return",
        ).length;
        assert.equal(entered, returned, "A native storage call did not return");
        return [name, returned];
      }),
    );
    assert.ok(completed.isEncryptionAvailable > 0 && completed.decryptString > 0);
    return { pid: mainPid, completed };
  });
  assert.ok(nativeStorage[0].completed.encryptString > 0);
  await closeApp();
  if (keychainReference) {
    const { readDefaultKeychain } = await import("./macos-keychain-context.mjs");
    const after = readDefaultKeychain(keychainReference.home);
    for (const key of ["path", "dev", "ino", "uid"])
      assert.equal(after[key], keychainReference[key], "OS default Keychain metadata changed");
    keychainContext.operatorDefaultUnchangedAfterRuntime = true;
  }
  const artifactFiles = [
    "packages/desktop/scripts/e2e-pet-runtime.mjs",
    "packages/desktop/out/main/index.mjs",
    "packages/desktop/out/preload/index.cjs",
    "packages/core/dist/cli/agent-server-stdio.js",
    "packages/pet/dist/profile.js",
  ];
  const artifacts = Object.fromEntries(
    await Promise.all(
      artifactFiles.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(repository, path)))
          .digest("hex"),
      ]),
    ),
  );
  const receipt = {
    fixture: "pet-built-desktop-runtime",
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    artifacts,
    launches,
    nativeSettings,
    localModelRequests: model.requests.length,
    sameSessionContinuation: true,
    sameWorkSessionContinuation: true,
    coldSessionAndMemoryRecovery: true,
    syntheticInstalledPlugin: {
      version: "1.0.0",
      initialized: true,
      discoveredTools: true,
      processes: pluginProcesses,
      toolCalls: 0,
    },
    rendererErrors: 0,
    actualWechatDelivery: false,
    operatorPluginConfiguration: false,
    packagedApplication: false,
    nativeKeychainContext: keychainContext,
    nativeStorage,
    guardScope:
      "Main/worker fetch/http/https; synthetic plugin denies HTTP; no Chromium/raw net/tls/OS confinement claim",
  };
  if (options.has("--receipt"))
    await writeFile(options.get("--receipt"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  console.log(JSON.stringify(receipt));
} catch (error) {
  // Only our scrubbed synthetic profile is inspected on failure.
  console.error("Local model request count:", model.requests.length);
  console.error(await readFile(nativeLog, "utf8").catch(() => "No native storage calls"));
  for (const file of await readdir(join(isolated.codeShellHome, "logs"), {
    withFileTypes: true,
  }).catch(() => [])) {
    if (!file.isFile()) continue;
    const log = await readFile(join(isolated.codeShellHome, "logs", file.name), "utf8");
    console.error(log.slice(-5_000));
  }
  throw error;
} finally {
  await closeApp();
  await model.close();
  await isolated.cleanup();
}
