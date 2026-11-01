/* Packaged-app check for the single Mimi presence, in a private HOME.
 * Uses the packaged inspector fixture (first-instruction Main guard, private
 * HOME, before/after app inventory). No worker, no model, no credentials.
 * node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/e2e-mimi-presence-packaged.mjs
 *   --packaged-app /owned/code-shell.app --default-keychain-reference /owned/reference.json
 *   --evidence-dir /owned/new-evidence */
/* global window */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { preparePackagedPetFixture } from "./packaged-pet-fixture.mjs";
import { settlePackagedPet } from "./packaged-pet-shutdown.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import {
  captureRendererErrors,
  findCodeShellWindow,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import {
  bindPrivateKeychainContext,
  readDefaultKeychain,
  readKeychainReference,
} from "./macos-keychain-context.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "run-isolated-node-smoke.mjs is required");
assert.equal(process.platform, "darwin", "Moving Mimi is macOS-only");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(
    value &&
      ["--packaged-app", "--default-keychain-reference", "--evidence-dir"].includes(flag) &&
      !options.has(flag),
    "Expected --packaged-app <app>, --default-keychain-reference <metadata>, --evidence-dir <new-directory>",
  );
  options.set(flag, resolve(value));
}
for (const flag of ["--packaged-app", "--default-keychain-reference", "--evidence-dir"])
  assert.ok(options.has(flag), `${flag} is required`);
const evidence = options.get("--evidence-dir");
await mkdir(evidence, { mode: 0o700 });
const isolated = await makeIsolatedElectronHome("codeshell-packaged-mimi-");
const fixtureRoot = await realpath(isolated.home);
isolated.home = join(fixtureRoot, "home");
await mkdir(isolated.home, { mode: 0o700 });
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const failures = [];
const checks = [];
const rendererErrors = [];
let fixture, model, app, win, keychainReference, keychainContext, identity, sampling;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(probe, label, ms = 20_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(100);
  }
  throw Error(`${label} (last: ${JSON.stringify(last)})`);
}
const forms = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((item) => !item.isDestroyed() && item.isVisible())
      .map((item) => item.webContents.getURL())
      .map((url) =>
        url.includes("popout=pet")
          ? "docked"
          : url.endsWith("/mimi-companion.html")
            ? "moving"
            : "",
      )
      .filter(Boolean),
  );
