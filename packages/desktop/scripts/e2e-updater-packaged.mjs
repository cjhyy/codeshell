/* Actual immutable packaged Main/preload/Settings and installed electron-updater.
 * Only the generic update feed is an owned loopback server. No updater, IPC,
 * app.isPackaged, timers or UI state are substituted. Never downloads/installs. */
/* global window */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { preparePackagedPetFixture } from "./packaged-pet-fixture.mjs";
import { inventoryAppTree } from "./packaged-app-integrity.mjs";
import { settlePackagedPet } from "./packaged-pet-shutdown.mjs";
import {
  findCodeShellWindow,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";
import {
  bindPrivateKeychainContext,
  readDefaultKeychain,
  readKeychainReference,
} from "./macos-keychain-context.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Use run-isolated-node-smoke.mjs");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index],
    value = process.argv[index + 1];
  assert.ok(
    ["--packaged-app", "--evidence-dir", "--default-keychain-reference"].includes(flag) &&
      value &&
      !options.has(flag),
    "Expected packaged app, fresh evidence directory and macOS metadata reference",
  );
  options.set(flag, resolve(value));
}
for (const key of ["--packaged-app", "--evidence-dir"])
  assert.ok(options.has(key), `${key} required`);
if (process.platform === "darwin") assert.ok(options.has("--default-keychain-reference"));
const packagedApp = await realpath(options.get("--packaged-app"));
const requested = options.get("--evidence-dir");
const evidence = join(await realpath(resolve(requested, "..")), basename(requested));
const part = relative(packagedApp, evidence);
assert.ok(
  part && (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)),
  "Evidence must be outside package",
);
await mkdir(evidence, { mode: 0o700 });
const isolated = await makeIsolatedElectronHome("codeshell-packaged-updater-");
const fixtureRoot = await realpath(isolated.home);
isolated.home = join(fixtureRoot, "home");
await mkdir(isolated.home, { mode: 0o700 });
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const operations = [],
  requests = [],
  errors = [],
  pending = [];
let fixture,
  app,
  win,
  keychainReference,
  keychainContext,
  processEvidence,
  nativeCalls,
  explicitCheckDeadline,
  closeFailed = false,
  mode = "404";
