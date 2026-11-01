/* Mimi presence across real restarts of the production app in one isolated HOME.
 * Launch 1 seeds the legacy files (mimi-companion.json size 320 / enabled, and
 * pet-widget.json) and checks migration, then drives the independent entries:
 * account menu, the Mimi settings page (mode, size, preview), the computer-use
 * page link, the moving character's own menu and the legacy IPC aliases.
 * Launch 2 must restore visible/mode/size/positions; launch 3 must stay hidden.
 * A main-process sampler checks every 5 ms that both forms are never visible.
 * No model is called. This is BrowserWindow state, not compositor or native input.
 * Build Desktop first, then run through the isolated runner:
 * node scripts/run-isolated-node-smoke.mjs --private-keyring packages/desktop/scripts/e2e-mimi-presence-restart.mjs
 */
/* global window */
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  assertOfflinePluginBootstrapHeld,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
  openSettingsMenu,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";

assert.equal(process.platform, "darwin", "Moving Mimi requires macOS");
assert.equal(
  process.env.CODE_SHELL_TEST_HOME,
  join(process.env.HOME, ".code-shell"),
  "Use scripts/run-isolated-node-smoke.mjs so the fixture never inherits provider credentials",
);
const args = process.argv.slice(2);
let receiptArg;
for (let index = 0; index < args.length; index++) {
  assert.equal(args[index], "--receipt", `Unknown option ${args[index]}`);
  receiptArg = args[++index];
  assert.ok(receiptArg && !receiptArg.startsWith("--"), "Missing value for --receipt");
}
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [
  "out/main/index.mjs",
  "out/preload/mimi-companion.cjs",
  "out/renderer/mimi-companion.html",
])
  await access(join(appDir, file)).catch(() => {
    throw Error(`Missing ${file}; build the workspace and Desktop before this acceptance run`);
  });

const isolated = await makeIsolatedElectronHome("codeshell-mimi-restart-");
const receiptPath = receiptArg
  ? resolve(receiptArg)
  : join(appDir, "out", `mimi-presence-restart-${Date.now()}.json`);
const legacyCompanionPath = join(isolated.userDataDir, "mimi-companion.json");
const legacyWidgetPath = join(isolated.codeShellHome, "desktop", "pet-widget.json");
const statePath = join(isolated.codeShellHome, "desktop", "mimi-presence.json");
const receipt = {
  schemaVersion: 1,
  boundary:
    "Production app restarted three times in one isolated HOME; BrowserWindow.isVisible() sampling, real renderer DOM clicks and IPC. Not compositor frames, native pointer hit testing or CUA capture.",
  home: isolated.home,
  passed: false,
  launches: [],
  checks: [],
};
const rendererErrors = [];
let model;
let current;
const put = async (path, text) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(probe, label, ms = 15_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(100);
  }
  throw Error(`${label} (last: ${JSON.stringify(last)})`);
}

async function launch(label, fixture) {
  let monitor;
  const app = await launchCodeShellElectron(
    {
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: fixture.mainEntry,
      env: fixture.env,
      runtimeTimeoutMs: 180_000,
    },
    { watch: (child, settings) => (monitor = watchElectronTestProcess(child, settings)) },
  );
  await findCodeShellWindow(app);
  const main = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(main, "Production workbench window not found");
  rendererErrors.push(captureRendererErrors(main));
  await main.waitForFunction(() => !!window.codeshell?.pet?.getPresence);
  const trust = main.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust.waitFor({ state: "visible", timeout: 4_000 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
  // Sample from the first moment after the window exists: startup must not flash both.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__mimi = { samples: 0, violations: [], seen: { docked: 0, moving: 0 } };
    globalThis.__mimiSampler = setInterval(() => {
      const kinds = BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed() && win.isVisible())
        .map((win) => win.webContents.getURL())
        .map((url) =>
          url.includes("popout=pet")
            ? "docked"
            : url.endsWith("/mimi-companion.html")
              ? "moving"
              : "",
        )
        .filter(Boolean);
      globalThis.__mimi.samples++;
      for (const kind of kinds) globalThis.__mimi.seen[kind]++;
      if (kinds.length > 1) globalThis.__mimi.violations.push(kinds);
    }, 5);
  });
  current = { label, app, main, monitor };
  return current;
}

