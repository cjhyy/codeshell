/* Compiled SDK Engine → production Main/native confirmation → existing activity UI.
 * Synthetic Link adapter only; deny-all HTTP is installed in every actual process. */
/* global document, Event, localStorage, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "codeshell-operation-resolution-"));
// Preserve the real OS keyring session (CI supplies its own private keyring),
// while excluding inherited provider credentials and Host configuration.
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
  origin: "http://127.0.0.1:9",
  guardModule: new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href,
});
fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
const projectRoot = join(isolated.home, "synthetic-project");
const sessionId = "operation-resolution-session";
const evidenceDir = join(isolated.home, "evidence");
let app, win, engine, core;
let stage = "initialize";
const calls = [];
let approvals = 0;
let credentialEnabled = true;
let physicalRequests = 0;
let success = false;
const observations = [];

async function guardProcesses() {
  const mainPid = app.process().pid;
  const homeId = createHash("sha256").update(isolated.home).digest("hex");
  for (let attempt = 0; attempt < 150; attempt++) {
    const receipts = (await readFile(fixture.env.CODESHELL_COST_GUI_GUARD_LOG, "utf8"))
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
    for (const receipt of receipts) {
      assert.equal(receipt.homeId, homeId);
      assert.equal(receipt.origin, "http://127.0.0.1:9");
      assert.equal(receipt.negativeProbes, 7);
    }
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
        receipts,
        workerPids: spawned.map((worker) => worker.pid),
      };
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Actual Main/parent/worker guard receipts missing");
}
async function launch() {
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: fixture.env,
    mainEntry: fixture.mainEntry,
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
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
    globalThis.__operationDialogs = { accept: false, prompts: [] };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__operationDialogs.prompts.push(options);
      return { response: globalThis.__operationDialogs.accept ? 1 : 0 };
    };
  });
  return errors;
}
async function activityReview() {
  await navigateSettingsMenu(win, "Task center", { activity: true });
  const card = win.locator(`[data-task-key="session:${sessionId}"]`);
  await card.waitFor({ timeout: 20_000 });
  await card.getByRole("button", { name: "Review uncertain external writes", exact: true }).click();
  await card
    .getByText("No original reference. Review at the provider yourself.", { exact: true })
    .waitFor();
  return card;
}
try {
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(projectRoot, ".code-shell"), { recursive: true });
  await writeFile(
    join(projectRoot, ".code-shell/settings.json"),
    JSON.stringify({
      permissions: {
        rules: [
          {
            tool: "LinkAction",
            argsPattern: { action: "^(get_issue|list_issues)$" },
            decision: "allow",
          },
        ],
      },
    }),
  );
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
          id: "operation-project",
          name: "Synthetic operation project",
          primaryRootId: "operation-root",
          roots: [
            {
              id: "operation-root",
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
  stage = "launch actual guarded Main";
  const rendererErrors = await launch();
  Object.assign(
    process.env,
    Object.fromEntries(Object.entries(fixture.env).filter(([, value]) => value !== undefined)),
  );
  await import("./runtime-cost-gui-guard.mjs");
  let processes = await guardProcesses();
  stage = "actual compiled Engine creates uncertain write";
  core = await import("@cjhyy/code-shell-core");
  const credential = {
    id: "synthetic-link",
    type: "oauth",
    label: "Synthetic",
    hasSecret: true,
    oauthStatus: { state: "valid", hasRefreshToken: true, canRefresh: true },
    meta: {
      linkProvider: "github",
      linkAccountId: "synthetic-account",
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteState: "connected",
      linkRemoteGrantId: "synthetic-grant",
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      linkCapabilityIds: ["github.list_issues", "github.create_issue", "github.get_issue"],
    },
  };
  core.setDefaultCredentialAccess({
    listMasked: () => (credentialEnabled ? [credential] : []),
    resolveMeta: () => (credentialEnabled ? credential : undefined),
    envExposures: () => ({}),
    resolveValue: async () => {
      throw new Error("Raw token access forbidden");
    },
    executeRemoteLinkAction: async (input) => {
      calls.push({ action: input.action, repo: input.params.repo });
      if (input.action === "create_issue" && input.params.repo === "unknown")
        throw new Error("Synthetic lost response");
      return input.action === "list_issues"
        ? { issues: [] }
        : { number: 7, title: "PRIVATE_TITLE", body: "PRIVATE_BODY", state: "open" };
    },
  });
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
      const tools = new Set((request.tools ?? []).map((tool) => tool.name));
      if (!tools.has("LinkAction"))
        return {
          text: "",
          stopReason: "tool_use",
          usage,
          toolCalls: [
            { id: "discover", toolName: "ToolSearch", args: { query: "select:LinkAction" } },
          ],
        };
      if (results.some((block) => block.tool_use_id === "create"))
        return { text: "Model claims success", usage, stopReason: "stop", toolCalls: [] };
      const unknown = request.messages[intent].content.includes("unknown");
      return {
        text: "",
        stopReason: "tool_use",
        usage,
        toolCalls: [
          {
            id: "create",
            toolName: "LinkAction",
            args: {
              provider: "github",
              action: "create_issue",
              connectionId: credential.id,
              params: {
                owner: "fixture",
                repo: unknown ? "unknown" : "success",
                title: "PRIVATE_TITLE",
                body: "PRIVATE_BODY",
              },
            },
          },
        ],
      };
    }
  }
  core.registerProvider("operation-resolution-synthetic", SyntheticProvider);
  const createEngine = () => {
    const value = new core.Engine({
      llm: { provider: "operation-resolution-synthetic", model: "synthetic", apiKey: "synthetic" },
      cwd: projectRoot,
      sessionStorageDir: join(isolated.codeShellHome, "sessions"),
      settingsScope: "project",
      enabledBuiltinTools: ["LinkAction"],
      maxTurns: 5,
      headless: true,
      isSubAgent: false,
      origin: "desktop",
      permissionMode: "default",
      approvalBackend: {
        requestApproval: async () => {
          approvals++;
          return { approved: true };
        },
      },
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
  const run = (text, clientMessageId) =>
    engine.run(text, { sessionId, clientMessageId, behaviorMode: "synthetic" });
  engine = createEngine();
  assert.equal((await run("fixture unknown", "original-intent")).reason, "unverified_write");
  await engine.dispose();
  engine = undefined;
  const sessionPath = join(isolated.codeShellHome, "sessions", sessionId);
  stage = "wait for actual auxiliary usage callbacks and saved idle state";
  // Engine.run has really returned its terminal result. Tool summaries settle
  // asynchronously, so wait for their actual completed receipts and persisted
  // accounting projection; never overwrite state to manufacture idleness.
  const usagePath = join(
    isolated.codeShellHome,
    "sessions/.usage-ledger",
    createHash("sha256").update("default").digest("hex"),
  );
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
      own.filter((row) => row.purpose === "tool_summary").length === 2 &&
      state.costState.summary.requests === 5 &&
      state.tokenUsage.totalTokens === 55 &&
      state.status === "unverified_write"
    ) {
      observations.push({
        phase: "actual idle after auxiliary callbacks",
        stateRevision: state.stateRevision,
        status: state.status,
        requests: physicalRequests,
        purposes: own.map((row) => row.purpose),
        outcomes: own.map((row) => row.outcome),
      });
      break;
    }
    if (attempt >= 150)
      throw new Error("Actual auxiliary requests did not reach durable terminal accounting");
    await new Promise((done) => setTimeout(done, 100));
  }
  let originalState = await readFile(join(sessionPath, "state.json"), "utf8");
  let originalTranscript = await readFile(join(sessionPath, "transcript.jsonl"), "utf8");
  const originalRuns = originalTranscript
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((event) => event.type === "run_result");
  const ledgerPath = join(isolated.codeShellHome, "sessions/.operations/ledger.json");
  const originalLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const original = Object.values(originalLedger.records).find(
    (record) => record.state === "unknown",
  );
  assert.ok(original);
  const beforeReview = calls.length;
  stage = "existing activity UI cancels native confirmation";
  // Reload reads the actual newly created disk Session; no fixture IPC replaces production handlers.
  await win.reload();
  const card = await activityReview();
  await card.getByRole("button", { name: "Accept after manual review…", exact: true }).click();
  await card
    .getByRole("button", { name: "Accept after manual review…", exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    JSON.parse(await readFile(ledgerPath, "utf8")).records[original.id].operatorResolution,
    undefined,
  );
  assert.equal(calls.length, beforeReview);
  // These are the actual already-idle saved bytes; no test state mutation.
  originalState = await readFile(join(sessionPath, "state.json"), "utf8");
  originalTranscript = await readFile(join(sessionPath, "transcript.jsonl"), "utf8");
  assert.deepEqual(
    originalTranscript
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((event) => event.type === "run_result"),
    originalRuns,
  );
  stage = "existing activity UI accepts uncertainty via native prompt";
  await app.evaluate(() => {
    globalThis.__operationDialogs.accept = true;
  });
  await card.getByRole("button", { name: "Accept after manual review…", exact: true }).click();
  await card
    .getByText("Uncertainty accepted manually; result remains unknown", { exact: true })
    .waitFor();
  const resolved = JSON.parse(await readFile(ledgerPath, "utf8")).records[original.id];
  assert.deepEqual(
    { ...resolved, operatorResolution: undefined },
    { ...original, operatorResolution: undefined },
  );
  assert.equal(resolved.operatorResolution.decision, "accept_uncertainty");
  assert.equal(await readFile(join(sessionPath, "state.json"), "utf8"), originalState);
  assert.equal(await readFile(join(sessionPath, "transcript.jsonl"), "utf8"), originalTranscript);
  assert.equal(calls.length, beforeReview, "manual decision makes zero provider calls");
  assert.doesNotMatch(
    await card.innerText(),
    /PRIVATE_TITLE|PRIVATE_BODY|synthetic-account|synthetic-grant/,
  );
  const prompts = await app.evaluate(() => globalThis.__operationDialogs.prompts);
  assert.equal(prompts.length, 2);
  assert.ok(
    prompts.every(
      (prompt) =>
        prompt.defaultId === 0 && prompt.cancelId === 0 && prompt.detail.includes("结果仍未知"),
    ),
  );
  await win.screenshot({ path: join(evidenceDir, "accepted.png") });
  observations.push({
    phase: "cancel/accept",
    providerCalls: calls.length,
    prompts: prompts.length,
  });
  stage = "cold actual Main restart retains operator decision";
  await app.close();
  app = undefined;
  win = undefined;
  // The writer remains deny-all. A pure Playwright controller (no Core/model
  // imports) owns the new CDP handshake; the actual cold Main and workers still
  // preload the same deny-all guard before importing production code.
  const controllerEnv = { ...environment };
  delete controllerEnv.NODE_OPTIONS;
  await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./operation-resolution-cold-review.mjs", import.meta.url)),
        isolated.home,
      ],
      { env: controllerEnv, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? done() : reject(new Error(`Cold Main controller failed (${code})`)),
    );
  });
  const cold = JSON.parse(await readFile(join(evidenceDir, "cold-main.json"), "utf8"));
  assert.notEqual(cold.mainPid, processes.mainPid);
  processes = { ...processes, cold };
  stage = "cold actual Engine: original replay sends nothing; a new trusted intent writes once";
  engine = createEngine();
  const replay = await run("fixture unknown", "original-intent");
  assert.equal(replay.reason, "unverified_write");
  assert.equal(calls.length, beforeReview);
  const fresh = await run("fixture success", "fresh-trusted-intent");
  assert.equal(fresh.reason, "completed");
  assert.ok(approvals >= 2, "original and fresh intents each traverse the tool approval backend");
  assert.deepEqual(
    calls.slice(beforeReview).map((call) => call.action),
    ["list_issues", "create_issue", "get_issue"],
  );
  assert.equal(
    JSON.parse(await readFile(ledgerPath, "utf8")).records[original.id].state,
    "unknown",
  );
  const callsBeforeRevocation = calls.length;
  credentialEnabled = false;
  await run("fixture success", "revoked-new-intent");
  assert.equal(
    calls.length,
    callsBeforeRevocation,
    "a new intent still requires a current connected account",
  );
  assert.ok(
    (await readFile(join(sessionPath, "transcript.jsonl"), "utf8")).includes(
      '"reason":"unverified_write"',
    ),
  );
  assert.equal(rendererErrors.length, 0, rendererErrors.map((error) => error.message).join("\n"));
  success = true;
  await writeFile(
    join(evidenceDir, "receipt.json"),
    JSON.stringify(
      {
        success,
        stage,
        processes,
        calls,
        approvals,
        observations,
        checks: [
          "actual compiled Engine ToolSearch/LinkAction",
          "production Main/native default-cancel confirmation",
          "existing Settings activity UI",
          "provider-zero manual resolution",
          "cold Main/Engine restart",
          "immutable old unknown/Run",
          "old intent zero resend",
          "new intent independently verified",
          "account revocation blocks new writes",
        ],
        limitation:
          "Synthetic account/provider only; no real provider verification or paid model. Native dialog response controlled by acceptance harness.",
      },
      null,
      2,
    ),
  );
  console.log(`Operation resolution native acceptance passed. Evidence: ${evidenceDir}`);
} catch (error) {
  const diagnostic = await win
    ?.evaluate(async () => ({
      tasks: await window.codeshell.taskInbox.list(),
      text: document.body.innerText,
    }))
    .catch(() => undefined);
  await win?.screenshot({ path: join(evidenceDir, "failed.png") }).catch(() => undefined);
  await writeFile(
    join(evidenceDir, "failure.json"),
    JSON.stringify({ stage, message: String(error), calls, diagnostic }, null, 2),
  ).catch(() => undefined);
  console.error(`Operation resolution acceptance failed at ${stage}; evidence: ${evidenceDir}`);
  throw error;
} finally {
  await engine?.dispose();
  core?.setDefaultCredentialAccess(null);
  await app?.close();
  // Keep this private fixture's evidence for review; never copy synthetic secrets to the repository.
  if (!success) console.error(`Private fixture retained: ${isolated.home}`);
}
