/* Actual packaged Main/preload/renderer UI, without credentials or a model run.
 * Uses the packaged inspector bootstrap and full before/after app inventory.
 * This is UI evidence, never Pet/worker/native-encryption acceptance.
 * node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/e2e-ui-packaged.mjs
 *   --packaged-app /owned/code-shell.app --default-keychain-reference /owned/reference.json
 *   --evidence-dir /owned/new-ui-evidence */
/* global document, getComputedStyle, Image, localStorage, window */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";
import { preparePackagedPetFixture } from "./packaged-pet-fixture.mjs";
import { settlePackagedPet } from "./packaged-pet-shutdown.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import {
  captureRendererErrors,
  findCodeShellWindow,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";
import {
  bindPrivateKeychainContext,
  readDefaultKeychain,
  readKeychainReference,
} from "./macos-keychain-context.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "run-isolated-node-smoke.mjs is required");
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
for (const flag of ["--packaged-app", "--evidence-dir"])
  assert.ok(options.has(flag), `${flag} is required`);
if (process.platform === "darwin")
  assert.ok(options.has("--default-keychain-reference"), "Existing Keychain metadata is required");
const evidence = options.get("--evidence-dir");
const packagedApp = await realpath(options.get("--packaged-app"));
const evidenceParent = await realpath(resolve(evidence, ".."));
const appRelative = relative(packagedApp, join(evidenceParent, basename(evidence)));
assert.ok(
  appRelative &&
    (appRelative === ".." || appRelative.startsWith(`..${sep}`) || isAbsolute(appRelative)),
  "Evidence must be outside the supplied package",
);
await mkdir(evidence, { mode: 0o700 });
const isolated = await makeIsolatedElectronHome("codeshell-packaged-ui-");
const fixtureRoot = await realpath(isolated.home);
isolated.home = join(fixtureRoot, "home");
await mkdir(isolated.home, { mode: 0o700 });
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
let fixture;
let model;
let app;
let win;
let keychainReference;
let keychainContext;
const failures = [];
const operations = [];
const rendererErrors = [];
let identity;
let processEvidence;