const failures = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://owned.invalid");
  requests.push({
    path: url.pathname,
    query: url.search,
    method: request.method,
    mode,
    at: Date.now(),
  });
  if (request.method !== "GET" || !/^\/latest(?:-[a-z0-9_-]+)?\.yml$/i.test(url.pathname)) {
    errors.push("Unexpected update-feed request: " + request.method + " " + url.pathname);
    response.writeHead(403).end();
    return;
  }
  pending.push({ response, mode });
});
const put = (name, value) =>
  writeFile(join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 });
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
async function until(check, label, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let timer;
    const result = await Promise.race([
      Promise.resolve().then(check),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function closeApp() {
  if (!app) return;
  const current = app,
    child = current.process();
  let timer;
  const closeErrors = [];
  try {
    await Promise.race([
      current.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned packaged updater close timed out")),
          5_000,
        );
      }),
    ]);
  } catch (error) {
    closeErrors.push(error);
  } finally {
    clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await fixture.terminateChild(child);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (child.exitCode === null && child.signalCode === null)
    closeErrors.push(new Error("Owned packaged updater exit unproven"));
  else {
    app = undefined;
    if (child.exitCode !== 0 || child.signalCode !== null)
      closeErrors.push(
        new Error("Packaged updater Main must exit normally with code 0 and no signal"),
      );
  }
  if (closeErrors.length) {
    closeFailed = true;
    throw new AggregateError(closeErrors, "Packaged updater close failed");
  }
}
async function launch() {
  app = await fixture.launch();
  await findCodeShellWindow(app);
  win = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(win);
  win.setDefaultTimeout(8_000);
  win.on("pageerror", (error) => errors.push(error.message));
  const view = win.getByRole("button", { name: /^(仅查看|View only)/ });
  if (
    await view.waitFor({ state: "visible", timeout: 1_500 }).then(
      () => true,
      () => false,
    )
  )
    await view.click();
  const general = win.locator('[data-settings-module="general"]:visible');
  // The real shell restores the Settings route across these app restarts.
  // Only open its account menu when the Settings navigation is absent.
  if (!(await general.count())) await navigateSettingsMenu(win, /^(设置|Settings)$/);
  if (await general.count()) await general.click();
  const heading = win.getByRole("heading", { name: /^(自动更新|Auto-update)$/ });
  await heading.waitFor();
  await win.evaluate(() => {
    window.__ownedUpdaterEvents = [];
    window.codeshell.onUpdaterStatus((status) =>
      window.__ownedUpdaterEvents.push({ at: Date.now(), ...status }),
    );
  });
  return { ...app.__packagedIdentity, startupPause: app.__startupPause };
}
async function check(feedMode, version) {
  assert.ok(
    Date.now() < explicitCheckDeadline,
    "Explicit UI sequence must precede the real 30s background timer",
  );
  assert.equal(pending.length, 0, "No background request may overlap the explicit UI check");
  mode = feedMode;
  await win.evaluate(() => {
    window.__ownedUpdaterEvents = [];
  });
  const checkButton = win.getByRole("button", { name: /^(检查更新|Check for updates)$/ });
  await until(
    async () => (await checkButton.getAttribute("aria-disabled")) !== "true",
    "real Settings check action ready",
  );
  await checkButton.click();
  await until(() => pending.length === 1, "actual generic manifest HTTP request");
  assert.equal(await checkButton.getAttribute("aria-busy"), "true");
  const held = pending.shift();
  assert.equal(held.mode, feedMode);
  if (feedMode === "healthy") {
    const checksum = Buffer.alloc(64).toString("base64");
    held.response.writeHead(200, { "content-type": "text/yaml" });
    held.response.end(
      `version: ${version}\nfiles:\n  - url: owned-update.zip\n    sha512: ${checksum}\npath: owned-update.zip\nsha512: ${checksum}\nreleaseDate: '2026-10-16T00:00:00.000Z'\n`,
    );
  } else if (feedMode === "yaml") {
    held.response.writeHead(200, { "content-type": "text/yaml" });
    held.response.end("version: [\nfiles: invalid: [\n");
  } else {
    held.response.writeHead(Number(feedMode), { "content-type": "text/plain" });
    held.response.end(`Owned update feed ${feedMode}`);
  }
  // invoke() only clears aria-busy after the real updater:check handler resolves.
  // Read its native status then, so an intermediate not-available cannot pass.
  await until(
    async () => (await checkButton.getAttribute("aria-busy")) !== "true",
    "actual updater IPC settled",
  );
  assert.ok(
    Date.now() < explicitCheckDeadline,
    "Explicit UI sequence exceeded its pre-background timer budget",
  );
  const finalNative = await win.evaluate(() => window.codeshell.getUpdaterStatus());
  const events = await win.evaluate(() => window.__ownedUpdaterEvents);
  const section = win.getByRole("heading", { name: /^(自动更新|Auto-update)$/ }).locator("..");
  const ui = await section.getByRole("status").innerText();
  const problems = [];
  const expected = feedMode === "404" || feedMode === "healthy" ? "not-available" : "error";
  if (finalNative.kind !== expected)
    problems.push(`final native ${finalNative.kind}, expected ${expected}`);
  if (!events.some((event) => event.kind === "checking"))
    problems.push("actual checking event missing");
  if (expected === "not-available" && events.some((event) => event.kind === "error"))
    problems.push("quiet check was overwritten by an error event");
  if (expected === "error" && events.some((event) => event.kind === "not-available"))
    problems.push("real error briefly advertised up-to-date");
  if (expected === "not-available" && !/已是最新|Up to date/.test(ui))
    problems.push("Settings did not show settled up-to-date status");
  if (expected === "error" && !/失败|Failed/.test(ui))
    problems.push("Settings did not show settled failure");
  if (feedMode !== "yaml" && expected === "error" && !finalNative.message.includes(feedMode))
    problems.push("real HTTP failure detail missing");
  return { feedMode, expected, finalNative, events, ui, problems };
}
try {
  if (process.platform === "darwin") {
    keychainReference = readKeychainReference(options.get("--default-keychain-reference"));
    keychainContext = bindPrivateKeychainContext({
      home: isolated.home,
      root: fixtureRoot,
      reference: keychainReference,
      receiptFile: join(fixtureRoot, "keychain-context.json"),
    });
  }
  await mkdir(isolated.codeShellHome, { mode: 0o700 });
  await writeFile(join(isolated.codeShellHome, "settings.json"), '{"autoUpdates":false}\n', {
    mode: 0o600,
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await put("inventory-before.json", await inventoryAppTree(packagedApp));
  fixture = await preparePackagedPetFixture({
    officialApp: packagedApp,
    isolated,
    origin,
    fixtureRoot,
    keychainReferenceFile: options.get("--default-keychain-reference"),
    requireWorkerEvidence: false,
  });
  fixture.env.CODESHELL_UPDATE_FEED = origin;
  // Keep the production 30s timer unchanged. All ten actual UI checks share
  // one Main and must finish in 20s from launch, before it can fire.
  explicitCheckDeadline = Date.now() + 20_000;
  const identity = await launch();
  for (const feedMode of ["404", "401", "403", "500", "yaml"]) {
    const result = await check(feedMode, identity.version);
    await win.screenshot({ path: join(evidence, `updater-${feedMode}-result.png`) });
    const retry = await check("healthy", identity.version);
    operations.push({ feedMode, identity, result, retry });
    await put("operations.json", operations);
    await win.screenshot({ path: join(evidence, `updater-${feedMode}-retry.png`) });
    for (const item of [result, retry])
      for (const problem of item.problems)
        failures.push(new Error(`${feedMode}/${item.feedMode}: ${problem}`));
  }
  await closeApp();
  assert.equal(
    requests.length,
    10,
    "Exactly one request per explicit check and retry; no asset fetch",
  );
} catch (error) {
  failures.push(error);
  await win?.screenshot({ path: join(evidence, "failure.png"), timeout: 2_000 }).catch(() => {});
}
const settled = await settlePackagedPet({
  failures,
  closeApp,
  closeModel: async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  },
  verifyUnchanged: async () => {
    if (!fixture) return undefined;
    const artifacts = await fixture.verifyUnchanged();
    await put("inventory-after.json", await inventoryAppTree(packagedApp));
    return artifacts;
  },
  readNativeCalls: async () => {
    processEvidence = {
      guards: await rows("network-guard.jsonl"),
      spawnedWorkers: await rows("spawned-workers.jsonl"),
      mainExits: await rows("main-exits.jsonl"),
    };
    nativeCalls = await rows("native-storage.jsonl");
    return nativeCalls;
  },
  canCleanup: async () => {
    if (!fixture) return false;
    assert.equal(closeFailed, false, "Abnormal Main close requires retaining private HOME");
    assert.deepEqual(nativeCalls, [], "Native storage access requires retaining private HOME");
    assert.deepEqual(
      processEvidence.spawnedWorkers,
      [],
      "Worker creation requires retaining private HOME",
    );
    assert.deepEqual(errors, [], "Renderer/feed failure requires retaining private HOME");
    if (keychainReference) {
      const after = readDefaultKeychain(keychainReference.home);
      for (const key of ["path", "dev", "ino", "uid"])
        assert.equal(after[key], keychainReference[key], "OS default Keychain metadata drifted");
      keychainContext.operatorDefaultUnchangedAfterRuntime = true;
    }
    return fixture.canCleanup();
  },
  cleanup: () => isolated.cleanup(),
  retainedHome: isolated.home,
});
const receipt = {
  status: settled.errors.length ? "failed" : "passed",
  packagedApp,
  operations,
  requests,
  errors,
  processEvidence,
  artifacts: settled.artifacts,
  nativeCalls: settled.nativeCalls,
  keychainContext,
  privateHomeRemoved: settled.privateHomeRemoved,
  retainedHome: settled.privateHomeRemoved ? null : isolated.home,
  failures: settled.errors.map((error) => ({
    message: error.message,
    cause: error.cause?.message,
  })),
  boundary:
    "Actual supplied packaged Main/preload/Settings/electron-updater; only owned generic HTTP feed response. No updater/IPC/isPackaged substitution, no download/install/external open, no Worker/model/nativeStorage. Guard scope is preimport fetch/http/https, Chromium origin allowlist and private HOME; no raw socket or OS sandbox claim.",
};
await put("receipt.json", receipt);
console.log(
  JSON.stringify({
    status: receipt.status,
    evidence,
    operations: operations.length,
    privateHomeRemoved: settled.privateHomeRemoved,
  }),
);
assert.equal(receipt.status, "passed", "Packaged updater regression failed; evidence retained");