/** Which Mimi windows are visible right now, from the main process. */
const visibleForms = (app) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && win.isVisible())
      .map((win) => ({ url: win.webContents.getURL(), bounds: win.getBounds() }))
      .filter(({ url }) => url.includes("popout=pet") || url.endsWith("/mimi-companion.html"))
      .map(({ url, bounds }) => ({
        form: url.includes("popout=pet") ? "docked" : "moving",
        bounds,
      })),
  );
const presence = (main) => main.evaluate(() => window.codeshell.pet.getPresence());
async function settled(run, expected) {
  return until(async () => {
    const snapshot = await presence(run.main);
    const forms = await visibleForms(run.app);
    const ok =
      snapshot.shown === expected &&
      forms.length === (expected ? 1 : 0) &&
      (!expected || forms[0].form === expected);
    return ok ? { snapshot, forms } : false;
  }, `Mimi did not settle on ${expected}`);
}
async function companionPage(app) {
  return until(
    () =>
      app.windows().find((page) => new URL(page.url()).pathname.endsWith("/mimi-companion.html")),
    "Companion renderer not found",
  );
}

async function close(run) {
  const stats = await run.app.evaluate(() => {
    clearInterval(globalThis.__mimiSampler);
    return globalThis.__mimi;
  });
  await run.app.close();
  const settlement = await run.monitor?.completed;
  receipt.launches.push({ label: run.label, ...stats, cleanup: settlement?.status });
  assert.ok(stats.samples > 0, `${run.label}: sampler never ran`);
  assert.deepEqual(stats.violations, [], `${run.label}: both Mimi forms were visible together`);
  assert.equal(settlement?.status, "cleaned", `${run.label}: owned app did not exit cleanly`);
  current = undefined;
  return stats;
}

