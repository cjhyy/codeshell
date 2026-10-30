/* Actual Main → preload → renderer; synthetic approval authority + real durable
 * history. Private HOME, deny-all HTTP, blocked secret storage and worker writes.
 * Run: node scripts/run-isolated-node-smoke.mjs --private-keyring
 *        packages/desktop/scripts/e2e-cross-device-confirmation.mjs */
/* global window, localStorage, Event */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "codeshell-confirmation-ui-"));
const keyringKeys = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SESSION_BUS_PID",
  "GNOME_KEYRING_CONTROL",
  "GNOME_KEYRING_PID",
  "SECURITYSESSIONID",
  "XDG_CURRENT_DESKTOP",
  "WAYLAND_DISPLAY",
];
const environment = {
  ...createBunTestEnvironment(process.env, root),
  ...Object.fromEntries(
    keyringKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  ),
};
for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
Object.assign(process.env, environment);
const isolated = {
  home: environment.HOME,
  codeShellHome: environment.CODE_SHELL_HOME,
  userDataDir: join(environment.HOME, "electron-user-data"),
};
const { prepareConfinedElectronFixture } = await import("./confined-electron-fixture.mjs");
const { launchCodeShellElectron, findCodeShellWindow, captureRendererErrors } =
  await import("./electron-harness.mjs");
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin: "http://127.0.0.1:9",
  guardModule: new URL("./cross-device-confirmation-guard.mjs", import.meta.url).href,
});
fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
const target = "synthetic-confirmation-target";
const home = "synthetic-confirmation-home";
const targetTitle = "Synthetic confirmation target";
const question = "SYNTHETIC CONFIRMATION: choose the harmless fixture option";
const requestId = "synthetic-confirmation-request";
const evidence = join(root, "evidence");
const rows = async (file) =>
  (await readFile(file, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
let app, win, processes, rendererErrors;
let phase = "seed",
  passed = false,
  error;
const observations = [];
const step = async (name, body) => {
  phase = name;
  console.log(`CONFIRMATION: ${name}`);
  await body();
  observations.push(name);
};

try {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const seeded = spawn(
    process.execPath,
    [
      "--import",
      new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href,
      fileURLToPath(new URL("./cross-device-confirmation-seed.mjs", import.meta.url)),
    ],
    {
      env: {
        ...environment,
        ...Object.fromEntries(
          Object.entries(fixture.env).filter(([, value]) => value !== undefined),
        ),
      },
      stdio: "inherit",
      timeout: 30_000,
    },
  );
  const seedExit = await new Promise((done, reject) => {
    seeded.once("error", reject);
    seeded.once("exit", (code, signal) => done({ code, signal }));
  });
  assert.deepEqual(seedExit, { code: 0, signal: null });

  await step("launch isolated production Main/preload/renderer", async () => {
    app = await launchCodeShellElectron({
      appDir,
      ...isolated,
      mainEntry: fixture.mainEntry,
      env: fixture.env,
    });
    win = await findCodeShellWindow(app);
    win.setDefaultTimeout(15_000);
    rendererErrors = captureRendererErrors(win);
    await win.setViewportSize({ width: 1360, height: 1000 });
    processes = await fixture.assertWorker(app, { requireWorker: false });
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
    await win.getByText(`OWNED DURABLE OUTPUT ${home}`, { exact: true }).waitFor();
  });
  const envelope = {
    connectionId: "synthetic-source",
    generation: 1,
    sessionId: target,
    requestId,
    expiresAt: Date.now() + 600_000,
    request: {
      toolName: "__ask_user__",
      description: question,
      riskLevel: "low",
      args: {
        question,
        header: "Synthetic confirmation",
        optionsOnly: true,
        options: [
          {
            label: "Allow once fixture",
            description: "Synthetic option; no credential or tool is used",
          },
        ],
      },
    },
  };
  await step("background question survives the target's first durable hydration", async () => {
    await app.evaluate(
      (_electron, value) => globalThis.__crossDeviceConfirmationFixture.request(value),
      envelope,
    );
    assert.equal(
      await win.getByRole("button", { name: "Allow once fixture", exact: true }).count(),
      0,
    );
    await win.getByRole("button", { name: targetTitle, exact: true }).click();
    await win.getByText(`OWNED DURABLE OUTPUT ${target}`, { exact: true }).waitFor();
    await win.getByRole("button", { name: "Allow once fixture", exact: true }).waitFor();
    assert.equal(
      await win.getByRole("button", { name: "Allow once fixture", exact: true }).isEnabled(),
      true,
    );
    const journalReads = (await rows(join(isolated.home, "confirmation-operations.jsonl"))).filter(
      (item) => item.operation === "sessions:outputJournal" && item.sessionId === target,
    );
    assert.ok(
      journalReads.length > 0,
      "target uses real durable journal hydration after the prompt arrived",
    );
    await win.screenshot({
      path: join(evidence, "pending-after-hydration.png"),
      animations: "disabled",
    });
  });
  await step(
    "renderer reload restores the same pending request without extending its deadline",
    async () => {
      await win.reload();
      await win.getByRole("button", { name: "Allow once fixture", exact: true }).waitFor();
      const pending = await win.evaluate(() => window.codeshell.getPendingApprovals());
      assert.equal(pending.length, 1);
      assert.equal(pending[0].requestId, requestId);
      assert.equal(pending[0].expiresAt, envelope.expiresAt);
    },
  );
  await step(
    "another device's resolution immediately retires the desktop confirmation",
    async () => {
      await app.evaluate(
        (_electron, value) => globalThis.__crossDeviceConfirmationFixture.resolve(value),
        {
          connectionId: envelope.connectionId,
          generation: envelope.generation,
          sessionId: target,
          requestId,
          approved: true,
          answer: "Accepted on synthetic phone",
          status: "resolved",
        },
      );
      await win.getByText("Accepted on synthetic phone", { exact: true }).waitFor();
      assert.equal(
        await win.getByRole("button", { name: "Allow once fixture", exact: true }).count(),
        0,
      );
      assert.equal(await app.evaluate(() => globalThis.__crossDeviceConfirmationFixture.size()), 0);
      await win.screenshot({
        path: join(evidence, "resolved-on-other-device.png"),
        animations: "disabled",
      });
      await win.reload();
      await win.getByText(`OWNED DURABLE OUTPUT ${target}`, { exact: true }).waitFor();
      assert.equal(
        await win.getByRole("button", { name: "Allow once fixture", exact: true }).count(),
        0,
      );
    },
  );
  assert.deepEqual(rendererErrors, []);
  passed = true;
} catch (failure) {
  error = String(failure?.stack ?? failure);
  console.error(`CONFIRMATION FAILED (${phase}): ${error}`);
  if (win) {
    await win.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    await writeFile(
      join(evidence, "failure-dom.txt"),
      await win
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
    );
  }
} finally {
  let mainExit;
  if (app) {
    const child = app.process();
    await app.close().catch((failure) => {
      passed = false;
      error ??= String(failure);
    });
    mainExit = { code: child.exitCode, signal: child.signalCode };
    if (child.exitCode !== 0 || child.signalCode !== null) passed = false;
  }
  const operations = await rows(join(isolated.home, "recovery-operations.jsonl"));
  const forbidden = operations.filter((item) => item.kind === "forbidden");
  if (forbidden.length) passed = false;
  const receipt = {
    status: passed ? "passed" : "failed",
    phase,
    error,
    observations,
    mainExit,
    processes,
    forbiddenOperations: forbidden,
    confirmationOperations: await rows(join(isolated.home, "confirmation-operations.jsonl")),
    guardReceipts: await rows(fixture.env.CODESHELL_COST_GUI_GUARD_LOG),
    scope:
      "Actual Main/preload/renderer and durable journals; synthetic pending authority only; no user application, credentials, providers, or IM messages",
  };
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      status: receipt.status,
      evidence,
      mainExit,
      forbiddenOperations: forbidden.length,
    }),
  );
  process.exitCode = passed ? 0 : 1;
}
