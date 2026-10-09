/* Actual compiled Engine → production native Main → existing activity UI → cold Main.
 * Synthetic account/HTTP only. Every Core process is confined before importing Core. */
/* global Event, localStorage, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "codeshell-operation-read-"));
const keyringKeys = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SESSION_BUS_PID",
  "GNOME_KEYRING_CONTROL",
  "GNOME_KEYRING_PID",
  "SECURITYSESSIONID",
  "XDG_CURRENT_DESKTOP",
  "WAYLAND_DISPLAY",
];
const keyringEnvironment = Object.fromEntries(
  keyringKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);
const environment = { ...createBunTestEnvironment(process.env, root), ...keyringEnvironment };
for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
Object.assign(process.env, environment);
const isolated = {
  home: environment.HOME,
  codeShellHome: environment.CODE_SHELL_HOME,
  userDataDir: join(environment.HOME, "electron-user-data"),
};
const calls = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const params = JSON.parse(
    Buffer.concat(chunks).toString("utf8") || url.searchParams.get("params") || "{}",
  );
  const [, phase, action] = url.pathname.split("/");
  calls.push({ phase, action, method: request.method, params });
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify(
      action === "get_repository"
        ? { id: 123, full_name: "fixture/repo" }
        : action === "get_starred"
          ? { starred: phase !== "original" }
          : {},
    ),
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const { prepareConfinedElectronFixture } = await import("./confined-electron-fixture.mjs");
const {
  launchCodeShellElectron,
  findCodeShellWindow,
  navigateSettingsMenu,
  captureRendererErrors,
} = await import("./electron-harness.mjs");
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin,
  guardModule: new URL("./operation-read-guard.mjs", import.meta.url).href,
});
const projectRoot = join(isolated.home, "synthetic-project");
const sessionId = "operation-read-session";
const evidenceDir = join(isolated.home, "evidence");
const helperUrl = new URL("./operation-read-fixture.mjs", import.meta.url).href;
const coreUrl = pathToFileURL(resolve(appDir, "../core/dist/index.js")).href;
const repository = resolve(appDir, "../..");
const sourcePaths = [
  "packages/core/src/operations/ledger.ts",
  "packages/core/src/operations/recovery.ts",
  "packages/core/src/operations/review-store.ts",
  "packages/core/src/operations/controller.ts",
  "packages/core/src/operations/session-owner.ts",
  "packages/core/src/links/operation-reader.ts",
  "packages/core/src/links/operation-recovery.ts",
  "packages/core/src/links/operation-reconcile.ts",
  "packages/core/src/links/operation-review.ts",
  "packages/core/src/links/link-action-tool.ts",
  "packages/core/src/links/verified-write.ts",
  "packages/core/src/links/verified-star.ts",
  "packages/core/src/links/verified-issue-state.ts",
  "packages/core/src/links/github-star.ts",
  "packages/core/src/links/github-issue-state.ts",
  "packages/desktop/src/main/operation-resolution-ipc.ts",
  "packages/desktop/src/shared/operation-resolution.ts",
  "packages/desktop/src/preload/operation-resolution-api.ts",
  "packages/desktop/src/renderer/task-inbox/OperationResolutionReview.tsx",
];
const sourceFiles = Object.fromEntries(
  sourcePaths.map((path) => [
    path,
    execFileSync("git", ["hash-object", path], { cwd: repository, encoding: "utf8" }).trim(),
  ]),
);
const artifactPaths = [
  "packages/core/dist/index.js",
  "packages/core/dist/links/operation-reader.js",
  "packages/core/dist/links/operation-review.js",
  "packages/core/dist/links/operation-recovery.js",
  "packages/core/dist/links/operation-reconcile.js",
  "packages/core/dist/links/verified-write.js",
  "packages/core/dist/links/verified-star.js",
  "packages/core/dist/links/verified-issue-state.js",
  "packages/core/dist/operations/ledger.js",
  "packages/core/dist/operations/recovery.js",
  "packages/core/dist/operations/review-store.js",
  "packages/core/dist/operations/controller.js",
  "packages/desktop/out/main/index.mjs",
  "packages/desktop/out/preload/index.cjs",
  "packages/desktop/out/renderer/index.html",
  ...(await readdir(join(repository, "packages/desktop/out/renderer/assets")))
    .filter((name) => /\.(?:js|css)$/.test(name))
    .map((name) => `packages/desktop/out/renderer/assets/${name}`),
];
const artifacts = Object.fromEntries(
  await Promise.all(
    artifactPaths.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(join(repository, path)))
        .digest("hex"),
    ]),
  ),
);
const sourceEvidence = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  status: execFileSync("git", ["status", "--porcelain"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  files: sourceFiles,
  artifacts,
  fingerprint: createHash("sha256")
    .update(JSON.stringify({ sourceFiles, artifacts }))
    .digest("hex"),
};
let app,
  win,
  engine,
  core,
  stage = "initialize",
  success = false,
  physicalRequests = 0;
const observations = [];
async function guardedProcesses() {
  const mainPid = app.process().pid;
  const homeId = createHash("sha256").update(isolated.home).digest("hex");
  for (let attempt = 0; ; attempt++) {
    const receipts = (await readFile(join(isolated.home, "operation-read-guard.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const spawned = (
      await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8").catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert.ok(
      receipts.every(
        (row) => row.homeId === homeId && row.origin === origin && row.negativeProbes === 8,
      ),
    );
    if (
      receipts.some((row) => row.pid === mainPid) &&
      receipts.some((row) => row.pid === process.pid) &&
      spawned.every((worker) =>
        receipts.some((row) => row.pid === worker.pid && row.ppid === mainPid),
      )
    ) {
      for (const worker of spawned)
        await writeFile(join(isolated.home, `worker-${worker.pid}.permit`), "verified");
      return {
        mainPid,
        parentPid: process.pid,
        workerPids: spawned.map((row) => row.pid),
        receipts,
      };
    }
    if (attempt >= 150) throw new Error("Actual Main/parent confinement receipt missing");
    await new Promise((done) => setTimeout(done, 100));
  }
}
async function activityReview() {
  await navigateSettingsMenu(win, "Task center", { activity: true });
  const card = win.locator(`[data-task-key="session:${sessionId}"]`);
  await card.waitFor({ timeout: 20_000 });
  await card.getByRole("button", { name: "Review uncertain external writes", exact: true }).click();
  await card.getByText("Result remains unknown", { exact: true }).waitFor();
  return card;
}
try {
  await mkdir(join(projectRoot, ".code-shell"), { recursive: true });
  const settingsPath = join(projectRoot, ".code-shell/settings.json");
  const readRules = [
    {
      tool: "LinkAction",
      argsPattern: { action: "^(get_repository|get_starred)$" },
      decision: "allow",
    },
  ];
  await writeFile(settingsPath, JSON.stringify({ permissions: { rules: readRules } }));
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, language: "en" }),
  );
  await writeFile(
    join(isolated.codeShellHome, "desktop/projects.json"),
    JSON.stringify({
      version: 2,
      projects: [
        {
          id: "read-project",
          name: "Synthetic read project",
          primaryRootId: "read-root",
          roots: [
            {
              id: "read-root",
              name: "Synthetic root",
              path: projectRoot,
              canonicalIdentity: projectRoot,
              addedAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1,
          revision: 1,
        },
      ],
    }),
  );
  await writeFile(
    join(isolated.codeShellHome, "desktop/trust.json"),
    JSON.stringify({ [projectRoot]: "trusted" }),
  );
  await writeFile(
    join(isolated.home, "read-fixture.json"),
    JSON.stringify({ origin, helperUrl, coreUrl, sessionId }),
  );
  await writeFile(
    join(isolated.home, "operation-read-source.json"),
    JSON.stringify(sourceEvidence),
  );
  // Playwright's Main VM does not provide a dynamic-import callback. Put only
  // the synthetic custody adapter in the guarded ESM bootstrap, after the
  // production Main import; actual IPC/authority/UI stay production code.
  await writeFile(
    fixture.mainEntry,
    (await readFile(fixture.mainEntry, "utf8")) +
      `\nglobalThis.__readCustody = (await import(${JSON.stringify(helperUrl)})).installOperationReadFixture(await import(${JSON.stringify(coreUrl)}), ${JSON.stringify(origin)}, "review");\n`,
  );
  stage = "launch guarded production Main";
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: fixture.env,
    mainEntry: fixture.mainEntry,
  });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1440, height: 980 });
  const viewOnly = win.getByRole("button", { name: /^(仅查看|View only)/ });
  if (
    await viewOnly.waitFor({ timeout: 2000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "en");
    window.dispatchEvent(new Event("codeshell:language-changed"));
  });
  await app.evaluate(({ dialog }) => {
    globalThis.__readDialogs = { accept: false, prompts: [] };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__readDialogs.prompts.push(options);
      return { response: globalThis.__readDialogs.accept ? 1 : 0 };
    };
  });
  Object.assign(
    process.env,
    Object.fromEntries(Object.entries(fixture.env).filter(([, value]) => value !== undefined)),
  );
  await import("./operation-read-guard.mjs");
  const processes = await guardedProcesses();
  stage = "actual compiled Engine creates durable unknown Star";
  core = await import(coreUrl);
  (await import(helperUrl)).installOperationReadFixture(core, origin, "original");
  class SyntheticProvider extends core.LLMClientBase {
    initClient() {}
    async createMessage(request) {
      physicalRequests++;
      const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
      this.recordUsage(usage, request);
      const intent = request.messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("fixture "),
      );
      const results = request.messages
        .slice(intent + 1)
        .flatMap((message) =>
          message.role === "user" && Array.isArray(message.content)
            ? message.content.filter((block) => block.type === "tool_result")
            : [],
        );
      if (!(request.tools ?? []).some((tool) => tool.name === "LinkAction"))
        return {
          text: "",
          stopReason: "tool_use",
          usage,
          toolCalls: [
            { id: "discover", toolName: "ToolSearch", args: { query: "select:LinkAction" } },
          ],
        };
      if (results.some((block) => block.tool_use_id === "star"))
        return { text: "Model claims success", usage, stopReason: "stop", toolCalls: [] };
      return {
        text: "",
        stopReason: "tool_use",
        usage,
        toolCalls: [
          {
            id: "star",
            toolName: "LinkAction",
            args: {
              provider: "github",
              action: "set_starred",
              connectionId: "synthetic-read-link",
              params: { owner: "fixture", repo: "repo", starred: true },
            },
          },
        ],
      };
    }
  }
  core.registerProvider("operation-read-synthetic", SyntheticProvider);
  const createEngine = () => {
    const value = new core.Engine({
      llm: { provider: "operation-read-synthetic", model: "synthetic", apiKey: "synthetic" },
      cwd: projectRoot,
      sessionStorageDir: join(isolated.codeShellHome, "sessions"),
      settingsScope: "full",
      enabledBuiltinTools: ["LinkAction"],
      maxTurns: 5,
      headless: true,
      isSubAgent: false,
      origin: "desktop",
      permissionMode: "default",
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
      askUser: async () => "允许执行",
      behaviorProfiles: [
        {
          id: "synthetic",
          disableSessionTitle: true,
          disableHooks: true,
          disableInstructions: true,
          disableMemory: true,
          disableCapabilityContext: true,
          disableSourcesContext: true,
          disableMcp: true,
        },
      ],
    });
    value.getHookRegistry().clear();
    return value;
  };
  const run = (clientMessageId) =>
    engine.run("fixture star", { sessionId, clientMessageId, behaviorMode: "synthetic" });
  engine = createEngine();
  assert.equal((await run("original-intent")).reason, "unverified_write");
  await engine.dispose();
  engine = undefined;
  const sessionPath = join(isolated.codeShellHome, "sessions", sessionId);
  const usagePath = join(
    isolated.codeShellHome,
    "sessions/.usage-ledger",
    createHash("sha256").update("default").digest("hex"),
  );
  stage = "wait for real auxiliary callbacks and persisted idle state";
  for (let attempt = 0; ; attempt++) {
    const state = JSON.parse(await readFile(join(sessionPath, "state.json"), "utf8"));
    const receipts = await Promise.all(
      (await readdir(usagePath))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(join(usagePath, name), "utf8"))),
    );
    const own = receipts.filter(
      (row) =>
        row.accountingSessionId === state.costState.accountingSessionId &&
        row.runId === state.runId,
    );
    if (
      physicalRequests === 5 &&
      own.length === 5 &&
      own.every((row) => row.outcome === "completed") &&
      state.costState.summary.requests === 5 &&
      state.status === "unverified_write"
    )
      break;
    if (attempt >= 150) throw new Error("Actual auxiliary requests did not settle");
    await new Promise((done) => setTimeout(done, 100));
  }
  const ledgerPath = join(isolated.codeShellHome, "sessions/.operations/ledger.json");
  const originalLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const originalState = await readFile(join(sessionPath, "state.json"), "utf8");
  const originalTranscript = await readFile(join(sessionPath, "transcript.jsonl"), "utf8");
  const originalRuns = originalTranscript
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((event) => event.type === "run_result");
  assert.equal(Object.values(originalLedger.records)[0].state, "unknown");
  const beforeReview = calls.length;
  stage = "activity card native cancel sends zero HTTP";
  await win.reload();
  const card = await activityReview();
  await card.getByRole("button", { name: "Read-only review…", exact: true }).click();
  await card.getByRole("button", { name: "Read-only review…", exact: true }).waitFor();
  assert.equal(calls.length, beforeReview);
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).observations, undefined);
  stage = "native fixed read and current ask permission record independent observation";
  await writeFile(
    settingsPath,
    JSON.stringify({
      permissions: {
        rules: [
          { tool: "LinkAction", argsPattern: { action: "^get_starred$" }, decision: "ask" },
          ...readRules,
        ],
      },
    }),
  );
  await app.evaluate(() => {
    globalThis.__readDialogs.accept = true;
  });
  await card.getByRole("button", { name: "Read-only review…", exact: true }).click();
  await card
    .getByText(/Current state matches; this does not prove the original write succeeded/)
    .waitFor();
  assert.deepEqual(
    calls.slice(beforeReview).map((row) => [row.method, row.action, row.params]),
    [
      ["GET", "get_repository", { owner: "fixture", repo: "repo" }],
      ["GET", "get_starred", { owner: "fixture", repo: "repo" }],
    ],
  );
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")).records, originalLedger.records);
  assert.equal(await readFile(join(sessionPath, "state.json"), "utf8"), originalState);
  assert.equal(await readFile(join(sessionPath, "transcript.jsonl"), "utf8"), originalTranscript);
  assert.equal(
    await card.getByRole("button", { name: "Accept after manual review…", exact: true }).count(),
    1,
  );
  assert.doesNotMatch(await card.innerText(), /synthetic-account|synthetic-grant|fixture\/repo/);
  const prompts = await app.evaluate(() => globalThis.__readDialogs.prompts);
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((prompt) => prompt.defaultId === 0 && prompt.cancelId === 0));
  await win.screenshot({ path: join(evidenceDir, "observed.png") });
  observations.push({
    phase: "cancel/read/ask",
    prompts: prompts.length,
    providerReads: calls.length - beforeReview,
  });
  stage = "cold production Main retains observation";
  await app.close();
  app = undefined;
  win = undefined;
  const controllerEnv = { ...environment };
  delete controllerEnv.NODE_OPTIONS;
  await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./operation-read-cold-review.mjs", import.meta.url)), isolated.home],
      { env: controllerEnv, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? done() : reject(new Error(`Cold controller failed (${code})`)),
    );
  });
  const cold = JSON.parse(await readFile(join(evidenceDir, "cold-main.json"), "utf8"));
  assert.notEqual(cold.mainPid, processes.mainPid);
  assert.equal(
    calls.length,
    beforeReview + 2,
    "cold viewing observation sends no provider request",
  );
  stage = "cold actual Engine original replay and new intent remain blocked";
  engine = createEngine();
  assert.equal((await run("original-intent")).reason, "unverified_write");
  assert.equal((await run("fresh-intent")).reason, "unverified_write");
  assert.equal(
    calls.length,
    beforeReview + 2,
    "neither replay nor fresh intent may write after observation only",
  );
  const afterReplay = JSON.parse(await readFile(ledgerPath, "utf8"));
  for (const [id, receipt] of Object.entries(originalLedger.records))
    assert.deepEqual(afterReplay.records[id], receipt);
  assert.ok(Object.values(afterReplay.records).some((record) => record.state === "blocked"));
  const currentRuns = (await readFile(join(sessionPath, "transcript.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((event) => event.type === "run_result");
  assert.deepEqual(currentRuns.slice(0, originalRuns.length), originalRuns);
  assert.equal(rendererErrors.length, 0, rendererErrors.map((error) => error.message).join("\n"));
  success = true;
  await writeFile(
    join(evidenceDir, "receipt.json"),
    JSON.stringify(
      {
        success,
        stage,
        processes: { ...processes, cold },
        source: sourceEvidence,
        calls,
        physicalRequests,
        observations,
        checks: [
          "actual compiled Engine unknown",
          "actual synthetic HTTP fixed GETs only",
          "native cancel and one-time ask",
          "existing activity card",
          "unchanged unknown receipt/Run",
          "cold Main observation",
          "cold Engine original replay zero send",
          "fresh intent remains blocked",
        ],
        limitation:
          "Synthetic account/provider and controlled native dialog answers; no real provider or paid model.",
      },
      null,
      2,
    ),
  );
  console.log(`Operation read native acceptance passed. Evidence: ${evidenceDir}`);
} catch (error) {
  await win?.screenshot({ path: join(evidenceDir, "failed.png") }).catch(() => undefined);
  await writeFile(
    join(evidenceDir, "failure.json"),
    JSON.stringify({ stage, error: String(error), calls }, null, 2),
  ).catch(() => undefined);
  console.error(`Operation read failed at ${stage}; evidence: ${evidenceDir}`);
  throw error;
} finally {
  await engine?.dispose();
  core?.setDefaultCredentialAccess(null);
  await app?.close();
  server.close();
  if (!success) console.error(`Private fixture retained: ${isolated.home}`);
}