async function settled(expected) {
  return until(async () => {
    const snapshot = await win.evaluate(() => window.codeshell.pet.getPresence());
    const visible = await forms();
    return snapshot.shown === expected &&
      visible.length === (expected ? 1 : 0) &&
      (!expected || visible[0] === expected)
      ? snapshot
      : false;
  }, `Packaged Mimi did not settle on ${expected}`);
}
async function rows(name) {
  return (
    await readFile(join(isolated.home, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}
async function closeApp() {
  if (!app) return;
  const child = app.process();
  await Promise.race([app.close(), sleep(5_000)]).catch(() => {});
  if (child.exitCode === null && child.signalCode === null) await fixture.terminateChild(child);
  if (child.exitCode !== 0 || child.signalCode !== null)
    throw Error("Packaged Main did not exit normally");
  app = undefined;
}

try {
  keychainReference = readKeychainReference(options.get("--default-keychain-reference"));
  keychainContext = bindPrivateKeychainContext({
    home: isolated.home,
    root: fixtureRoot,
    reference: keychainReference,
    receiptFile: join(fixtureRoot, "keychain-context.json"),
  });
  await mkdir(isolated.codeShellHome, { mode: 0o700, recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: false } }),
    { mode: 0o600 },
  );
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  model = await startMockProviderServer();
  fixture = await preparePackagedPetFixture({
    officialApp: options.get("--packaged-app"),
    isolated,
    origin: model.origin,
    fixtureRoot,
    keychainReferenceFile: options.get("--default-keychain-reference"),
    requireWorkerEvidence: false,
  });
  app = await fixture.launch();
  identity = { ...app.__packagedIdentity };
  await findCodeShellWindow(app);
  win = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(win, "Packaged workbench not found");
  rendererErrors.push(captureRendererErrors(win));
  win.setDefaultTimeout(15_000);
  await win.locator("#root").waitFor();
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 3_000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__mimi = { samples: 0, violations: [] };
    globalThis.__mimiSampler = setInterval(() => {
      const kinds = BrowserWindow.getAllWindows()
        .filter((item) => !item.isDestroyed() && item.isVisible())
        .map((item) => item.webContents.getURL())
        .filter((url) => url.includes("popout=pet") || url.endsWith("/mimi-companion.html"));
      globalThis.__mimi.samples++;
      if (kinds.length > 1) globalThis.__mimi.violations.push(kinds.length);
    }, 5);
  });
  const initial = await until(async () => {
    const snapshot = await win.evaluate(() => window.codeshell.pet.getPresence());
    return snapshot.movingAvailable ? snapshot : false;
  }, "Moving mode never became available in the package");
  assert.equal(initial.visible, false, "A new profile starts with Mimi hidden");
  assert.equal(initial.size, 200, "Packaged default moving size is 200 DIP");
  checks.push("packaged: new profile hidden, default moving size 200, moving available");

  await win.evaluate(() => window.codeshell.pet.setPresence({ visible: true, mode: "docked" }));
  await settled("docked");
  await win.evaluate(() => window.codeshell.pet.setPresence({ mode: "moving" }));
  await settled("moving");
  const overlay = await until(
    () =>
      app.windows().find((page) => new URL(page.url()).pathname.endsWith("/mimi-companion.html")),
    "Packaged companion renderer not found",
  );
  rendererErrors.push(captureRendererErrors(overlay));
  assert.equal((await overlay.evaluate(() => window.mimiCompanion.getState())).size, 200);
  await win.evaluate(async () => {
    const pet = window.codeshell.pet;
    await Promise.all([
      pet.setPresence({ mode: "docked" }),
      pet.setWidgetVisible(false),
      window.codeshell.computerUse.setCompanion({ enabled: true }),
      pet.setPresence({ visible: true, mode: "docked" }),
    ]);
  });
  await settled("docked");
  checks.push("packaged: docked and moving switch with exactly one visible form");

  await navigateSettingsMenu(win, /^(设置|Settings)$/);
  await win.locator('[data-settings-module="computer-use"]').first().click();
  const link = win.locator("[data-open-mimi-settings]");
  await link.waitFor({ state: "visible" });
  assert.equal(
    await win.locator("[data-mimi-companion-settings]").getByRole("switch").count(),
    0,
    "No second Mimi switch in computer-use settings",
  );
  await link.click();
  await win.locator("[data-mimi-presence-controls]").waitFor({ state: "visible" });
  await win.getByRole("switch", { name: "显示 Mimi" }).click();
  await settled(null);
  checks.push("packaged: computer-use links to the single Mimi setting; its switch hides Mimi");

  sampling = await app.evaluate(() => {
    clearInterval(globalThis.__mimiSampler);
    return globalThis.__mimi;
  });
  assert.ok(sampling.samples > 0);
  assert.deepEqual(sampling.violations, [], "Both packaged Mimi forms were visible together");
  assert.equal(model.requests.length, 0, "No model request expected");
} catch (error) {
  failures.push(error);
}
const result = await settlePackagedPet({
  failures,
  closeApp: async () => {
    await closeApp();
    assert.equal(rendererErrors.flat().length, 0, "Packaged Mimi emitted a renderer error");
  },
  closeModel: async () => {
    await model?.close();
  },
  verifyUnchanged: async () => (fixture ? fixture.verifyUnchanged() : undefined),
  readNativeCalls: async () => rows("native-storage.jsonl"),
  canCleanup: async () => (fixture ? fixture.canCleanup() : true),
  cleanup: () => isolated.cleanup(),
  retainedHome: isolated.home,
});
if (keychainReference) {
  try {
    const after = readDefaultKeychain(keychainReference.home);
    for (const key of ["path", "dev", "ino", "uid"])
      assert.equal(after[key], keychainReference[key], "OS default Keychain metadata changed");
  } catch (error) {
    result.errors.push(error);
  }
}
const receipt = {
  fixture: "packaged-mimi-presence",
  status: result.errors.length ? "failed" : "passed",
  suppliedApp: options.get("--packaged-app"),
  boundary:
    "Packaged Main/preload/renderer with a private HOME; BrowserWindow state and IPC only; not native input, compositor capture or the operator's installed profile",
  identity,
  checks,
  sampling,
  artifacts: result.artifacts,
  nativeCalls: result.nativeCalls,
  rendererErrors: rendererErrors.flat().map(String),
  keychainContext,
  privateHomeRemoved: result.privateHomeRemoved,
  errors: result.errors.map((error) => String(error?.stack ?? error)),
};
await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify({ status: receipt.status, evidence, checks: checks.length }));
if (result.errors.length) throw new AggregateError(result.errors, "Packaged Mimi check failed");
