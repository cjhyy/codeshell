/* global document, location, performance, window */
// From the repository root, on the same Mac for both packaged versions:
// node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/benchmark-packaged-startup.mjs <app> <new-report.json>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, release } from "node:os";
import { join, resolve } from "node:path";
import {
  ACCEPTANCE_APP_NAME,
  findCodeShellWindow,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { preparePackagedPetFixture } from "./packaged-pet-fixture.mjs";

assert.equal(process.platform, "darwin", "Run the signed app bundle on its native Mac");
assert.equal(process.env.NODE_ENV, "test", "Use scripts/run-isolated-node-smoke.mjs");
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.equal(process.argv.length, 4, "Expected <app> <new-report.json>");
const [officialApp, output] = process.argv.slice(2).map((path) => resolve(path));
const timings = [];
const timestamp = new Date().toISOString();
let product;

async function measure() {
  const root = await makeIsolatedElectronHome("codeshell-startup-");
  const home = join(root.home, "profile");
  const codeShellHome = join(home, ".code-shell");
  const isolated = { home, codeShellHome, userDataDir: join(home, "chromium") };
  let fixture;
  let app;
  let failure;
  let sample;
  try {
    await mkdir(codeShellHome, { recursive: true, mode: 0o700 });
    await seedOfflinePluginBootstrap(codeShellHome);
    await writeFile(join(codeShellHome, "settings.json"), JSON.stringify({ autoUpdates: false }), {
      mode: 0o600,
    });
    fixture = await preparePackagedPetFixture({
      officialApp,
      isolated,
      fixtureRoot: root.home,
      origin: "http://127.0.0.1:9",
      requireWorkerEvidence: false,
      mockKeychain: true,
    });
    app = await fixture.launch();
    const main = await app.evaluate(({ app }) => ({
      created: app.getAppMetrics().find(({ pid }) => pid === process.pid)?.creationTime,
      mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
    }));
    assert(main.mockKeychain && main.name === ACCEPTANCE_APP_NAME);
    assert(Number.isFinite(main.created) && main.created > 0);
    const page = await findCodeShellWindow(app);
    await page.waitForFunction(
      () =>
        location.protocol === "file:" &&
        location.pathname.endsWith("/out/renderer/index.html") &&
        !location.search &&
        typeof window.codeshell === "object" &&
        document.querySelector("#root")?.childElementCount &&
        performance.getEntriesByName("first-contentful-paint", "paint").length > 0,
    );
    const paint = await page.evaluate(() => {
      const entry = performance.getEntriesByName("first-contentful-paint", "paint")[0];
      return { timeOrigin: performance.timeOrigin, afterNavigationMs: entry.startTime };
    });
    const native = await app.browserWindow(page);
    try {
      assert(await native.evaluate((win) => win.isVisible()), "Primary window must be visible");
    } finally {
      await native.dispose();
    }
    const elapsed = paint.timeOrigin + paint.afterNavigationMs - main.created;
    assert(
      Number.isFinite(elapsed) && elapsed > 0 && elapsed < 120_000,
      "Invalid main birth/FCP clock alignment",
    );
    const identity = {
      version: main.version,
      electron: main.electron,
      appTreeSHA256: fixture.diagnosticContext().appTreeSHA256,
    };
    if (product) assert.deepEqual(identity, product);
    product = identity;
    sample = {
      processToFirstContentfulPaintMs: Math.round(elapsed),
      navigationToFirstContentfulPaintMs: Math.round(paint.afterNavigationMs),
    };
  } catch (error) {
    failure = error;
  }
  try {
    await app?.close();
  } catch (error) {
    failure ??= error;
  }
  if (fixture && !(await fixture.canCleanup()))
    throw new Error(`Packaged exit was not confirmed; retained ${root.home}`, { cause: failure });
  await root.cleanup();
  if (failure) throw failure;
  return sample;
}

for (let index = 0; index < 5; index++) {
  timings.push(await measure());
  console.log(`Launch ${index + 1}: ${timings[index].processToFirstContentfulPaintMs} ms`);
}
const sorted = timings.map((row) => row.processToFirstContentfulPaintMs).sort((a, b) => a - b);
const report = {
  schemaVersion: 1,
  timestamp,
  product,
  system: {
    macOS: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    darwin: release(),
    arch: process.arch,
    cpu: cpus()[0].model,
  },
  conditions:
    "Five fresh processes and profiles, primed OS file cache from package verification before each launch, startup inspector pause and network guard included, Chromium mock Keychain.",
  metric:
    "Primary renderer first-contentful-paint minus OS-reported creationTime of the packaged Main process (ms).",
  samples: timings,
  medianMs: sorted[2],
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`Median ${report.medianMs} ms; saved ${output}`);
