/* Signed official packaged Electron → its Node-mode worker → Pet → cold reload.
 * Local scripted model and a fixed-version synthetic installed MCP plugin only. */
/* global window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackagedPetFixture } from "./packaged-pet-fixture.mjs";
import { settlePackagedPet } from "./packaged-pet-shutdown.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import {
  captureRendererErrors,
  findCodeShellWindow,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "run-isolated-node-smoke.mjs is required");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(
    value &&
      ["--official-app", "--default-keychain-reference", "--receipt"].includes(flag) &&
      !options.has(flag),
    "Expected --official-app <signed-code-shell.app>, --default-keychain-reference <metadata> or --receipt <new-file>",
  );
  options.set(flag, value);
}
if (process.platform === "darwin")
  assert.ok(
    options.has("--default-keychain-reference"),
    "macOS requires an existing default-Keychain metadata reference; see macos-keychain-context.mjs --capture",
  );
assert.ok(options.has("--official-app"), "actual signed packaged app is required");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appDir, "../..");
const isolated = await makeIsolatedElectronHome("codeshell-pet-runtime-");
const fixtureRoot = await realpath(isolated.home);
isolated.home = join(fixtureRoot, "home");
await mkdir(isolated.home, { mode: 0o700 });
let keychainContext;
let keychainReference;
let model;
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
let fixture;
try {
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
  model = await startMockProviderServer();
  fixture = await preparePackagedPetFixture({
    officialApp: options.get("--official-app"),
    isolated,
    origin: model.origin,
    fixtureRoot,
    keychainReferenceFile: options.get("--default-keychain-reference"),
  });
} catch (error) {
  const errors = [error];
  for (const close of [() => model?.close(), () => isolated.cleanup()]) {
    try {
      await close();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }
  throw new AggregateError(errors, "packaged fixture preparation failed", { cause: error });
}
const nativeLog = join(isolated.home, "native-storage.jsonl");
const project = join(isolated.home, "runtime-project");
const plugin = join(isolated.codeShellHome, "plugins", "runtime-fixture");
const pluginLog = join(isolated.home, "plugin-startup.jsonl");
let app;
let primaryFailure;
let acceptanceReceipt;
const diagnosticFailures = [];
const launches = [];
const nativeSettings = [];
const rendererErrors = [];
async function pluginExits() {
  const rows = (await readFile(pluginLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    rows,
    complete:
      rows.some((row) => row.phase === "started") &&
      rows
        .filter((row) => row.phase === "started")
        .every((row) => rows.some((exit) => exit.phase === "exit" && exit.pid === row.pid)),
  };
}

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}

async function launch() {
  app = await fixture.launch();
  console.log(
    JSON.stringify({
      phase: "guarded-official-main-started",
      pid: app.process().pid,
      home: isolated.home,
    }),
  );
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
  if (!closing) return;
  const child = closing.process();
  let timer;
  const errors = [];
  try {
    await Promise.race([
      closing.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("owned packaged Electron close timed out")), 5_000);
      }),
    ]);
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      errors.push(error);
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new AggregateError([
      ...errors,
      Error("owned packaged Electron still alive; HOME retained"),
    ]);
  }
  app = undefined;
  if (errors.length) throw new AggregateError(errors, "owned packaged Electron close failed");
}

async function petChat(win, clientMessageId, message, first = false) {
  // Start the real worker through production IPC. Its stdin remains corked
  // until assertWorker verifies the exact child's preimport guard receipt.
  const operation = win.evaluate(
    ({ clientMessageId, message }) =>
      window.codeshell.pet.dispatch({ type: "chat", clientMessageId, message }),
    { clientMessageId, message },
  );
  // Observe rejection while the independent guard receipt is still pending.
  let earlyResult;
  operation.then(
    (value) => {
      earlyResult = value;
    },
    (error) => {
      earlyResult = { rejected: String(error) };
    },
  );
  if (first) {
    try {
      launches.push(await fixture.assertWorker(app));
    } catch (error) {
      throw new Error(
        `Worker guard acceptance failed; dispatch outcome: ${JSON.stringify(earlyResult)}`,
        { cause: error },
      );
    }
  }
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
  await put(
    join(plugin, "server.mjs"),
    (await readFile(join(repository, "tests/fixtures/mcp-transport-reload-server.mjs"), "utf8")) +
      '\nrecord({ phase: "runtime", executable: process.execPath, node: process.versions.node });\nprocess.once("exit", code => record({ phase: "exit", code }));\n',
  );
  const mcp = JSON.stringify({
    "runtime-fixture:proof": {
      command: fixture.managedNode,
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
  const pluginRuntimes = pluginEvents.filter((event) => event.phase === "runtime");
  assert.ok(
    pluginRuntimes.length > 0 &&
      pluginRuntimes.every(
        (event) =>
          event.executable === fixture.managedNode && event.node === fixture.managedNodeVersion,
      ),
    "synthetic plugin did not run under the signed app managed Node",
  );
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
  const pluginDeadline = Date.now() + 2_000;
  while (!(await pluginExits()).complete && Date.now() < pluginDeadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    (await pluginExits()).complete,
    true,
    "synthetic MCP process exit was not confirmed",
  );
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
  const receipt = {
    fixture: "pet-official-packaged-runtime",
    status: "passed",
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
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
      exits: (await pluginExits()).rows.filter((row) => row.phase === "exit"),
      runtimes: pluginRuntimes,
    },
    rendererErrors: 0,
    actualWechatDelivery: false,
    operatorPluginConfiguration: false,
    packagedApplication: true,
    nativeKeychainContext: keychainContext,
    nativeStorage,
    guardScope:
      "synchronous preimport Main/Node-mode-worker fetch/http/https and private HOME; Chromium session URL guard; synthetic plugin denies HTTP; no raw net/tls/OS confinement claim",
  };
  acceptanceReceipt = receipt;
} catch (error) {
  primaryFailure = error;
  // Only our scrubbed synthetic profile is inspected on failure.
  try {
    console.error("Local model request count:", model.requests.length);
    console.error(await readFile(nativeLog, "utf8").catch(() => "No native storage calls"));
    for (const name of await readdir(isolated.home))
      if (
        /^(official-main-|packaged-identity-|startup-pause-|network-guard|spawned-workers)/.test(
          name,
        )
      )
        console.error(name, (await readFile(join(isolated.home, name), "utf8")).slice(-8_000));
    for (const file of await readdir(join(isolated.codeShellHome, "logs"), {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!file.isFile()) continue;
      const log = await readFile(join(isolated.codeShellHome, "logs", file.name), "utf8");
      console.error(log.slice(-5_000));
    }
  } catch (diagnosticError) {
    diagnosticFailures.push(diagnosticError);
  }
}
{
  const { errors, artifacts, nativeCalls, privateHomeRemoved } = await settlePackagedPet({
    failures: [...(primaryFailure ? [primaryFailure] : []), ...diagnosticFailures],
    closeApp,
    closeModel: () => model.close(),
    verifyUnchanged: () => fixture.verifyUnchanged(),
    readNativeCalls: async () =>
      (await readFile(nativeLog, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    canCleanup: async () => (await fixture.canCleanup()) && (await pluginExits()).complete,
    cleanup: () => isolated.cleanup(),
    retainedHome: isolated.home,
  });
  const describe = (error, depth = 0) => ({
    name: error.name,
    message: error.message,
    ...(depth < 3 && error.cause ? { cause: describe(error.cause, depth + 1) } : {}),
    ...(depth < 3 && error.errors
      ? { errors: error.errors.map((nested) => describe(nested, depth + 1)) }
      : {}),
  });
  acceptanceReceipt = {
    ...(acceptanceReceipt ?? {
      fixture: "pet-official-packaged-runtime",
      packagedApplication: nativeSettings.length > 0,
      launches,
      nativeSettings,
      localModelRequests: model.requests.length,
      sameSessionContinuation: false,
      sameWorkSessionContinuation: false,
      coldSessionAndMemoryRecovery: false,
      syntheticInstalledPlugin: { initialized: false, discoveredTools: false },
      nativeKeychainContext: keychainContext,
    }),
    status: errors.length ? "failed" : "passed",
    artifacts,
    nativeCalls,
    privateHomeRemoved,
    errors: errors.map((error) => describe(error)),
  };
  if (options.has("--receipt")) {
    try {
      await writeFile(options.get("--receipt"), JSON.stringify(acceptanceReceipt, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      errors.push(error);
      acceptanceReceipt.status = "failed";
      acceptanceReceipt.errors = errors.map((failure) => describe(failure));
    }
  }
  console.log(JSON.stringify(acceptanceReceipt));
  if (errors.length)
    throw new AggregateError(errors, "Packaged Pet assertion/shutdown/cleanup failed");
}
