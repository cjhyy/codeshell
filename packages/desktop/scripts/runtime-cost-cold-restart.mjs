/** Fresh Playwright driver: connect first, then install the same deny-all Core guard. */
/* global window */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getElectronKeychainPreflightDiagnostic } from "./electron-keychain-preflight.mjs";
import {
  launchCodeShellElectron,
  findCodeShellWindow,
  captureRendererErrors,
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const { appDir, isolated, fixture, expected, sessionIds, evidenceDir } = input;
let app;
try {
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    mainEntry: fixture.mainEntry,
    env: fixture.env,
  });
  Object.assign(process.env, fixture.env);
  await import("./runtime-cost-gui-guard.mjs");
  const win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  const cryptoFlags = await app.evaluate(({ app }) => ({
    mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
    passwordStore: app.commandLine.getSwitchValue("password-store"),
  }));
  assert.equal(cryptoFlags.mockKeychain, false);
  assert.notEqual(cryptoFlags.passwordStore, "basic");
  await win.setViewportSize({ width: 1440, height: 1050 });
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
  for (const [label, actual] of Object.entries(ipc)) {
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
      assert.equal(actual[key], expected[label][key], `cold restart ${label}: ${key}`);
    assert.equal(
      actual.knownEstimatedCostUsd.toFixed(6),
      expected[label].knownEstimatedCostUsd.toFixed(6),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(actual.byModel)), expected[label].byModel);
    assert.doesNotMatch(
      JSON.stringify(actual),
      /PRIVATE_SYNTHETIC|requestId|apiKey|authorization|rawPrompt/,
    );
    assert.ok(
      !JSON.stringify(actual).includes(isolated.home),
      "Cold IPC summaries exclude storage paths",
    );
  }
  await navigateSettingsMenu(win, "Execution traces", { activity: true });
  const page = win.locator("[data-model-traces-page]");
  await page.locator(`[data-trace-session="session:${sessionIds[1]}"]`).click();
  await page.locator('[data-trace-request="cost-trace-unknown"]').focus();
  await win.keyboard.press("Enter");
  const detail = page.locator('[data-trace-detail-id="cost-trace-unknown"]');
  await detail.getByText("Cancelled", { exact: true }).waitFor();
  await detail.getByText("Cost not recorded", { exact: true }).waitFor();
  await win.screenshot({
    path: join(evidenceDir, "cost-after-electron-cold-restart.png"),
    animations: "disabled",
  });
  const receipts = (await readFile(fixture.env.CODESHELL_COST_GUI_GUARD_LOG, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const mainPid = app.process().pid;
  assert(
    receipts.some((r) => r.pid === mainPid && r.ppid === process.pid && r.negativeProbes === 7),
  );
  assert(receipts.some((r) => r.pid === process.pid && r.negativeProbes === 7));
  assert.equal(errors.length, 0);
  await writeFile(
    join(evidenceDir, "cold-restart.json"),
    JSON.stringify(
      {
        ipc,
        cryptoFlags,
        mainPid,
        parentPid: process.pid,
        electron: await app.evaluate(() => process.versions.electron),
        receipts,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: actual Electron cold restart → production usage IPC + current unknown trace cost UI",
  );
} catch (error) {
  const keychainPreflight = getElectronKeychainPreflightDiagnostic(error);
  if (!keychainPreflight) throw error;
  console.error(JSON.stringify({ keychainPreflight }));
  process.exitCode = 1;
} finally {
  await app?.close();
}
