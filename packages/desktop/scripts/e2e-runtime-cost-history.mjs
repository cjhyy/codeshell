/* Compiled Core writers → production Main IPC → existing activity UI. No model requests. */
/* global localStorage, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

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
async function expectUsage(region, expected, { partial = expected.partial } = {}) {
  await region.waitFor();
  await region
    .getByText(
      `Known estimate ~$${expected.knownEstimatedCostUsd.toFixed(6)} + ${expected.unknownCostRequests} unknown costs`,
      { exact: true },
    )
    .waitFor();
  await region
    .getByText(
      `${expected.requests} physical requests · ${expected.unknownUsageRequests} missing usage`,
      { exact: true },
    )
    .waitFor();
  assert.equal(await region.getByRole("status").count(), partial ? 1 : 0);
  for (const model of expected.byModel)
    await region
      .getByText(
        `${model.provider}/${model.model} · ${model.requests} · ~$${model.knownEstimatedCostUsd.toFixed(6)} · ${model.unknownCostRequests} unknown costs`,
        { exact: true },
      )
      .waitFor();
  const text = await region.innerText();
  assert.doesNotMatch(text, secretPatterns);
  assert.doesNotMatch(text, /free|no cost/i);
}
async function selectRun(label, expected, status) {
  await win
    .getByRole("region", { name: "Run list", exact: true })
    .getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
    .click();
  const detail = win.getByRole("region", { name: "Run details", exact: true });
  await detail.getByRole("heading", { name: label, exact: true }).waitFor();
  await detail.getByText(status, { exact: true }).waitFor();
  const usage = detail.getByRole("region", {
    name: "Session usage (including children)",
    exact: true,
  });
  await expectUsage(usage, expected);
  observations.push({ label, status, usage: await usage.innerText() });
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
  known(
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
  ledger.finish(ledger.begin(interrupted, { provider: "openai", model: "gpt-4o" }), "failed");
  const cancelledOwner = ledger.owner(sessionIds[1], "gui-cancelled-run", [], "main", sessionsDir);
  known(
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

  stage = "existing Settings → Activity → Runs GUI";
  await navigateSettingsMenu(win, "Run history", { activity: true });
  await win.getByRole("heading", { name: "Run history", level: 1, exact: true }).waitFor();
  const storeView = win.getByRole("region", {
    name: "Recorded cross-session usage and cost estimates",
    exact: true,
  });
  await expectUsage(storeView, expected.store);
  await selectRun(labels.completed, expected.completed, "Completed");
  await screenshot("cost-history-known-and-unknown.png");
  await selectRun(labels.failed, expected.interrupted, "Failed");
  await screenshot("cost-history-failed-partial.png");
  await selectRun(labels.cancelled, expected.interrupted, "Cancelled");
  await screenshot("cost-history-cancelled-partial.png");
  await win.getByRole("button", { name: "Refresh", exact: true }).click();
  await expectUsage(storeView, expected.store);
  await expectUsage(
    win.getByRole("region", { name: "Session usage (including children)", exact: true }),
    expected.interrupted,
  );

  stage = "real renderer reload does not replay or duplicate receipts";
  await win.reload();
  await navigateSettingsMenu(win, "Run history", { activity: true });
  await expectUsage(storeView, expected.store);
  await selectRun(labels.completed, expected.completed, "Completed");
  const after = await win.evaluate(() => window.codeshell.getUsageSummary({ scope: "store" }));
  compareSummary(after, expected.store, "after renderer reload");
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
  processes = await verifyActualProcesses();
  assert.equal(rendererErrors.length, 0);
  const evidence = {
    kind: "synthetic-compiled-ledger-production-ipc-gui",
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    platform: process.platform,
    electron: await app.evaluate(() => process.versions.electron),
    cryptoFlags,
    processes,
    expected,
    ipc,
    after,
    observations,
    receipts: receiptFiles.length,
    providerRequests: 0,
    modelRuns: 0,
    limitations: [
      "Synthesized request evidence; no provider invoice or paid model evaluated.",
      "GUI/keyring flags are not Phase D macOS signing/OS confinement evidence.",
      "Partial is the real Session historical-gap flag; store receipt coverage remains complete.",
    ],
  };
  await writeFile(join(evidenceDir, "acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  succeeded = true;
  console.log(
    `PASS cost GUI: compiled receipts → production IPC → Settings/Activity/Runs; 2 Sessions, 6 deduplicated requests, known + unknown + partial, completed/failed/cancelled, refresh/reload; private evidence: ${evidenceDir}`,
  );
} catch (error) {
  if (win) await screenshot("cost-history-failure.png").catch(() => {});
  console.error(`Cost GUI failed at ${stage}; private evidence retained: ${root}`);
  throw error;
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
