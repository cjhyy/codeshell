/* Compiled Core ledger → production Main IPC/cold restart; per-call trace costs → current UI. No model requests. */
/* global localStorage, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { getElectronKeychainPreflightDiagnostic } from "./electron-keychain-preflight.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appDir, "../..");
const root = await mkdtemp(join(tmpdir(), "codeshell-cost-gui-"));
// Sanitize before importing Playwright or Core; retain the actual OS keyring session.
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
const {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  navigateSettingsMenu,
} = await import("./electron-harness.mjs");
const { prepareConfinedElectronFixture } = await import("./confined-electron-fixture.mjs");
const origin = "http://127.0.0.1:9"; // Sentinel only: the guard refuses even this origin.
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin,
  guardModule: new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href,
});
fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
const evidenceDir = join(isolated.home, "evidence");
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const sessionIds = ["cost-gui-completed", "cost-gui-interrupted"];
const labels = {
  completed: "Cost GUI · completed known models",
  failed: "Cost GUI · failed with missing usage",
  cancelled: "Cost GUI · cancelled and unknown price",
};
const secretReceiptKey = "PRIVATE_SYNTHETIC_RECEIPT_KEY_NOT_FOR_UI";
const secretPatterns = /PRIVATE_SYNTHETIC|requestId|apiKey|authorization|rawPrompt/;
let app;
let win;
let stage = "launch guarded Electron";
let succeeded = false;
const observations = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function guardReceipts() {
  return (await readFile(fixture.env.CODESHELL_COST_GUI_GUARD_LOG, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function verifyActualProcesses() {
  const mainPid = app.process().pid;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const receipts = await guardReceipts();
    const spawned = (
      await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8").catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const receipt of receipts) {
      assert.equal(receipt.kind, "cost-gui-deny-all");
      assert.equal(receipt.origin, origin);
      assert.equal(receipt.homeId, hash(isolated.home));
      assert.equal(receipt.userProfileId, hash(isolated.home));
      assert.equal(receipt.codeShellHomeId, hash(isolated.codeShellHome));
      assert.equal(receipt.testHomeId, hash(isolated.codeShellHome));
      assert.equal(receipt.negativeProbes, 7);
    }
    const main = receipts.find((receipt) => receipt.pid === mainPid);
    const parent = receipts.find((receipt) => receipt.pid === process.pid);
    if (
      main &&
      parent &&
      spawned.every(({ pid }) =>
        receipts.some((receipt) => receipt.pid === pid && receipt.ppid === mainPid),
      )
    ) {
      assert.equal(main.ppid, process.pid);
      for (const worker of spawned)
        await writeFile(join(isolated.home, `worker-${worker.pid}.permit`), "verified", {
          mode: 0o600,
        });
      return {
        mainPid,
        parentPid: process.pid,
        workerPids: spawned.map(({ pid }) => pid),
        workerStatus: spawned.length ? "actual guarded workers verified" : "no worker created",
        receipts,
      };
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Missing actual process deny-all negative-probe/HOME receipts");
}
function assertSafeSummary(summary) {
  assert.doesNotMatch(JSON.stringify(summary), secretPatterns);
  assert.ok(
    !JSON.stringify(summary).includes(isolated.home),
    "Cost summary excludes storage paths",
  );
}
function compareSummary(actual, expected, label) {
  for (const key of [
    "requests",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "unknownCostRequests",
    "unknownUsageRequests",
    "partial",
  ])
    assert.equal(actual[key], expected[key], `${label}: ${key}`);
  assert.equal(
    actual.knownEstimatedCostUsd.toFixed(6),
    expected.knownEstimatedCostUsd.toFixed(6),
    label,
  );
  assert.deepEqual(actual.byModel, expected.byModel, `${label}: complete provider/model groups`);
  assertSafeSummary(actual);
}
async function screenshot(name) {
  await win.screenshot({ path: join(evidenceDir, name), scale: "css", animations: "disabled" });
}
async function openTraces() {
  await navigateSettingsMenu(win, "Execution traces", { activity: true });
  await win.getByRole("heading", { name: "Execution traces", level: 1, exact: true }).waitFor();
}
async function selectTrace(id, sessionId, cost, status, { unknownAttempts = 0 } = {}) {
  const page = win.locator("[data-model-traces-page]");
  const session = page.locator(`[data-trace-session="session:${sessionId}"]`);
  if (!(await session.isVisible())) {
    const back = page.getByRole("button", { name: "Back to conversations", exact: true });
    if (await back.isVisible()) await back.click();
  }
  await session.click();
  // Session selection schedules heading focus on the next animation frame.
  // Let it finish before activating the request through its own keyboard target.
  await page.evaluate(() => new Promise((done) => window.requestAnimationFrame(done)));
  await page.locator(`[data-trace-request="${id}"]`).press("Enter");
  const detail = page.locator(`[data-trace-detail-id="${id}"]`);
  await detail.waitFor();
  await detail.getByText(status, { exact: true }).waitFor();
  const value =
    cost == null
      ? "Cost not recorded"
      : `~$${cost.toFixed(6)}${unknownAttempts ? ` · ${unknownAttempts} additional attempts have unknown cost` : ""}`;
  await detail.getByText(value, { exact: true }).waitFor();
  const text = await detail.innerText();
  assert.doesNotMatch(text, secretPatterns);
  assert.doesNotMatch(text, /free|no cost/i);
  observations.push({ id, sessionId, status, cost: value, surface: "per-call trace detail" });
}

try {
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, language: "en" }),
    { mode: 0o600 },
  );
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    mainEntry: fixture.mainEntry,
    env: fixture.env,
  });
  // Playwright has established its own debugger sockets. Deny all parent HTTP
  // before the first Core import, without adding any provider/CDP HTTP exception.
  Object.assign(
    process.env,
    Object.fromEntries(Object.entries(fixture.env).filter(([, value]) => value !== undefined)),
  );
  await import("./runtime-cost-gui-guard.mjs");
  let processes = await verifyActualProcesses();
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1440, height: 1050 });
  const viewOnly = win.getByRole("button", { name: /^(仅查看|View only)/ });
  if (
    await viewOnly.waitFor({ timeout: 3000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "en");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
  });
  const cryptoFlags = await app.evaluate(({ app }) => ({
    platform: process.platform,
    mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
    passwordStore: app.commandLine.getSwitchValue("password-store"),
  }));
  assert.equal(cryptoFlags.mockKeychain, false);
  assert.notEqual(cryptoFlags.passwordStore, "basic");

  stage = "seed with compiled public receipt and Session writers";
  const { UsageLedger, SessionManager } = await import("@cjhyy/code-shell-core");
  const sessionsDir = join(isolated.codeShellHome, "sessions");
  const sessions = new SessionManager(sessionsDir);
  const ledger = new UsageLedger({ storageDir: join(sessionsDir, ".usage-ledger") });
  const bundles = sessionIds.map((sid) =>
    sessions.create(isolated.home, "gpt-4o", "openai", sid, null, "desktop"),
  );
  const completed = ledger.owner(sessionIds[0], "gui-known-run", [], "main", sessionsDir);
  const interrupted = ledger.owner(sessionIds[1], "gui-failed-run", [], "main", sessionsDir);
  const known = (owner, identity, usage) => {
    const receipt = ledger.begin(owner, identity);
    ledger.settle(receipt, usage);
    ledger.finish(receipt, "completed");
    return receipt;
  };
  const knownReceipt = known(
    completed,
    { provider: "openai", model: "gpt-4o" },
    { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cacheReadTokens: 400 },
  );
  known(
    completed,
    { provider: "mistral", model: "mistral-large" },
    { promptTokens: 2000, completionTokens: 500, totalTokens: 2500, cacheCreationTokens: 100 },
  );
  const external = {
    provider: "openai",
    model: "gpt-4o-mini",
    source: "gui-synthetic-external",
    requestId: secretReceiptKey,
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  };
  assert.equal(ledger.recordExternalWithStatus(completed, external).recorded, true);
  assert.equal(ledger.recordExternalWithStatus(completed, external).recorded, false);
  const missingReceipt = ledger.begin(interrupted, { provider: "openai", model: "gpt-4o" });
  ledger.finish(missingReceipt, "failed");
  const cancelledOwner = ledger.owner(sessionIds[1], "gui-cancelled-run", [], "main", sessionsDir);
  const unknownReceipt = known(
    cancelledOwner,
    { provider: "gui-unknown-provider", model: "gui-unknown-model" },
    { promptTokens: 300, completionTokens: 50, totalTokens: 350 },
  );
  // Cancellation after handoff has no usage proof. The existing contract records
  // a failed unknown request; it has no fabricated "cancelled" receipt outcome.
  ledger.finish(
    ledger.begin(cancelledOwner, { provider: "anthropic", model: "claude-opus-4-6" }),
    "failed",
  );
  ledger.noteHistoricalGap(sessionIds[1], sessionsDir);
  for (const sid of sessionIds)
    sessions.updateSessionState(sid, {
      costState: ledger.sessionState(sid, sessionsDir),
      title: `Synthetic ${sid}`,
      status: "completed",
    });
  const appendRun = (bundle, clientMessageId, label, reason, usage) => {
    bundle.transcript.appendMessage("user", label, { clientMessageId });
    bundle.transcript.appendRunResult(clientMessageId, {
      sessionId: bundle.state.sessionId,
      reason,
      text: "Synthetic local GUI acceptance; no model/provider/account used.",
      turnCount: 1,
      usage,
    });
  };
  const expected = {
    store: ledger.summary({ scope: "store" }, sessionsDir),
    completed: ledger.summary(
      { scope: "session", sessionId: sessionIds[0], includeChildren: true },
      sessionsDir,
    ),
    interrupted: ledger.summary(
      { scope: "session", sessionId: sessionIds[1], includeChildren: true },
      sessionsDir,
    ),
  };
  appendRun(bundles[0], "gui-completed-message", labels.completed, "completed", {
    promptTokens: 4000,
    completionTokens: 1200,
    totalTokens: 5200,
  });
  appendRun(bundles[1], "gui-failed-message", labels.failed, "model_error", {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
  appendRun(bundles[1], "gui-cancelled-message", labels.cancelled, "aborted_streaming", {
    promptTokens: 300,
    completionTokens: 50,
    totalTokens: 350,
  });
  for (const sid of sessionIds) sessions.setSessionArchived(sid, Date.now());
  assert.equal(expected.store.requests, 6);
  assert.equal(expected.store.knownEstimatedCostUsd.toFixed(6), "0.011100");
  assert.equal(expected.store.unknownCostRequests, 3);
  assert.equal(expected.store.unknownUsageRequests, 2);
  assert.equal(expected.store.partial, false);
  assert.equal(expected.interrupted.partial, true);

  const cold = new UsageLedger({ storageDir: join(sessionsDir, ".usage-ledger") });
  assert.equal(
    cold.adoptSession(
      sessionIds[0],
      sessions.readSessionState(sessionIds[0]).costState,
      sessionsDir,
    ),
    true,
  );
  assert.equal(
    cold.recordExternalWithStatus(
      cold.owner(sessionIds[0], "gui-known-run", [], "main", sessionsDir),
      external,
    ).recorded,
    false,
  );
  const ipc = await win.evaluate(
    async (ids) => ({
      store: await window.codeshell.getUsageSummary({ scope: "store" }),
      completed: await window.codeshell.getUsageSummary({
        scope: "session",
        sessionId: ids[0],
        includeChildren: true,
      }),
      interrupted: await window.codeshell.getUsageSummary({
        scope: "session",
        sessionId: ids[1],
        includeChildren: true,
      }),
    }),
    sessionIds,
  );
  for (const key of Object.keys(expected))
    compareSummary(ipc[key], expected[key], `production IPC ${key}`);

  stage = "compiled trace writer → current per-call estimated cost UI";
  console.log(`COST stage: ${stage}`);
  const { ModelTraceStore } = await import("@cjhyy/code-shell-core/internal");
  const traces = new ModelTraceStore({ storageDir: join(sessionsDir, ".model-traces") });
  const traceCases = [
    {
      id: "cost-trace-known",
      sessionId: sessionIds[0],
      receipt: knownReceipt,
      status: "completed",
      label: labels.completed,
    },
    {
      id: "cost-trace-missing",
      sessionId: sessionIds[1],
      receipt: missingReceipt,
      status: "failed",
      label: labels.failed,
    },
    {
      id: "cost-trace-unknown",
      sessionId: sessionIds[1],
      receipt: unknownReceipt,
      status: "cancelled",
      label: labels.cancelled,
    },
  ];
  for (const item of traceCases) {
    const { receipt } = item;
    traces.write({
      version: 1,
      id: item.id,
      traceId: item.id + "-execution",
      sessionId: item.sessionId,
      runId: receipt.runId,
      workspacePath: isolated.home,
      source: "cost-gui-owned-fixture",
      purpose: "main",
      callType: "execution",
      provider: receipt.provider,
      model: receipt.model,
      startedAt: receipt.startedAt,
      endedAt: receipt.settledAt,
      status: item.status,
      stream: false,
      inputState: "recorded",
      input: { messages: [{ role: "user", content: item.label }] },
      outputState: "recorded",
      output: { text: "Owned synthetic trace cost acceptance" },
      usage: receipt.usage ?? undefined,
      estimatedCostUsd: receipt.estimatedCostUsd,
      pricing: receipt.pricing,
      unknownCostAttempts: receipt.estimatedCostUsd === null ? 1 : 0,
      attempts: [
        {
          id: item.id + "-attempt",
          number: 1,
          startedAt: receipt.startedAt,
          endedAt: receipt.settledAt,
          status: item.status,
          coverage: "logical-input",
          inputState: "not-recorded",
          outputState: "not-recorded",
          usage: receipt.usage ?? undefined,
          estimatedCostUsd: receipt.estimatedCostUsd,
          pricing: receipt.pricing,
        },
      ],
    });
  }
  await openTraces();
  for (const item of traceCases) {
    await selectTrace(
      item.id,
      item.sessionId,
      item.receipt.estimatedCostUsd,
      item.status === "completed" ? "Completed" : item.status === "failed" ? "Failed" : "Cancelled",
    );
    await screenshot(item.id + ".png");
  }
  await win.getByRole("button", { name: "Refresh traces", exact: true }).click();
  await selectTrace("cost-trace-known", sessionIds[0], knownReceipt.estimatedCostUsd, "Completed");
  await win.locator('[data-trace-attempt="cost-trace-known-attempt"]').focus();
  await win.keyboard.press("Space");
  const attempt = win.locator('[data-trace-detail-id="cost-trace-known-attempt"]');
  await attempt.getByRole("heading", { name: "Attempt 1", exact: true }).waitFor();
  await attempt
    .getByText(`~$${knownReceipt.estimatedCostUsd.toFixed(6)}`, { exact: true })
    .waitFor();
  observations.push({
    id: "cost-trace-known-attempt",
    surface: "physical attempt detail",
    cost: knownReceipt.estimatedCostUsd,
  });
  // Current product deliberately exposes per-call estimates. Cross-session totals
  // and the Session historical-gap flag remain a Host IPC contract, not a GUI.
  assert.equal(
    await win
      .getByRole("region", { name: "Recorded cross-session usage and cost estimates", exact: true })
      .count(),
    0,
  );
  const contract = {
    removed: "RunsView and its cross-session/session UsageSummary regions are no longer rendered",
    evidence: [
      "src/renderer/pages/PageRegistry.ts",
      "src/renderer/pages/PageRegistry.contract.test.ts",
      "src/renderer/activity/ModelTraceDetail.tsx",
    ],
    retained:
      "getUsageSummary production IPC, complete byModel grouping, deduplication, unknown usage/price and historical partial coverage",
    currentUi: "per-call and per-attempt estimated cost in Execution traces",
    missingUi: "No current cross-session aggregate or Session historical-gap cost summary UI",
  };

  stage = "real renderer reload does not replay or duplicate receipts";
  await win.reload();
  await openTraces();
  await selectTrace("cost-trace-known", sessionIds[0], knownReceipt.estimatedCostUsd, "Completed");
  const after = await win.evaluate(() => window.codeshell.getUsageSummary({ scope: "store" }));
  compareSummary(after, expected.store, "after renderer reload");

  stage = "real Electron cold restart preserves receipts and production IPC summaries";
  console.log(`COST stage: ${stage}`);
  const beforeRestart = await verifyActualProcesses();
  const electronVersion = await app.evaluate(() => process.versions.electron);
  await app.close();
  app = undefined;
  // Parent HTTP denial stays intact. A fresh isolated driver establishes its own
  // debugger sockets before installing the same guard; no CDP HTTP exception is added.
  const coldInput = join(evidenceDir, "cold-restart-input.json");
  await writeFile(
    coldInput,
    JSON.stringify({
      appDir,
      isolated,
      fixture: {
        mainEntry: fixture.mainEntry,
        env: Object.fromEntries(
          Object.entries(fixture.env).filter(([, value]) => value !== undefined),
        ),
      },
      expected,
      sessionIds,
      evidenceDir,
    }),
    { mode: 0o600 },
  );
  const coldProcess = spawn(
    process.execPath,
    [fileURLToPath(new URL("./runtime-cost-cold-restart.mjs", import.meta.url)), coldInput],
    {
      env: {
        ...environment,
        HOME: isolated.home,
        USERPROFILE: isolated.home,
        CODE_SHELL_HOME: isolated.codeShellHome,
        CODE_SHELL_TEST_HOME: isolated.codeShellHome,
      },
      stdio: "inherit",
    },
  );
  const coldExit = await new Promise((resolve, reject) => {
    coldProcess.once("error", reject);
    coldProcess.once("close", resolve);
  });
  assert.equal(coldExit, 0, "Fresh cold-restart driver must complete every IPC/UI assertion");
  const coldResult = JSON.parse(await readFile(join(evidenceDir, "cold-restart.json"), "utf8"));
  const coldIpc = coldResult.ipc;
  assert.notEqual(
    coldResult.mainPid,
    beforeRestart.mainPid,
    "Cold restart uses another native Electron main process",
  );
  const namespace = (await readdir(join(sessionsDir, ".usage-ledger")))[0];
  const receiptFiles = (await readdir(join(sessionsDir, ".usage-ledger", namespace))).filter(
    (name) => /^[a-f0-9]{64}\.json$/.test(name),
  );
  assert.equal(receiptFiles.length, 6);
  const raw = (
    await Promise.all(
      receiptFiles.map((name) =>
        readFile(join(sessionsDir, ".usage-ledger", namespace, name), "utf8"),
      ),
    )
  ).join("\n");
  assert.doesNotMatch(raw, /PRIVATE_SYNTHETIC|apiKey|authorization|rawPrompt/);
  processes = beforeRestart;
  assert.equal(rendererErrors.length, 0);
  assert.equal(coldResult.rendererErrors.length, 0);
  const evidence = {
    kind: "synthetic-compiled-ledger-production-ipc-cold-restart-current-trace-gui",
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    platform: process.platform,
    electron: electronVersion,
    cryptoFlags,
    processes,
    expected,
    ipc,
    after,
    coldIpc,
    beforeRestart,
    coldMainPid: coldResult.mainPid,
    coldProcesses: coldResult,
    contract,
    observations,
    receipts: receiptFiles.length,
    providerRequests: 0,
    modelRuns: 0,
    limitations: [
      "Synthesized request evidence; no provider invoice or paid model evaluated.",
      "GUI/keyring flags are not Phase D macOS signing/OS confinement evidence.",
      "Cold restart proves native Main + fresh driver guards and production IPC; no model worker was launched or evaluated.",
      "Partial is the real Session historical-gap flag; store receipt coverage remains complete.",
    ],
  };
  await writeFile(join(evidenceDir, "acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  succeeded = true;
  console.log(
    `PASS cost GUI: compiled ledger → production IPC → actual Electron cold restart; current per-call trace cost UI; 2 Sessions, 6 deduplicated receipts, known + unknown + partial; refresh/reload; private evidence: ${evidenceDir}`,
  );
} catch (error) {
  const keychainPreflight = getElectronKeychainPreflightDiagnostic(error);
  if (keychainPreflight) {
    console.error(JSON.stringify({ keychainPreflight }));
    process.exitCode = 1;
  } else {
    if (win) await screenshot("cost-history-failure.png").catch(() => {});
    console.error(`Cost GUI failed at ${stage}; private evidence retained: ${root}`);
    throw error;
  }
} finally {
  await app?.close();
  // Keep successful screenshots and receipt hashes for review; delete only the
  // fresh private fixture's user-data/cache, never another task's files.
  if (succeeded)
    await rm(isolated.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
}