try {
  model = await startMockProviderServer();
  const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: model.origin });
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  await put(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: false } }),
  );
  // Legacy layout: companion enabled at the old default 320 with a pinned
  // position, and a docked widget position. These files must stay byte-identical.
  const legacyCompanion = JSON.stringify({ enabled: true, size: 320, anchor: { x: 240, y: 220 } });
  const legacyWidget = `${JSON.stringify({ x: 520, y: 420 }, null, 2)}\n`;
  await put(legacyCompanionPath, legacyCompanion);
  await put(legacyWidgetPath, legacyWidget);

  // ---------------- Launch 1: migration and every independent entry ----------
  let run = await launch("first launch (legacy migration)", fixture);
  const display = await run.app.evaluate(({ screen }) => {
    const primary = screen.getPrimaryDisplay();
    return {
      count: screen.getAllDisplays().length,
      bounds: primary.bounds,
      workArea: primary.workArea,
      scaleFactor: primary.scaleFactor,
    };
  });
  receipt.display = display;
  let { snapshot } = await settled(run, "moving");
  assert.equal(snapshot.visible, true);
  assert.equal(snapshot.mode, "moving");
  assert.equal(snapshot.size, 200, "Legacy 320 (old default) migrates to 200");
  assert.equal(snapshot.movingAvailable, true);
  const migrated = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(
    { visible: migrated.visible, mode: migrated.mode, size: migrated.size },
    { visible: true, mode: "moving", size: 200 },
  );
  assert.deepEqual(migrated.movingAnchor, { x: 240, y: 220 });
  assert.deepEqual(migrated.dockedAnchor, { x: 520, y: 420 });
  assert.equal(await readFile(legacyCompanionPath, "utf8"), legacyCompanion);
  assert.equal(await readFile(legacyWidgetPath, "utf8"), legacyWidget);
  let overlay = await companionPage(run.app);
  rendererErrors.push(captureRendererErrors(overlay));
  const migratedState = await overlay.evaluate(() => window.mimiCompanion.getState());
  assert.equal(migratedState.size, 200);
  assert.equal(migratedState.windowOrigin.x + migratedState.position.x, 240);
  assert.equal(migratedState.windowOrigin.y + migratedState.position.y, 220);
  receipt.checks.push(
    "legacy enabled+320 → visible moving at 200 with the pinned position; legacy files byte-identical",
  );

  // Entry: the moving character's own context menu (real renderer DOM).
  const body = overlay.getByRole("button", { name: "打开 Mimi 聊天，拖动可移动" });
  await body.waitFor({ state: "visible" });
  await body.click({ button: "right" });
  await overlay.getByRole("menuitem", { name: "切换到停靠模式" }).click();
  ({ snapshot } = await settled(run, "docked"));
  assert.equal(snapshot.mode, "docked");
  receipt.checks.push("moving character menu → docked; moving withdrawn first");

  // Entry: account menu toggle (hide, then show again in the remembered mode).
  let menu = await openSettingsMenu(run.main);
  await menu.getByRole("menuitem", { name: "隐藏 Mimi" }).click();
  await menu.waitFor({ state: "hidden" });
  await settled(run, null);
  menu = await openSettingsMenu(run.main);
  await menu.getByRole("menuitem", { name: "显示 Mimi" }).click();
  await menu.waitFor({ state: "hidden" });
  await settled(run, "docked");
  receipt.checks.push("account menu hides and re-shows the same single Mimi");

  // Entry: computer-use settings has no second switch; its link opens Mimi settings.
  await navigateSettingsMenu(run.main, /^(设置|Settings)$/);
  await run.main.locator('[data-settings-module="computer-use"]').first().click();
  const link = run.main.locator("[data-open-mimi-settings]");
  await link.waitFor({ state: "visible" });
  const panel = run.main.locator("[data-mimi-companion-settings]");
  assert.equal(await panel.getByRole("switch").count(), 0, "No second Mimi switch remains");
  await link.click();
  const controls = run.main.locator("[data-mimi-presence-controls]");
  await controls.waitFor({ state: "visible" });
  receipt.checks.push("computer-use page links to the single Mimi setting (no second switch)");

  // Entry: Mimi settings page — mode buttons and size select.
  await controls.locator('[data-mimi-mode="moving"]').click();
  ({ snapshot } = await settled(run, "moving"));
  await controls.getByRole("combobox").click();
  await run.main.getByRole("option", { name: /^240/ }).click();
  await until(async () => (await presence(run.main)).size === 240, "Size did not change to 240");
  overlay = await companionPage(run.app);
  await until(
    async () => (await overlay.evaluate(() => window.mimiCompanion.getState())).size === 240,
    "Companion did not redraw at 240",
  );
  await controls.locator('[data-mimi-mode="docked"]').click();
  await settled(run, "docked");
  receipt.checks.push("Mimi settings page switches docked↔moving and resizes the moving form");

  // Entry: preview from docked replaces docked; closing during preview cancels it.
  await controls.locator("[data-mimi-preview]").click();
  await settled(run, "moving");
  assert.equal((await presence(run.main)).previewing, true);
  await run.main.getByRole("switch", { name: "显示 Mimi" }).click();
  await settled(run, null);
  await sleep(11_000); // past the preview's own 10 s expiry: it must not re-show anything
  assert.deepEqual(await visibleForms(run.app), []);
  assert.equal((await presence(run.main)).previewing, false);
  receipt.checks.push(
    "preview replaces docked; closing during preview cancels it; expiry stays hidden",
  );

  // Entry: legacy IPC aliases map onto the same owner.
  await run.main.evaluate(() => window.codeshell.computerUse.setCompanion({ enabled: true }));
  await settled(run, "moving");
  await run.main.evaluate(() => window.codeshell.pet.setWidgetVisible(false));
  await settled(run, null);
  await run.main.evaluate(() => window.codeshell.pet.setWidgetVisible(true));
  await settled(run, "moving");
  receipt.checks.push("legacy computerUse:setCompanion and pet:widget-visible use the same owner");

  // Interleaved requests from several entries at once.
  await run.main.evaluate(async () => {
    const pet = window.codeshell.pet;
    await Promise.all([
      pet.setPresence({ mode: "docked" }),
      window.codeshell.computerUse.setCompanion({ enabled: true }),
      pet.setWidgetVisible(false),
      pet.setPresence({ visible: true, mode: "moving" }),
    ]);
  });
  await settled(run, "moving");

  // Final state to restore: moving, 240, dragged to a known position.
  overlay = await companionPage(run.app);
  const pinned = {
    x: Math.round(display.workArea.x + display.workArea.width * 0.6),
    y: Math.round(display.workArea.y + display.workArea.height * 0.35),
  };
  await overlay.evaluate((point) => {
    window.mimiCompanion.interaction("begin");
    window.mimiCompanion.move(point);
    window.mimiCompanion.interaction("end");
    window.mimiCompanion.interaction("leave");
  }, pinned);
  await until(async () => {
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    return saved.movingAnchor?.x === pinned.x && saved.movingAnchor?.y === pinned.y && saved;
  }, "Dragged position was not persisted");
  receipt.firstLaunch = await close(run);

  // ---------------- Launch 2: cold restart restores everything ---------------
  run = await launch("second launch (restore moving)", fixture);
  ({ snapshot } = await settled(run, "moving"));
  assert.deepEqual(
    { visible: snapshot.visible, mode: snapshot.mode, size: snapshot.size },
    { visible: true, mode: "moving", size: 240 },
  );
  overlay = await companionPage(run.app);
  const restored = await overlay.evaluate(() => window.mimiCompanion.getState());
  assert.equal(restored.size, 240);
  assert.equal(restored.windowOrigin.x + restored.position.x, pinned.x);
  assert.equal(restored.windowOrigin.y + restored.position.y, pinned.y);
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(saved.dockedAnchor, "Docked position is kept while moving");
  // Docked position survives too: switch and compare with the saved anchor.
  await run.main.evaluate(() => window.codeshell.pet.setPresence({ mode: "docked" }));
  const { forms } = await settled(run, "docked");
  const dockedAnchor = JSON.parse(await readFile(statePath, "utf8")).dockedAnchor;
  assert.ok(
    Math.abs(forms[0].bounds.x - dockedAnchor.x) <= 1 &&
      Math.abs(forms[0].bounds.y - dockedAnchor.y) <= 1,
    `Docked window ${JSON.stringify(forms[0].bounds)} not at saved ${JSON.stringify(dockedAnchor)}`,
  );
  await run.main.evaluate(() => window.codeshell.pet.setPresence({ visible: false }));
  await settled(run, null);
  assert.equal(await readFile(legacyCompanionPath, "utf8"), legacyCompanion);
  receipt.checks.push(
    "cold restart restores visible/moving/240/dragged position; docked position preserved",
  );
  receipt.secondLaunch = await close(run);

  // ---------------- Launch 3: closed stays closed ----------------------------
  run = await launch("third launch (stays hidden)", fixture);
  await run.main.waitForFunction(async () => {
    const snapshot = await window.codeshell.pet.getPresence();
    return snapshot.movingAvailable && !snapshot.movingUnavailableReason;
  });
  await sleep(2_500);
  ({ snapshot } = await settled(run, null));
  assert.equal(snapshot.visible, false);
  assert.equal(snapshot.mode, "docked");
  receipt.thirdLaunch = await close(run);
  assert.equal(receipt.thirdLaunch.seen.docked + receipt.thirdLaunch.seen.moving, 0);
  receipt.checks.push("closed Mimi stays hidden after restart (no startup flash)");
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = String(error?.stack ?? error);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (current) {
    await current.app.close().catch(() => current.monitor?.terminate());
    await current.monitor?.completed;
  }
  receipt.rendererErrors = rendererErrors.flat().map((error) => error.message);
  if (receipt.rendererErrors.length) {
    receipt.passed = false;
    process.exitCode = 1;
  }
  await model?.close();
  await assertOfflinePluginBootstrapHeld(isolated.codeShellHome).catch((error) => {
    receipt.passed = false;
    receipt.bootstrapError = String(error);
    process.exitCode = 1;
  });
  const cleaned = receipt.launches.every((item) => item.cleanup === "cleaned");
  if (cleaned) {
    await isolated.cleanup();
    receipt.homeRemoved = true;
  } else receipt.homeRemoved = false;
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      phase: "mimi-presence-restart-finished",
      passed: receipt.passed,
      receipt: receiptPath,
    }),
  );
}
