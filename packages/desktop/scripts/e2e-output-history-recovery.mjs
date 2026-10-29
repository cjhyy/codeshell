/* Real Main composition → preload → Native App → explicit review → durable checkpoint.
 * Synthetic records, private HOME, deny-all model network; no current user App is touched. */
/* global window, localStorage */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "codeshell-output-recovery-ui-"));
const keyringKeys = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SESSION_BUS_PID",
  "GNOME_KEYRING_CONTROL",
  "GNOME_KEYRING_PID",
  "SECURITYSESSIONID",
  "XDG_CURRENT_DESKTOP",
  "WAYLAND_DISPLAY",
];
const keyring = Object.fromEntries(
  keyringKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);
const env = { ...createBunTestEnvironment(process.env, root), ...keyring };
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
const isolated = {
  home: env.HOME,
  codeShellHome: env.CODE_SHELL_HOME,
  userDataDir: join(env.HOME, "electron-user-data"),
};
const {
  launchCodeShellElectron,
  findCodeShellWindow,
  captureRendererErrors,
  verifyElectronMainIdentity,
} = await import("./electron-harness.mjs");
const { prepareConfinedElectronFixture } = await import("./confined-electron-fixture.mjs");
const origin = "http://127.0.0.1:9";
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin,
  guardModule: new URL("./output-history-recovery-guard.mjs", import.meta.url).href,
});
fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
const evidence = join(root, "evidence");
await mkdir(evidence, { mode: 0o700 });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const rows = async (file) =>
  (await readFile(file, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
let app,
  win,
  phase = "seed",
  passed = false,
  errorMessage;
let mainPid,
  mainIdentity,
  mainExit,
  workerPids = [];
const observations = [];
const step = async (name, body) => {
  phase = name;
  console.log(`RECOVERY: ${name}`);
  await body();
  observations.push(name);
};
async function verifyProcesses() {
  mainIdentity = await verifyElectronMainIdentity(app, {
    executable: createRequire(import.meta.url)("electron"),
    home: isolated.home,
  });
  const receipts = await rows(fixture.env.CODESHELL_COST_GUI_GUARD_LOG);
  const spawned = await rows(join(isolated.home, "spawned-workers.jsonl"));
  for (const receipt of receipts) {
    assert.equal(receipt.kind, "cost-gui-deny-all");
    assert.equal(receipt.homeId, hash(isolated.home));
    assert.equal(receipt.origin, origin);
    assert.equal(receipt.negativeProbes, 7);
  }
  assert.ok(receipts.some((item) => item.pid === mainPid));
  for (const worker of spawned) {
    assert.ok(receipts.some((item) => item.pid === worker.pid && item.ppid === mainPid));
    await writeFile(join(isolated.home, `worker-${worker.pid}.permit`), "verified", {
      mode: 0o600,
    });
  }
  workerPids = spawned.map((item) => item.pid);
  return receipts;
}
async function seedRecords(...args) {
  const seeded = spawn(
    process.execPath,
    [
      "--import",
      new URL("./output-history-recovery-guard.mjs", import.meta.url).href,
      fileURLToPath(new URL("./output-history-recovery-seed.mjs", import.meta.url)),
      ...args,
    ],
    {
      env: {
        ...env,
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
}
try {
  await seedRecords();
  const seed = await json(join(isolated.home, "recovery-seed.json"));
  await step("launch real guarded Main/preload/renderer", async () => {
    app = await launchCodeShellElectron({
      appDir,
      ...isolated,
      mainEntry: fixture.mainEntry,
      env: fixture.env,
      runtimeTimeoutMs: 120_000,
    });
    mainPid = app.process().pid;
    win = await findCodeShellWindow(app);
    win.setDefaultTimeout(20_000);
    await win.setViewportSize({ width: 1360, height: 1000 });
    await verifyProcesses();
    const viewOnly = win.getByRole("button", { name: /^(仅查看|View only)/ });
    if (
      await viewOnly.waitFor({ state: "visible", timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    )
      await viewOnly.click();
    await win.evaluate(() => {
      localStorage.setItem("codeshell.uiLanguage", "en");
      window.dispatchEvent(new window.Event("codeshell:language-changed"));
    });
  });
  const rendererErrors = captureRendererErrors(win);
  const recovery = win.locator("[data-native-output-recovery]");
  await step(
    "incomplete history blocks sending and exposes an actual recovery review",
    async () => {
      await recovery.getByRole("button", { name: "Review recovery", exact: true }).waitFor();
      await recovery.getByRole("button", { name: "Review recovery", exact: true }).click();
      await recovery
        .getByText(
          "Verified and retained 1 conversation turns, 1 inputs, 0 tool calls and 0 tool results.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        hash(await readFile(join(seed.directory, "state.json"))),
        seed.hashes["state.json"],
      );
      await recovery.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(
        hash(await readFile(join(seed.directory, "state.json"))),
        seed.hashes["state.json"],
      );
      const composer = win.locator("textarea:visible").first();
      await composer.fill("OWNED DRAFT PRESERVED WITHOUT SEND");
      await recovery.getByRole("button", { name: "Review recovery", exact: true }).click();
      await recovery
        .getByRole("button", { name: "Preserve records and recover", exact: true })
        .waitFor();
      await win.screenshot({ path: join(evidence, "review.png"), animations: "disabled" });
    },
  );
  await step(
    "explicit confirmation checkpoints the same session and fully reloads all journal pages",
    async () => {
      await recovery
        .getByRole("button", { name: "Preserve records and recover", exact: true })
        .click();
      await recovery
        .getByText("This conversation has a known history gap", { exact: true })
        .waitFor();
      await win
        .getByText(/OWNED ANSWER 1199/)
        .first()
        .waitFor();
      await recovery
        .locator("li")
        .filter({ hasText: "OWNED UNCERTAIN INPUT DO NOT AUTO SEND" })
        .waitFor();
      assert.equal(
        await win.locator("textarea:visible").first().inputValue(),
        "OWNED DRAFT PRESERVED WITHOUT SEND",
      );
      assert.equal(
        await recovery.getByRole("button", { name: "Review recovery", exact: true }).count(),
        0,
      );
      assert.equal(
        await recovery
          .getByRole("button", { name: "History checked — resend held inputs", exact: true })
          .isDisabled(),
        true,
      );
      await recovery.getByText(/held-attachment.txt/).waitFor();
      const state = await json(join(seed.directory, "state.json"));
      assert.equal(state.sessionId, seed.id);
      assert.equal(state.outputCoverage.unpaired, false);
      assert.equal(state.outputHistoryRecovery.historicalGap, true);
      for (const name of ["transcript.jsonl", "output-journal.jsonl", "external-runtime.json"])
        assert.equal(hash(await readFile(join(seed.directory, name))), seed.hashes[name]);
      const archive = join(
        seed.directory,
        ".output-history-recovery",
        state.outputHistoryRecovery.recoveryId,
      );
      const names = await readdir(archive);
      assert.ok(names.includes("receipt.json"));
      const receipt = await json(join(archive, "receipt.json"));
      assert.equal(receipt.historicalGap, true);
      assert.equal(receipt.sessionId, seed.id);
      for (const [name, expected] of Object.entries(seed.hashes))
        assert.ok(
          receipt.source.some(
            (item) =>
              item.name === (name === "output-journal.jsonl" ? "journal.jsonl" : name) &&
              item.sha256 === expected,
          ),
          `receipt preserves ${name}`,
        );
      for (const source of receipt.source)
        assert.equal(
          hash(await readFile(join(archive, source.name))),
          source.sha256,
          "backup bytes match the accepted receipt",
        );
      const operations = await rows(join(isolated.home, "recovery-operations.jsonl"));
      const afterApply = operations.slice(
        operations.findIndex((item) => item.operation === "sessions:outputRecoveryApply") + 1,
      );
      const recoveredPages = afterApply.filter(
        (item) => item.operation === "sessions:outputJournal",
      ).length;
      assert.ok(recoveredPages >= 2, "fresh checkpoint must complete multiple real journal pages");
      const oldRead = await win.evaluate(
        ({ id, cursor }) => window.codeshell.getSessionOutputJournal(id, { after: cursor }),
        { id: seed.id, cursor: seed.oldCursor },
      );
      assert.equal(oldRead.status, "cursor_invalid");
      const fresh = await win.evaluate((id) => window.codeshell.subscribeSession(id, 0), seed.id);
      assert.equal(fresh.historicalGap, true);
      assert.notEqual(fresh.outputUnpaired, true);
      await writeFile(
        join(evidence, "checkpoint.json"),
        JSON.stringify(
          {
            sessionId: state.sessionId,
            historicalGap: true,
            oldCursorRejected: true,
            recoveredPages,
            receiptSourceNames: receipt.source.map((item) => item.name),
            journalReads: (await rows(join(isolated.home, "recovery-operations.jsonl"))).filter(
              (item) => item.operation === "sessions:outputJournal",
            ).length,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await win.screenshot({ path: join(evidence, "recovered.png"), animations: "disabled" });
    },
  );
  await step(
    "new production-writer output and renderer reload retain the gap without replaying old work",
    async () => {
      await seedRecords("--append-after-checkpoint");
      await win.reload();
      await recovery
        .getByText("This conversation has a known history gap", { exact: true })
        .waitFor();
      await win
        .getByText(/OWNED ANSWER 1199/)
        .first()
        .waitFor();
      await win.getByText("OWNED NEW OUTPUT AFTER CHECKPOINT", { exact: true }).waitFor();
      assert.equal(
        hash(await readFile(join(seed.directory, "external-runtime.json"))),
        seed.hashes["external-runtime.json"],
      );
      await verifyProcesses();
      assert.deepEqual(rendererErrors, []);
      assert.deepEqual(
        (await rows(join(isolated.home, "recovery-operations.jsonl"))).filter(
          (item) => item.kind === "forbidden",
        ),
        [],
      );
      assert.equal(await readFile(seed.attachment, "utf8"), "OWNED ATTACHMENT PRESERVED");
    },
  );
  passed = true;
} catch (error) {
  errorMessage = String(error?.stack ?? error);
  if (win) {
    await win.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    await writeFile(
      join(evidence, "failure-dom.txt"),
      await win
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
      { mode: 0o600 },
    );
  }
  console.error(`RECOVERY FAILED (${phase}): ${errorMessage}`);
} finally {
  if (app) {
    const child = app.process();
    try {
      await app.close();
    } catch (error) {
      passed = false;
      errorMessage ??= String(error);
    }
    mainExit = { code: child.exitCode, signal: child.signalCode };
    if (child.exitCode !== 0 || child.signalCode !== null) passed = false;
  }
  const aliveWorkers = workerPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  });
  if (aliveWorkers.length) passed = false;
  const operations = await rows(join(isolated.home, "recovery-operations.jsonl"));
  if (operations.some((item) => item.kind === "forbidden")) passed = false;
  const receipt = {
    status: passed ? "passed" : "failed",
    phase,
    error: errorMessage,
    evidence,
    observations,
    mainPid,
    mainIdentity,
    mainExit,
    workerPids,
    aliveWorkers,
    forbiddenOperations: operations.filter((item) => item.kind === "forbidden"),
    ipc: operations.filter((item) => item.kind === "ipc"),
    guardReceipts: await rows(fixture.env.CODESHELL_COST_GUI_GUARD_LOG),
    scope:
      "Actual source Main/preload/Native App; synthetic persisted history; no provider calls or user App operations",
  };
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: receipt.status,
      evidence,
      mainExit,
      aliveWorkers,
      forbiddenOperations: receipt.forbiddenOperations.length,
    }),
  );
  process.exitCode = passed ? 0 : 1;
}
