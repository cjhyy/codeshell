/** Actual production Main/preload → AgentBridge stdio → guarded worker/Core.
 * Source preparation only until the parent grants this exact Native run.
 * Every approved batch still uses the real OS Native dialog. A human/CUA
 * approves that fixed synthetic proposal; no dialog/resolver/nonce is faked. */
/* global window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { bindPrivateKeychainContext, readKeychainReference } from "./macos-keychain-context.mjs";
import { nativeBatchIds, prepareOperationBatchHome } from "./operation-batch-native-fixture.mjs";
import {
  batchWorkerCases,
  batchWorkerItems,
  startBatchWorkerWire,
} from "./operation-batch-worker-fixture.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index],
    value = process.argv[index + 1];
  if (
    !value ||
    !["--case", "--output", "--default-keychain-reference"].includes(flag) ||
    options.has(flag)
  )
    throw new Error(
      "usage: node e2e-operation-batch-worker.mjs --case <success|item-cancel|failed-readback|scope-revocation|forged-ingress|cold-restart> [--output <new-directory>] [--default-keychain-reference <private-metadata-file>]",
    );
  options.set(flag, value);
}
const caseName = options.get("--case");
assert.ok(batchWorkerCases.includes(caseName), "An explicit closed-set case is required");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
assert.ok(
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 16),
  "Run with the recorded actual Node >=22.16 toolchain",
);
const keychainReference =
  process.platform === "darwin"
    ? readKeychainReference(
        options.get("--default-keychain-reference") ??
          (() => {
            throw new Error(
              "macOS requires its existing private default-Keychain metadata reference",
            );
          })(),
      )
    : undefined;
const root = options.has("--output")
  ? resolve(options.get("--output"))
  : await mkdtemp(join(tmpdir(), "codeshell-batch-worker-"));
if (options.has("--output")) await mkdir(root, { mode: 0o700 });
const directory = await realpath(root);
const evidence = join(directory, "evidence");
await mkdir(evidence, { mode: 0o700 });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let forbiddenEvidenceToken;
const save = (path, value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assert.ok(
    !forbiddenEvidenceToken || !text.includes(forbiddenEvidenceToken),
    "Private Native nonce must never be written to fixture evidence",
  );
  return writeFile(path, text, { flag: "wx", mode: 0o600 });
};
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const waitFor = async (description, read, accept, timeout = 30_000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= until) throw new Error(`Timed out: ${description}`);
    await delay(50);
  }
};
const keepKeys = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SESSION_BUS_PID",
  "GNOME_KEYRING_CONTROL",
  "GNOME_KEYRING_PID",
  "SECURITYSESSIONID",
  "XDG_CURRENT_DESKTOP",
  "WAYLAND_DISPLAY",
];
const environment = {
  ...createBunTestEnvironment(process.env, directory),
  ...Object.fromEntries(
    keepKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  ),
};
if (keychainReference)
  bindPrivateKeychainContext({
    home: environment.HOME,
    root: directory,
    reference: keychainReference,
    receiptFile: join(evidence, "keychain-context.json"),
  });
for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
Object.assign(process.env, environment);
process.env.CODESHELL_MACOS_ACCEPTANCE_ROOT = directory;
const isolated = {
  home: environment.HOME,
  codeShellHome: environment.CODE_SHELL_HOME,
  userDataDir: join(environment.HOME, "electron-user-data"),
};
const projectRoot = join(isolated.home, "synthetic-project");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appDir, "../..");
let ownedWire;
let wireClose;
let outerFailure;
let runtimeReturned = false;
async function closeOwnedWire() {
  if (!ownedWire) return { created: false, closed: true };
  if (!wireClose)
    wireClose = (async () => {
      let timer;
      try {
        await Promise.race([
          ownedWire.close(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Owned fixture HTTP close exceeded 2s")),
              2_000,
            );
          }),
        ]);
        return { created: true, closed: true };
      } finally {
        clearTimeout(timer);
      }
    })();
  return wireClose;
}
try {
  await prepareOperationBatchHome({ ...isolated, projectRoot });
  const wire = await startBatchWorkerWire(caseName, {
    ledgerPath: join(isolated.codeShellHome, "sessions/.operations/ledger.json"),
  });
  ownedWire = wire;
  const settingsPath = join(isolated.codeShellHome, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  Object.assign(settings, {
    memories: { autoExtract: false },
    permissions: { defaultMode: "default", rules: [{ tool: "LinkAction", decision: "allow" }] },
    credentials: [
      {
        id: "synthetic-batch-model-key",
        catalogId: "synthetic-batch-openai",
        apiKey: "synthetic-batch-no-provider-key",
        baseUrl: `${wire.origin}/v1`,
      },
    ],
    modelConnections: [
      {
        id: "synthetic-batch-model",
        catalogId: "synthetic-batch-openai",
        tag: "text",
        model: "batch-worker",
        credentialId: "synthetic-batch-model-key",
      },
    ],
    defaults: { text: "synthetic-batch-model" },
  });
  await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  await writeFile(
    join(projectRoot, ".code-shell/settings.json"),
    JSON.stringify({ permissions: settings.permissions }),
    { mode: 0o600 },
  );
  await save(join(isolated.codeShellHome, "model-catalog.user.json"), [
    {
      id: "synthetic-batch-openai",
      tag: "text",
      adapterKind: "openai",
      protocol: "openai-compat",
      displayName: "Synthetic batch local wire",
      description: "Controlled actual worker fixture only",
      defaultBaseUrl: `${wire.origin}/v1`,
      defaultModel: "batch-worker",
      needsKey: true,
      modelPresets: [
        {
          value: "batch-worker",
          label: "Synthetic batch",
          maxContextTokens: 200_000,
          maxOutputTokens: 4_096,
          supportsVision: false,
        },
      ],
    },
  ]);
  const { prepareConfinedElectronFixture } = await import("./confined-electron-fixture.mjs");
  const fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: wire.origin,
    guardModule: new URL("./operation-read-guard.mjs", import.meta.url).href,
  });
  const sourcePaths = [
    "packages/desktop/scripts/e2e-operation-batch-worker.mjs",
    "packages/desktop/scripts/operation-batch-worker-fixture.mjs",
    "packages/desktop/scripts/e2e-operation-batch-native.mjs",
    "packages/desktop/scripts/operation-batch-native-fixture.mjs",
    "packages/desktop/scripts/confined-electron-fixture.mjs",
    "packages/desktop/scripts/electron-harness.mjs",
    "packages/desktop/scripts/operation-read-guard.mjs",
    "packages/desktop/scripts/owned-electron-control.mjs",
    "packages/desktop/scripts/macos-keychain-context.mjs",
    "packages/desktop/scripts/macos-keychain-guard.mjs",
    "scripts/bun-test-completion.mjs",
    "scripts/runtime-cost-smoke-isolation.mjs",
    "packages/desktop/src/main/agent-bridge.ts",
    "packages/desktop/src/main/agent-run-metadata.ts",
    "packages/desktop/src/main/operation-batch-ipc.ts",
    "packages/desktop/src/main/operation-batch-host.ts",
    "packages/core/src/links/github-issue-batch.ts",
    "packages/core/src/operations/ledger.ts",
    "packages/core/src/operations/run-batch-authority.ts",
    "packages/core/src/operations/desktop-batch-authority-client.ts",
  ];
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [path, hash(await readFile(join(repository, path)))]),
    ),
  );
  const coreUrl = import.meta.resolve("@cjhyy/code-shell-core");
  const internalUrl = import.meta.resolve("@cjhyy/code-shell-core/internal");
  const workerUrl = import.meta.resolve("@cjhyy/code-shell-core/bin/agent-server-stdio");
  const coreFiles = {};
  for (const name of [
    "index.js",
    "index.internal.js",
    "credentials/store.js",
    "links/remote.js",
    "links/github-issue-batch.js",
    "operations/ledger.js",
    "operations/run-batch-authority.js",
    "operations/desktop-batch-authority-client.js",
    "cli/agent-server-stdio.js",
  ]) {
    coreFiles[name] = hash(await readFile(new URL(name, coreUrl)));
    assert.equal(
      coreFiles[name],
      hash(await readFile(join(repository, "packages/core/dist", name))),
    );
  }
  const artifacts = Object.fromEntries(
    await Promise.all(
      ["out/main/index.mjs", "out/preload/index.cjs", "out/renderer/index.html"].map(
        async (path) => [path, hash(await readFile(join(appDir, path)))],
      ),
    ),
  );
  await save(join(isolated.home, "operation-read-source.json"), {
    phase: "actual-worker-batch",
    caseName,
    sourceFiles,
    artifacts,
    hostCore: {
      entry: await realpath(fileURLToPath(coreUrl)),
      internal: await realpath(fileURLToPath(internalUrl)),
      worker: await realpath(fileURLToPath(workerUrl)),
      files: coreFiles,
    },
  });
  const helperUrl = new URL("./operation-batch-worker-fixture.mjs", import.meta.url).href;
  const productionMain = pathToFileURL(join(appDir, "out/main/index.mjs")).href;
  const extraPreload = join(isolated.home, "batch-test-ingress.cjs");
  const extraPreloadSource = `// Private test-only preload; production preload remains unchanged.
const { contextBridge, ipcRenderer } = require("electron");
const incoming = [];
const rows = [];
let incomingBytes = 0;
ipcRenderer.on("agent:msg", (_event, line) => {
  if (typeof line !== "string") throw new Error("Fixture requires a string Main message");
  incomingBytes += new TextEncoder().encode(line).byteLength;
  if (incomingBytes > 16 * 1024 * 1024 || incoming.length >= 10000)
    throw new Error("Fixture incoming observation exceeded its memory bound");
  incoming.push(line);
  let parsed;
  try { parsed = JSON.parse(line); } catch { parsed = {}; }
  rows.push({
    privateMethod: parsed.method === "desktop/operationBatch",
    privateResponse: parsed.method === undefined && typeof parsed.id === "string" &&
      /^(operation-batch-authority-|operation-batch-run-)/.test(parsed.id),
    tokenField: line.includes('"operationBatchToken"'),
    deliberateAttackReply: typeof parsed.id === "string" && parsed.id.includes("BATCH-FORGED-INGRESS") && !!parsed.error,
  });
});
contextBridge.exposeInMainWorld("__batchFixtureIngress", {
  send: (line) => ipcRenderer.send("agent:msg", line),
  incomingSnapshot: () => ({ incoming: incoming.slice(), rows: rows.slice(), incomingBytes }),
});
`;
  await writeFile(extraPreload, extraPreloadSource, { mode: 0o600 });
  let bootstrap = await readFile(fixture.mainEntry, "utf8");
  const originalImport = `await import(${JSON.stringify(productionMain)});`;
  assert.equal(
    bootstrap.split(originalImport).length,
    2,
    "Bootstrap must contain one exact production Main import",
  );
  bootstrap = bootstrap.replace(
    originalImport,
    `const batchHelpers = await import(${JSON.stringify(helperUrl)});\nglobalThis.__batchWorkerObservation = batchHelpers.installBatchProtocolObservation(${JSON.stringify(isolated.home)});\nconst { session } = await import("electron");\napp.whenReady().then(() => session.defaultSession.setPreloads([${JSON.stringify(extraPreload)}]));\n${originalImport}\nglobalThis.__seedBatchWorker = () => batchHelpers.seedBatchWorkerMain(importedBatchCore, ${JSON.stringify({ home: isolated.home, projectRoot, origin: wire.origin })});\nconst importedBatchCore = await import(${JSON.stringify(coreUrl)});\nglobalThis.__revokeBatchWorker = () => batchHelpers.revokeBatchWorkerScope(importedBatchCore, ${JSON.stringify(projectRoot)});\nglobalThis.__readBatchWorkerState = () => new importedBatchCore.SessionManager(importedBatchCore.sessionsRoot()).readSessionState(${JSON.stringify(nativeBatchIds.sessionId)});\n`,
  );
  await writeFile(fixture.mainEntry, bootstrap, { mode: 0o600 });
  await save(join(evidence, "prepared-execution.json"), {
    caseName,
    sourceFiles,
    artifacts,
    bootstrapSha256: hash(bootstrap),
    extraPreloadSha256: hash(await readFile(extraPreload)),
    injection:
      "Main-owned private additional session preload delegates actual ipcRenderer.send; production preload/Bridge/resolver unchanged",
    authority:
      "Native fixed approval and actual worker RPC; no injected batch permission or substitute credential-access adapter",
    mainModel: `${wire.origin}/v1/chat/completions`,
    actions: `${wire.origin}/api/v1/data/connections/<synthetic-uuid>/actions/<closed-action>`,
  });

  // Parent uses only HTTP guards. Main/worker independently prove the existing
  // eight HTTP and three child-launch probes before their first Core import.
  // The exact owned Playwright upgrade is a separate narrow control exception.
  const { prepareOwnedElectronControl } = await import("./owned-electron-control.mjs");
  const control = prepareOwnedElectronControl({
    appDir,
    mainEntry: fixture.mainEntry,
    home: isolated.home,
    receiptFile: join(evidence, "owned-control.jsonl"),
  });
  const { probeMacosKeychainGuard } = await import("./macos-keychain-guard.mjs");
  const parentGuard = await probeMacosKeychainGuard(
    wire.origin,
    join(evidence, "parent-guard.jsonl"),
    "parent",
  );
  control.activate();
  const { launchCodeShellElectron, findCodeShellWindow, captureRendererErrors } =
    await import("./electron-harness.mjs");
  const phases = [];
  let stage = "launch actual guarded Main",
    failure,
    timedOut = false,
    cleanupUnknown = false;
  let active,
    privateInput,
    firstObservation,
    coldObservation,
    seed,
    revoke,
    ledgerEvidence,
    scopeCheckpoint,
    firstRunOutcome;
  let approvalCount = 0;
  const answeredApprovals = new Set();
  const appInstances = [];
  const startedAt = Date.now();
  const limit = setTimeout(() => {
    timedOut = true;
    if (active && !active.closed) active.child.kill("SIGTERM");
  }, 240_000);
  const hardLimit = setTimeout(() => {
    if (active && !active.closed) active.child.kill("SIGKILL");
  }, 242_000);
  async function launch(phase, seedMain) {
    const app = await launchCodeShellElectron({
      appDir,
      ...isolated,
      env: fixture.env,
      mainEntry: fixture.mainEntry,
    });
    const child = app.process();
    const instance = {
      app,
      child,
      phase,
      closed: false,
      exited: false,
      terminal: null,
      streams: [],
    };
    instance.terminal = new Promise((done) => {
      child.once("exit", (code, signal) => {
        instance.exited = true;
        instance.exit = { code, signal };
      });
      child.once("close", (code, signal) => {
        instance.closed = true;
        instance.close = { code, signal };
        done();
      });
    });
    for (const name of ["stdout", "stderr"]) {
      const stream = createWriteStream(join(evidence, `${phase}-main-${name}.log`), {
        flags: "wx",
        mode: 0o600,
      });
      instance.streams.push(
        new Promise((done, reject) => {
          stream.once("finish", done);
          stream.once("error", reject);
        }),
      );
      if (child[name]) child[name].pipe(stream);
      else stream.end();
    }
    active = instance;
    appInstances.push(instance);
    instance.win = await findCodeShellWindow(app);
    instance.rendererErrors = captureRendererErrors(instance.win);
    await instance.win.setViewportSize({ width: 1440, height: 980 });
    await verifyProcesses(instance, false);
    await instance.win.waitForFunction(
      () => typeof window.__batchFixtureIngress?.send === "function",
    );
    if (seedMain) seed = await app.evaluate(() => globalThis.__seedBatchWorker());
    phases.push({ phase, pid: child.pid, at: Date.now(), seeded: seedMain });
    return instance;
  }
  async function stop(instance) {
    if (!instance.stopping)
      instance.stopping = (async () => {
        const timer = setTimeout(() => {
          if (!instance.closed) instance.child.kill("SIGTERM");
        }, 10_000);
        const hard = setTimeout(() => {
          if (!instance.closed) instance.child.kill("SIGKILL");
        }, 12_000);
        const closed = instance.closed
          ? Promise.resolve()
          : instance.app.close().catch((error) => {
              failure ??= String(error);
            });
        await instance.terminal;
        await closed;
        clearTimeout(timer);
        clearTimeout(hard);
        await Promise.all(instance.streams);
        if (
          !instance.exited ||
          !instance.closed ||
          instance.exit?.code !== 0 ||
          instance.close?.code !== 0 ||
          instance.exit.signal ||
          instance.close.signal
        )
          cleanupUnknown = true;
      })();
    return instance.stopping;
  }
  async function verifyProcesses(instance, requireWorker) {
    return waitFor(
      "current Main and exact spawned worker guard receipts",
      async () => {
        const receipts = (
          await readFile(join(isolated.home, "operation-read-guard.jsonl"), "utf8").catch(() => "")
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        assert.ok(
          receipts.every(
            (row) =>
              row.origin === wire.origin &&
              row.homeId === hash(isolated.home) &&
              row.negativeProbes === 8 &&
              row.childNegativeProbes === 3,
          ),
        );
        const current = await instance.app.evaluate(() =>
          globalThis.__batchWorkerObservation.snapshot(),
        );
        const workers = current.workers.map((row) => row.pid);
        const ready =
          receipts.some((row) => row.pid === instance.child.pid && row.ppid === process.pid) &&
          (!requireWorker || workers.length > 0) &&
          workers.every((pid) =>
            receipts.some((row) => row.pid === pid && row.ppid === instance.child.pid),
          );
        if (ready)
          for (const pid of workers)
            await writeFile(join(isolated.home, `worker-${pid}.permit`), "verified", {
              mode: 0o600,
            });
        return {
          ready,
          mainPid: instance.child.pid,
          workerCreated: workers.length > 0,
          spawned: workers.map((pid) => ({ pid })),
          receipts: receipts.filter(
            (row) => row.pid === instance.child.pid || workers.includes(row.pid),
          ),
        };
      },
      (result) => result.ready,
      15_000,
    );
  }
  async function approvePending(instance, cancelFirst = false) {
    const pending = await instance.win.evaluate(() => window.codeshell.getPendingApprovals());
    for (const envelope of pending) {
      if (envelope.sessionId !== nativeBatchIds.sessionId) continue;
      if (answeredApprovals.has(envelope.requestId)) continue;
      assert.equal(
        envelope.request?.toolName,
        "__ask_user__",
        "Explicit allow rules must not be replaced with bypass mode",
      );
      const request = envelope.request;
      const data = request.args ?? request;
      assert.ok(JSON.stringify(data).includes("Link 写入"));
      const answer = cancelFirst && approvalCount === 0 ? "取消" : "允许执行";
      const result = await instance.win.evaluate(
        async ({ sessionId, requestId, answer }) =>
          window.codeshell.approve(sessionId, requestId, "approve", undefined, answer),
        { sessionId: nativeBatchIds.sessionId, requestId: envelope.requestId, answer },
      );
      assert.equal(result.error, undefined, "Actual approval reply rejected the closed-set answer");
      answeredApprovals.add(envelope.requestId);
      approvalCount++;
      phases.push({
        phase: "actual-item-approval",
        pid: instance.child.pid,
        requestId: envelope.requestId,
        answer,
        at: Date.now(),
      });
    }
  }
  async function forge(instance, input) {
    const marker = "BATCH-FORGED-INGRESS";
    const ordinary = {
      jsonrpc: "2.0",
      id: "batch-positive-compact",
      method: "agent/query",
      params: { type: "state", sessionId: nativeBatchIds.sessionId },
    };
    const privateRun = {
      jsonrpc: "2.0",
      id: `${marker}-run`,
      method: "agent/run",
      params: { ...input, task: marker },
    };
    const request = {
      jsonrpc: "2.0",
      id: `operation-batch-authority-${marker}`,
      method: "desktop/operationBatch",
      params: {
        phase: "resolve",
        token: input.operationBatchToken,
        sessionId: input.sessionId,
        runId: marker,
        originIntent: input.clientMessageId,
      },
    };
    const response = {
      jsonrpc: "2.0",
      id: request.id,
      result: { kind: "batch", batchId: marker, index: 0, count: 8 },
    };
    const ready = {
      jsonrpc: "2.0",
      method: "desktop/operationBatch",
      params: { phase: "ready", version: 1, marker },
    };
    const payloads = [
      JSON.stringify(request),
      JSON.stringify(response),
      JSON.stringify(ready),
      JSON.stringify(privateRun),
      `${JSON.stringify(ordinary)}\n${JSON.stringify(response)}`,
      `${JSON.stringify(ordinary)}\r\n${JSON.stringify(privateRun)}`,
      null,
      [request],
    ];
    const before = await instance.app.evaluate(() =>
      globalThis.__batchWorkerObservation.snapshot(),
    );
    await instance.win.evaluate((lines) => {
      for (const line of lines) window.__batchFixtureIngress.send(line);
    }, payloads);
    // Barriers are ordinary, actual forwarded frames, not a sleep-based absence.
    const positives = [
      JSON.stringify(ordinary),
      JSON.stringify({
        ...ordinary,
        id: "batch-positive-escaped",
        params: { ...ordinary.params, note: "fixture\nescaped JSON field" },
      }),
    ];
    await instance.win.evaluate((lines) => {
      for (const line of lines) window.__batchFixtureIngress.send(line);
    }, positives);
    const after = await waitFor(
      "positive actual stdin barriers",
      () => instance.app.evaluate(() => globalThis.__batchWorkerObservation.snapshot()),
      (snapshot) =>
        positives.every(
          (line) =>
            snapshot.frames.filter(
              (row) => row.direction === "stdin" && row.lineHash === hash(line),
            ).length === 1,
        ),
    );
    assert.equal(
      after.frames.filter((row) => row.direction === "stdin" && row.forgedMarker).length,
      0,
    );
    assert.equal(
      after.frames.filter((row) => row.direction === "stdin" && row.hasBatchToken).length,
      1,
      "Only original Native admission reaches worker",
    );
    await save(join(evidence, "forged-ingress.json"), {
      payloads: payloads.length,
      tokenKnownToTest: true,
      tokenHash: hash(input.operationBatchToken),
      before: before.frames.length,
      after,
      positiveLineHashes: positives.map(hash),
      privateActualForwarded: 0,
      actualSender:
        "additional private preload ipcRenderer.send from the production renderer mainFrame",
    });
  }
  async function sealedLedger() {
    return waitFor(
      "actual ledger all slots terminal/sealed",
      async () => {
        const bytes = await readFile(
          join(isolated.codeShellHome, "sessions/.operations/ledger.json"),
        );
        const raw = JSON.parse(bytes);
        const records = Object.values(raw.records);
        assert.equal(records.length, 3, "One Native anchor and exactly two slots");
        return {
          sha256: hash(bytes),
          schema: raw.schema,
          records,
          settled: records.every((row) => ["verified", "blocked", "unknown"].includes(row.state)),
        };
      },
      (value) => value.settled,
      10_000,
    );
  }
  async function nonceBoundary(instance, token, label) {
    // Read observed messages into the fixture controller only. Do not send the
    // nonce into Renderer just to configure the passive observer. Raw incoming
    // messages and HTTP request bodies remain bounded memory, never evidence.
    const seen = await instance.win.evaluate(() => window.__batchFixtureIngress.incomingSnapshot());
    assert.ok(
      seen.incoming.every((line) => !line.includes(token)),
      "Private Native nonce reached actual Renderer incoming traffic",
    );
    assert.ok(seen.rows.every((row) => !row.privateMethod && !row.tokenField));
    assert.ok(
      seen.rows.every((row) => !row.privateResponse || row.deliberateAttackReply),
      "Normal private admission response leaked to Renderer",
    );
    const persistent = await persistentNonceBoundary(token);
    const result = {
      label,
      tokenHash: hash(token),
      http: wire.snapshot().nonce,
      renderer: {
        messages: seen.rows.length,
        incomingBytes: seen.incomingBytes,
        messageHashes: seen.incoming.map(hash),
        literalFound: false,
        privateMethods: 0,
        tokenFields: 0,
        normalPrivateResponses: 0,
        deliberateAttackErrorReplies: seen.rows.filter((row) => row.deliberateAttackReply).length,
      },
      persistent,
      deliberateKnownNonceAttack: caseName === "forged-ingress" || label === "cold",
    };
    await save(join(evidence, `${label}-nonce-boundary.json`), result);
    return result;
  }
  async function persistentNonceBoundary(token) {
    const persistent = {};
    for (const name of ["state.json", "transcript.jsonl"]) {
      const bytes = await readFile(
        join(isolated.codeShellHome, "sessions", nativeBatchIds.sessionId, name),
      );
      assert.ok(
        !bytes.includes(Buffer.from(token)),
        `Private Native nonce reached persistent ${name}`,
      );
      persistent[name] = { sha256: hash(bytes), bytes: bytes.length, literalFound: false };
    }
    return persistent;
  }
  try {
    const instance = await launch("first", true);
    const options = await instance.win.evaluate(
      (sessionId) => window.codeshell.operationBatch.options(sessionId),
      nativeBatchIds.sessionId,
    );
    assert.equal(options.connections.length, 1);
    stage = "real Native fixed approval";
    await instance.win.evaluate(
      (proposal) => {
        window.__batchWorkerStart = { state: "pending" };
        void window.codeshell.operationBatch.start(proposal).then(
          (value) => {
            window.__batchWorkerStart = { state: "resolved", value };
          },
          (error) => {
            window.__batchWorkerStart = { state: "rejected", error: String(error) };
          },
        );
      },
      {
        sessionId: nativeBatchIds.sessionId,
        connectionId: nativeBatchIds.connectionId,
        items: batchWorkerItems,
      },
    );
    await save(join(evidence, "native-approval-pending.json"), {
      caseName,
      mainPid: instance.child.pid,
      items: batchWorkerItems,
      instruction:
        "Review the actual Native fixed two-item synthetic proposal and explicitly approve. No fixture replacement or automatic OS interaction.",
    });
    console.log(
      `ACTUAL NATIVE APPROVAL REQUIRED case=${caseName} MainPID=${instance.child.pid} evidence=${evidence}`,
    );
    const started = await waitFor(
      "actual Native approval response",
      () => instance.win.evaluate(() => window.__batchWorkerStart),
      (value) => value.state !== "pending",
      120_000,
    );
    assert.deepEqual(started, { state: "resolved", value: { status: "started", count: 2 } });
    const processes = await verifyProcesses(instance, true);
    assert.ok(processes.workerCreated && processes.spawned.length === 1);
    await waitFor(
      "one actual Native worker admission",
      () => instance.app.evaluate(() => globalThis.__batchWorkerObservation.snapshot()),
      (snapshot) =>
        snapshot.frames.filter((row) => row.direction === "stdin" && row.hasBatchToken).length ===
        1,
    );
    privateInput = await instance.app.evaluate(() =>
      globalThis.__batchWorkerObservation.activeBatchInput(),
    );
    assert.equal(privateInput.sessionId, nativeBatchIds.sessionId);
    assert.ok(privateInput.operationBatchToken && privateInput.clientMessageId);
    forbiddenEvidenceToken = privateInput.operationBatchToken;
    wire.registerForbiddenToken(privateInput.operationBatchToken);
    if (caseName === "forged-ingress") {
      await wire.firstReached;
      await forge(instance, privateInput);
      wire.releaseFirst();
    }
    stage = "actual worker item approvals and verification";
    let revocationDone = false;
    await waitFor(
      "actual worker Run completion",
      async () => {
        await approvePending(instance, caseName === "item-cancel");
        if (caseName === "scope-revocation" && !revocationDone && wire.snapshot().secondWaiting) {
          await wire.secondReached;
          const bytes = await readFile(
            join(isolated.codeShellHome, "sessions/.operations/ledger.json"),
          );
          const records = Object.values(JSON.parse(bytes).records);
          assert.equal(records.length, 3);
          assert.equal(
            records.filter((row) => row.state === "planned" && !row.attemptId).length,
            1,
          );
          assert.equal(
            records.filter((row) => row.state === "verified" && row.reference?.id === "101").length,
            1,
          );
          assert.equal(
            records.filter((row) => row.state === "blocked" && !row.attemptId).length,
            1,
          );
          scopeCheckpoint = {
            sha256: hash(bytes),
            records,
            at: Date.now(),
            modelResponseStillHeld: true,
          };
          const state = await instance.app.evaluate(() => globalThis.__readBatchWorkerState());
          assert.equal(state.status, "active");
          revoke = await instance.app.evaluate(() => globalThis.__revokeBatchWorker());
          assert.deepEqual(revoke.capabilities, ["github.list_issues", "github.get_issue"]);
          revocationDone = true;
          wire.releaseSecond();
        }
        return instance.app.evaluate(() => ({
          state: globalThis.__readBatchWorkerState(),
          protocol: globalThis.__batchWorkerObservation.snapshot(),
        }));
      },
      ({ state, protocol }) =>
        state.status !== "active" &&
        protocol.frames.some(
          (row) =>
            row.direction === "stdout" &&
            typeof row.id === "string" &&
            row.id.startsWith("operation-batch-run-"),
        ),
      90_000,
    );
    firstObservation = await instance.app.evaluate(() =>
      globalThis.__batchWorkerObservation.snapshot(),
    );
    firstRunOutcome = await instance.app.evaluate(() =>
      globalThis.__batchWorkerObservation.batchRunOutcome(),
    );
    assert.equal(firstRunOutcome.sessionId, nativeBatchIds.sessionId);
    await nonceBoundary(instance, privateInput.operationBatchToken, "first");
    ledgerEvidence = await sealedLedger();
    const stateCounts = Object.fromEntries(
      ["verified", "unknown", "blocked"].map((state) => [
        state,
        ledgerEvidence.records.filter((row) => row.state === state).length,
      ]),
    );
    assert.ok(
      ledgerEvidence.records.some(
        (row) => row.state === "blocked" && row.error === "unsupported" && !row.attemptId,
      ),
      "Legacy single identity remains a non-sendable blocked anchor",
    );
    const originalSnapshot = wire.snapshot();
    assert.equal(originalSnapshot.unexpected, 0);
    assert.ok(approvalCount >= 1, "The actual per-item closed-set approval was exercised");
    if (["success", "forged-ingress", "cold-restart"].includes(caseName)) {
      assert.equal(originalSnapshot.createIssueRequests, 2);
      assert.equal(originalSnapshot.readbackCount, 2);
      assert.equal(originalSnapshot.linkStep, 2);
      assert.equal(approvalCount, 2);
      assert.deepEqual(stateCounts, { verified: 2, unknown: 0, blocked: 1 });
      const firstReadback = originalSnapshot.requests.find(
        (row) => row.action === "get_issue" && row.number === 101,
      );
      const secondWrite = originalSnapshot.requests.find(
        (row) => row.action === "create_issue" && row.item === 1,
      );
      assert.ok(
        firstReadback.responseFinishSequence < secondWrite.requestSequence,
        "First actual HTTP readback must finish before the second physical write",
      );
      assert.ok(
        secondWrite.ledgerBeforeWrite.records.some(
          (row) => row.state === "verified" && row.reference?.id === "101",
        ),
      );
    } else if (caseName === "item-cancel") {
      assert.equal(originalSnapshot.createIssueRequests, 0);
      assert.equal(
        originalSnapshot.linkStep,
        3,
        "Model attempted both same-item retry and remaining item",
      );
      assert.deepEqual(stateCounts, { verified: 0, unknown: 0, blocked: 3 });
      assert.ok(ledgerEvidence.records.every((row) => !row.attemptId));
    } else if (caseName === "failed-readback") {
      assert.equal(originalSnapshot.createIssueRequests, 1);
      assert.equal(
        originalSnapshot.readbackCount,
        1,
        "A later restored readback cannot revive batch authority",
      );
      assert.equal(originalSnapshot.linkStep, 3);
      assert.deepEqual(stateCounts, { verified: 0, unknown: 1, blocked: 2 });
      assert.ok(
        ledgerEvidence.records.some(
          (row) => row.state === "unknown" && row.error === "postcondition_failed" && row.attemptId,
        ),
      );
    } else {
      assert.equal(revocationDone, true);
      assert.equal(originalSnapshot.createIssueRequests, 1);
      assert.deepEqual(stateCounts, { verified: 1, unknown: 0, blocked: 2 });
    }
    await save(join(evidence, "first-result.json"), {
      caseName,
      seed,
      processes,
      originalSnapshot,
      firstObservation,
      approvalCount,
      revoke,
      phases,
      ledgerEvidence,
      stateCounts,
      scopeCheckpoint,
      firstRunOutcome,
    });
    await stop(instance);
    const workerRows = (await readFile(join(isolated.home, "batch-protocol.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const ends = workerRows.filter((row) => row.event === "worker-close");
    assert.equal(ends.length, 1);
    assert.ok(
      ends.every(
        (row) =>
          row.exit?.code === 0 &&
          row.close?.code === 0 &&
          row.stdinErrors === 0 &&
          row.stdinCalls === row.stdinCallbacks,
      ),
    );
    if (caseName === "cold-restart") {
      stage = "cold actual Main and revoked old batch authority";
      const before = wire.snapshot();
      wire.enterColdReplay();
      const cold = await launch("cold", false);
      // Known old private token is rejected at the actual new Main ingress.
      await cold.win.evaluate((input) => {
        window.__batchFixtureIngress.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "BATCH-FORGED-INGRESS-cold",
            method: "agent/run",
            params: input,
          }),
        );
      }, privateInput);
      await cold.win.evaluate(
        ({ origin, sessionId, cwd }) => {
          window.__batchColdRun = { state: "pending" };
          void window.codeshell
            .run("Attempt the old fixed Issue batch again without Native approval.", {
              cwd,
              sessionId,
              requireExisting: true,
              clientMessageId: origin,
              disableGoal: true,
            })
            .then(
              (value) => {
                window.__batchColdRun = { state: "resolved", value };
              },
              (error) => {
                window.__batchColdRun = { state: "rejected", error: String(error) };
              },
            );
        },
        {
          origin: privateInput.clientMessageId,
          sessionId: nativeBatchIds.sessionId,
          cwd: projectRoot,
        },
      );
      await verifyProcesses(cold, true);
      const replay = await waitFor(
        "cold ordinary same-origin Run settled",
        () => cold.win.evaluate(() => window.__batchColdRun),
        (value) => value.state !== "pending",
        60_000,
      );
      coldObservation = await cold.app.evaluate(() =>
        globalThis.__batchWorkerObservation.snapshot(),
      );
      assert.equal(replay.state, "resolved");
      assert.equal(replay.value.error, undefined);
      assert.deepEqual(
        replay.value.result,
        firstRunOutcome,
        "Actual worker returns the original persisted Run receipt",
      );
      const ordinaryRuns = coldObservation.frames.filter(
        (row) => row.direction === "stdin" && row.method === "agent/run" && !row.hasBatchToken,
      );
      assert.equal(
        ordinaryRuns.length,
        1,
        "One actual ordinary old-origin request reaches the fresh worker",
      );
      assert.equal(ordinaryRuns[0].originHash, hash(privateInput.clientMessageId));
      assert.equal(
        coldObservation.frames.filter((row) => row.direction === "stdin" && row.hasBatchToken)
          .length,
        0,
      );
      assert.equal(
        coldObservation.frames.filter((row) => row.direction === "stdin" && row.forgedMarker)
          .length,
        0,
      );
      assert.equal(wire.snapshot().createIssueRequests, before.createIssueRequests);
      assert.equal(
        wire.snapshot().modelCount,
        before.modelCount,
        "Durable input deduplication happens before any new model/tool execution",
      );
      assert.deepEqual(
        await sealedLedger(),
        ledgerEvidence,
        "Cold replay does not change fixed batch receipts",
      );
      await nonceBoundary(cold, privateInput.operationBatchToken, "cold");
      await save(join(evidence, "cold-result.json"), {
        before,
        after: wire.snapshot(),
        coldObservation,
        replayedRunResult: replay.value.result,
        deduplicationBoundary:
          "Old clientMessageId is replayed before model/tool execution. This case does not claim a new ledger/tool replay was executed.",
        noBatchAuthoritySurvived: true,
        freshMainPid: cold.child.pid,
        oldMainPid: instance.child.pid,
      });
      await stop(cold);
    }
    stage = "complete";
  } catch (error) {
    failure = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    wire.releaseFirst();
    wire.releaseSecond();
    for (const instance of appInstances) {
      await stop(instance).catch((error) => {
        cleanupUnknown = true;
        failure ??= String(error);
      });
      if (instance.rendererErrors?.length) {
        failure ??= instance.rendererErrors.map((error) => error.message).join("\n");
        process.exitCode = 1;
      }
    }
    try {
      const spawned = (
        await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8").catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      const events = (
        await readFile(join(isolated.home, "batch-protocol.jsonl"), "utf8").catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      const endings = events.filter((row) => row.event === "worker-close");
      assert.equal(
        endings.length,
        spawned.length,
        "Every actual worker must have an actual close receipt",
      );
      for (const { pid } of spawned) {
        const matches = endings.filter((row) => row.pid === pid);
        assert.equal(matches.length, 1);
        assert.ok(
          matches[0].exit?.code === 0 &&
            matches[0].close?.code === 0 &&
            !matches[0].exit.signal &&
            !matches[0].close.signal,
        );
        assert.equal(matches[0].stdinCalls, matches[0].stdinCallbacks);
        assert.equal(matches[0].stdinErrors, 0);
      }
    } catch (error) {
      cleanupUnknown = true;
      failure ??= String(error);
    }
    clearTimeout(limit);
    clearTimeout(hardLimit);
    await closeOwnedWire();
    try {
      const finalWire = wire.snapshot();
      assert.equal(
        finalWire.unexpected,
        0,
        "Every actual fixture HTTP request must match its contract",
      );
      if (privateInput) {
        assert.equal(finalWire.nonce.registered, true);
        assert.equal(
          finalWire.nonce.priorChecks + finalWire.nonce.laterChecks,
          finalWire.requests.length,
        );
        await save(join(evidence, "shutdown-nonce-boundary.json"), {
          allOwnedMainClosed: appInstances.every((instance) => instance.closed),
          tokenHash: hash(privateInput.operationBatchToken),
          http: finalWire.nonce,
          persistent: await persistentNonceBoundary(privateInput.operationBatchToken),
          rawRequestTextPersisted: false,
          deliberateKnownNonceAttack: ["forged-ingress", "cold-restart"].includes(caseName),
        });
      }
    } catch (error) {
      failure ??= String(error);
    }
    if (failure || timedOut || cleanupUnknown) process.exitCode = 1;
    await save(join(evidence, "receipt.json"), {
      passed: !process.exitCode,
      caseName,
      stage,
      failure,
      timedOut,
      cleanupUnknown,
      elapsedMs: Date.now() - startedAt,
      parentPid: process.pid,
      parentPpid: process.ppid,
      node: process.version,
      parentExecutable: await realpath(process.execPath),
      homeHash: hash(isolated.home),
      parentGuard,
      apps: appInstances.map(({ phase, child, exited, closed, exit, close }) => ({
        phase,
        pid: child.pid,
        exited,
        closed,
        exit,
        close,
      })),
      wire: wire.snapshot(),
      approvalCount,
      phases,
      boundaries: [
        "Synthetic private account and one exact HTTP origin only; no real provider/account or paid model",
        "Real OS batch confirmation is manual; only per-item existing preload approval API is exercised",
        "Actual worker ready/RPC/resolver/nonce are never replaced",
        "JS HTTP and child-launch guards do not establish raw net/tls, Chromium, kernel or OS confinement",
        "Private HOME does not isolate the existing OS Keychain; only the synthetic record uses actual production cipher",
      ],
    });
    console.log(
      `Actual batch worker ${caseName}: ${process.exitCode ? "FAILED" : "recorded"}; evidence=${evidence}`,
    );
  }
  runtimeReturned = true;
} catch (error) {
  outerFailure = String(error?.stack ?? error).slice(0, 16_384);
  process.exitCode = 1;
} finally {
  let resource;
  try {
    resource = await closeOwnedWire();
  } catch (error) {
    resource = {
      created: !!ownedWire,
      closed: false,
      cleanupUnknown: true,
      error: String(error?.stack ?? error).slice(0, 16_384),
    };
    process.exitCode = 1;
  }
  await save(join(evidence, "wire-ownership.json"), {
    caseName,
    scope: "Outer resource owner covers preparation and the existing runtime",
    runtimeReturned,
    failure: outerFailure,
    resource,
    parentPid: process.pid,
    parentPpid: process.ppid,
    node: process.version,
    homeHash: hash(isolated.home),
  });
}