const put = async (path, value) => {
  await writeFile(
    path,
    typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
};
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
async function step(action, run) {
  const result = await run();
  operations.push({ action, result });
  await writeFile(join(evidence, "operations.json"), JSON.stringify(operations, null, 2), {
    mode: 0o600,
  });
  return result;
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  const child = closing.process();
  const errors = [];
  let timer;
  try {
    await Promise.race([
      closing.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Owned packaged UI close timed out")), 5_000);
      }),
    ]);
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await fixture.terminateChild(child);
    } catch (error) {
      errors.push(error);
    }
  }
  if (child.exitCode === null && child.signalCode === null)
    errors.push(Error("Captured packaged UI Main still alive; HOME retained"));
  else {
    app = undefined;
    if (child.exitCode !== 0 || child.signalCode !== null)
      errors.push(Error("Packaged UI Main did not exit normally with code 0 and no signal"));
  }
  if (errors.length) throw new AggregateError(errors, "Owned packaged UI close failed");
}
function png() {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) * 0xedb88320);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, bytes) => {
    const body = Buffer.concat([Buffer.from(kind), bytes]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 80, 120, 200]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function chooseModule(id) {
  const picker = win.locator("[data-settings-module-picker]:visible");
  if (await picker.isVisible()) {
    await picker.click();
    const name = id === "appearance" ? /^(外观|Appearance)$/ : /^(常规|通用|General)$/;
    await win.getByRole("option", { name }).click();
  } else await win.locator(`[data-settings-module="${id}"]:visible`).click();
  await win.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
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
  await put(join(isolated.codeShellHome, "settings.json"), { autoUpdates: false });
  const themeSource = join(isolated.home, "owned-ui-theme");
  await mkdir(themeSource, { mode: 0o700 });
  for (const file of ["light.png", "dark.png"]) await put(join(themeSource, file), png());
  await put(join(themeSource, ".cs-theme.json"), {
    schemaVersion: 1,
    id: "packaged-ui-owned",
    name: "Packaged UI owned theme",
    version: "1.0.0",
    surfaces: { window: { light: "light.png", dark: "dark.png", opacity: 0.2 } },
  });
  model = await startMockProviderServer();
  fixture = await preparePackagedPetFixture({
    officialApp: options.get("--packaged-app"),
    isolated,
    origin: model.origin,
    fixtureRoot,
    keychainReferenceFile: options.get("--default-keychain-reference"),
    requireWorkerEvidence: false,
  });
  await step(
    "Start the supplied package with first-instruction Main guard and private HOME",
    async () => {
      app = await fixture.launch();
      identity = { ...app.__packagedIdentity, startupPause: app.__startupPause };
      await findCodeShellWindow(app);
      win = app.windows().find((page) => {
        const url = new URL(page.url());
        return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
      });
      assert.ok(win, "Packaged workbench was not found");
      rendererErrors.push(captureRendererErrors(win));
      win.setDefaultTimeout(15_000);
      await win.locator("#root").waitFor();
      const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
      if (
        await viewOnly.waitFor({ state: "visible", timeout: 2_000 }).then(
          () => true,
          () => false,
        )
      )
        await viewOnly.click();
      const keyring = await app.evaluate(({ app }) => ({
        mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
        passwordStore: app.commandLine.getSwitchValue("password-store"),
      }));
      assert.equal(keyring.mockKeychain, false);
      assert.notEqual(keyring.passwordStore, "basic");
      return { ...identity, keyring };
    },
  );
  const nativeWindow = await app.browserWindow(win);
  await step("Open Settings and Appearance through the account menu", async () => {
    await navigateSettingsMenu(win, /^(设置|Settings)$/);
    await chooseModule("appearance");
    await win.locator("[data-theme-import-directory]").waitFor({ state: "visible" });
    return { page: await win.getByRole("heading", { level: 1 }).innerText() };
  });
  await step("Import an owned local theme through native picker, review and Install", async () => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, themeSource);
    await win.locator("[data-theme-import-directory]").click();
    const review = win.getByRole("dialog");
    await review.waitFor({ state: "visible" });
    await review.getByRole("button", { name: /^(安装|Install)$/ }).click();
    await review.waitFor({ state: "hidden" });
    await win
      .locator('[data-theme-pack="packaged-ui-owned"] button[aria-pressed="true"]')
      .waitFor();
    return { picker: "only its return value is controlled", themeId: "packaged-ui-owned" };
  });
  for (const width of [1280, 768, 390]) {
    await nativeWindow.evaluate((window, width) => {
      window.setMinimumSize(0, 0);
      window.setContentSize(width, 900);
    }, width);
    await win.waitForFunction((width) => window.innerWidth === width, width);
    await step(`Navigate General and Appearance in a real ${width}px content window`, async () => {
      await chooseModule("general");
      await chooseModule("appearance");
      await win.locator('[data-theme-mode="light"]').waitFor({ state: "visible" });
      return { contentWidth: await win.evaluate(() => window.innerWidth) };
    });
    for (const mode of ["light", "dark"]) {
      await step(
        `Choose ${mode}, decode cstheme assets and inspect ${width}px layout`,
        async () => {
          await win.locator(`[data-theme-mode="${mode}"]`).click();
          await win.waitForFunction(
            (mode) =>
              document.documentElement.classList.contains("dark") === (mode === "dark") &&
              localStorage.getItem("codeshell.theme") === mode,
            mode,
          );
          const result = await win.evaluate(
            async ({ width, mode }) => {
              const images = [...document.querySelectorAll('[data-theme-surface="window"]')]
                .map((node) => getComputedStyle(node, "::before").backgroundImage)
                .flatMap((image) =>
                  [...image.matchAll(/url\(["']?(.*?)["']?\)/g)].map((match) => match[1]),
                );
              const urls = [...new Set(images)].filter((url) =>
                url.startsWith("cstheme://packaged-ui-owned/"),
              );
              const decoded = await Promise.race([
                Promise.all(
                  urls.map(async (url) => {
                    const image = new Image();
                    image.src = url;
                    await image.decode();
                    return { url, width: image.naturalWidth, height: image.naturalHeight };
                  }),
                ),
                new Promise((_, reject) =>
                  setTimeout(() => reject(Error("Theme decode timed out")), 10_000),
                ),
              ]);
              const controls = [
                ...document.querySelectorAll(
                  "[data-theme-mode], [data-theme-import-directory], [data-settings-back], [data-settings-module-picker]",
                ),
              ]
                .filter((node) => node.getClientRects().length)
                .map((node) => {
                  const rect = node.getBoundingClientRect();
                  return {
                    label: node.getAttribute("aria-label") ?? node.textContent,
                    x: rect.x,
                    right: rect.right,
                    width: rect.width,
                  };
                });
              return {
                width,
                mode,
                decoded,
                controls,
                viewport: window.innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
              };
            },
            { width, mode },
          );
          assert.ok(result.decoded.length > 0, "The installed cstheme image was not applied");
          assert.ok(result.decoded.every((image) => image.width > 0 && image.height > 0));
          assert.ok(
            result.decoded.every((image) => image.url.endsWith(`surface-window-${mode}.png`)),
            "Theme mode did not switch the installed asset",
          );
          assert.ok(result.controls.length >= 5);
          assert.ok(
            result.controls.every(
              (control) => control.x >= -1 && control.right <= width + 1 && control.width > 0,
            ),
            "Settings controls overflow the native content width",
          );
          assert.ok(result.scrollWidth <= width + 1, "Settings has horizontal document overflow");
          await win.screenshot({
            path: join(evidence, `settings-${width}-${mode}.png`),
            animations: "disabled",
          });
          return result;
        },
      );
    }
  }
  await step(
    "Reload the packaged renderer and retain selected mode and installed theme",
    async () => {
      await win.reload();
      await win.locator("#root").waitFor();
      // The persisted Settings route mounts lazily after #root exists. Await
      // its real control before choosing a module; the workbench sidebar is hidden here.
      await win.locator("[data-settings-back]:visible").first().waitFor({ state: "visible" });
      await chooseModule("appearance");
      await win.locator('[data-theme-mode="dark"][aria-pressed="true"]').waitFor();
      await win
        .locator('[data-theme-pack="packaged-ui-owned"] button[aria-pressed="true"]')
        .waitFor();
      await win.screenshot({
        path: join(evidence, "settings-reload-390-dark.png"),
        animations: "disabled",
      });
      return { dark: true, themeId: "packaged-ui-owned", rendererReload: true };
    },
  );
  assert.equal(rendererErrors.flat().length, 0, "Packaged UI emitted a renderer error");
  assert.equal(model.requests.length, 0, "UI fixture unexpectedly invoked a model");
  assert.deepEqual(
    await rows("spawned-workers.jsonl"),
    [],
    "UI fixture unexpectedly spawned a worker",
  );
  assert.deepEqual(
    await rows("native-storage.jsonl"),
    [],
    "UI fixture invoked native secret storage",
  );
} catch (error) {
  failures.push(error);
  if (win) {
    try {
      await win.screenshot({ path: join(evidence, "failure.png"), timeout: 3_000 });
      await put(
        join(evidence, "failure-body.txt"),
        await win.locator("body").innerText({ timeout: 3_000 }),
      );
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
  }
}
const result = await settlePackagedPet({
  failures,
  closeApp: async () => {
    await closeApp();
    assert.equal(rendererErrors.flat().length, 0, "Packaged UI emitted an error during close");
  },
  closeModel: async () => {
    await model?.close();
  },
  verifyUnchanged: async () => (fixture ? fixture.verifyUnchanged() : undefined),
  readNativeCalls: async () => {
    processEvidence = {
      mainGuards: await rows("network-guard.jsonl"),
      spawnedWorkers: await rows("spawned-workers.jsonl"),
      mainSpawnExits: await rows("main-exits.jsonl"),
      workerExits: await rows("worker-exits.jsonl"),
    };
    return rows("native-storage.jsonl");
  },
  canCleanup: async () => (fixture ? fixture.canCleanup() : true),
  cleanup: () => isolated.cleanup(),
  retainedHome: isolated.home,
});
if (result.nativeCalls?.length || processEvidence?.spawnedWorkers.length || model?.requests.length)
  result.errors.push(
    Error("UI-only fixture invoked secret storage, created a worker or sent a model request"),
  );
if (keychainReference) {
  try {
    const after = readDefaultKeychain(keychainReference.home);
    for (const key of ["path", "dev", "ino", "uid"])
      assert.equal(after[key], keychainReference[key], "OS default Keychain metadata changed");
    keychainContext.operatorDefaultUnchangedAfterRuntime = true;
  } catch (error) {
    result.errors.push(error);
  }
}
const describe = (error, depth = 0) => ({
  name: error.name,
  message: error.message,
  ...(depth < 3 && error.cause ? { cause: describe(error.cause, depth + 1) } : {}),
  ...(depth < 3 && error.errors
    ? { errors: error.errors.map((nested) => describe(nested, depth + 1)) }
    : {}),
});
const receipt = {
  fixture: "packaged-ui-without-worker",
  status: result.errors.length ? "failed" : "passed",
  suppliedApp: options.get("--packaged-app"),
  provenance:
    "Caller-supplied package; platform integrity checks do not establish publisher signing, notarization or installer/update acceptance",
  identity,
  processEvidence,
  operations,
  artifacts: result.artifacts,
  nativeCalls: result.nativeCalls,
  rendererErrors: rendererErrors.flat().map(String),
  localModelRequests: model?.requests.length ?? 0,
  workerAcceptance: false,
  petAcceptance: false,
  nativeEncryptionAcceptance: false,
  guardScope:
    "Preimport Main fetch/http/https and private HOME; Chromium URL allowlist; no raw net/tls or OS sandbox claim",
  exitEvidenceBoundary:
    "Captured Main, actual stdio workers and identity-checked observed descendants; this does not establish that every OS process was observed",
  keychainContext,
  privateHomeRemoved: result.privateHomeRemoved,
  retainedHome: result.privateHomeRemoved ? null : isolated.home,
  errors: result.errors.map((error) => describe(error)),
};
await put(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(
  JSON.stringify({
    status: receipt.status,
    evidence,
    privateHomeRemoved: result.privateHomeRemoved,
  }),
);
if (result.errors.length) throw new AggregateError(result.errors, "Packaged UI acceptance failed");
