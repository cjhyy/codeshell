/* Pure Playwright controller. Core is imported only inside guarded production Main. */
/* global Event, localStorage, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  launchCodeShellElectron,
  findCodeShellWindow,
  navigateSettingsMenu,
  captureRendererErrors,
} from "./electron-harness.mjs";
const home = await realpath(process.argv[2]);
assert.equal(home, process.env.HOME);
const config = JSON.parse(await readFile(join(home, "read-fixture.json"), "utf8"));
const lateRoot = process.argv[3] === "--late-root";
assert.ok(!lateRoot || config.finiteResources);
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = {
  home,
  codeShellHome: join(home, ".code-shell"),
  userDataDir: join(home, "electron-user-data"),
};
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin: config.origin,
  guardModule: new URL("./operation-read-guard.mjs", import.meta.url).href,
});
let app;
try {
  if (lateRoot)
    await writeFile(
      fixture.mainEntry,
      (await readFile(fixture.mainEntry, "utf8")) +
        `\nglobalThis.__readCustody = (await import(${JSON.stringify(config.helperUrl)})).installOperationReadFixture(await import(${JSON.stringify(config.coreUrl)}), ${JSON.stringify(config.origin)}, "review");\n`,
    );
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: fixture.env,
    mainEntry: fixture.mainEntry,
  });
  const mainPid = app.process().pid;
  const homeId = createHash("sha256").update(home).digest("hex");
  let receipt;
  for (let attempt = 0; ; attempt++) {
    const receipts = (await readFile(join(home, "operation-read-guard.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      receipts.every(
        (row) => row.origin === config.origin && row.homeId === homeId && row.negativeProbes === 8,
      ),
    );
    const spawned = (await readFile(join(home, "spawned-workers.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const workers = spawned.filter((worker) =>
      receipts.some((row) => row.pid === worker.pid && row.ppid === mainPid),
    );
    if (receipts.some((row) => row.pid === mainPid)) {
      for (const worker of workers)
        await writeFile(join(home, `worker-${worker.pid}.permit`), "verified");
      const keyring = (await readFile(join(home, "real-keyring-bootstrap.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse)
        .find((row) => row.pid === mainPid);
      assert.ok(keyring && keyring.appName === "code-shell" && keyring.mockKeychain === false);
      receipt = {
        mainPid,
        workers,
        keyring,
        receipts: receipts.filter((row) => row.pid === mainPid || row.ppid === mainPid),
      };
      break;
    }
    if (attempt >= 150) throw new Error("Cold Main confinement receipt missing");
    await new Promise((done) => setTimeout(done, 100));
  }
  const win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1440, height: 980 });
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "en");
    window.dispatchEvent(new Event("codeshell:language-changed"));
  });
  await navigateSettingsMenu(win, "Task center", { activity: true });
  const card = win.locator(`[data-task-key="session:${config.sessionId}"]`);
  await card.waitFor({ timeout: 20_000 });
  await card.getByRole("button", { name: "Review uncertain external writes", exact: true }).click();
  await card
    .getByText(
      config.hookNegative
        ? /Configured tool hooks/
        : /Current state matches; this does not prove the original write succeeded/,
    )
    .waitFor();
  assert.equal(
    await card.getByRole("button", { name: "Accept after manual review…", exact: true }).count(),
    1,
  );
  assert.equal(errors.length, 0);
  assert.doesNotMatch(await card.innerText(), /synthetic-account|synthetic-grant/);
  if (lateRoot) {
    const ledgerPath = join(isolated.codeShellHome, "sessions/.operations/ledger.json");
    const before = JSON.parse(await readFile(ledgerPath, "utf8"));
    const originalCount = Object.values(before.observations ?? {}).flat().length;
    const changedRoot = join(home, "late-native-state-root");
    await mkdir(join(changedRoot, "serve/project-runtime-secrets/fixture"), { recursive: true });
    await mkdir(join(changedRoot, "desktop"), { recursive: true });
    for (const name of ["projects.json", "trust.json"])
      await writeFile(
        join(changedRoot, "desktop", name),
        await readFile(join(isolated.codeShellHome, "desktop", name)),
      );
    await mkdir(join(changedRoot, "sessions"), { recursive: true });
    await cp(
      join(isolated.codeShellHome, "sessions", config.sessionId),
      join(changedRoot, "sessions", config.sessionId),
      { recursive: true },
    );
    await writeFile(
      join(changedRoot, "serve/project-runtime-secrets/fixture/runtime.json"),
      '{"synthetic":"credential-container"}',
    );
    await app.evaluate(({ dialog }, changedRoot) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      // A trusted native-process environment change after startup reproduces
      // late login-shell state-root adoption. This does not claim the shell ran.
      process.env.CODE_SHELL_HOME = changedRoot;
    }, changedRoot);
    // Mint a new existing IPC preview under the changed synthetic registries;
    // otherwise the old preview correctly rejects registry identity first.
    await card
      .getByRole("button", { name: "Review uncertain external writes", exact: true })
      .click();
    await card
      .getByRole("button", { name: "Review uncertain external writes", exact: true })
      .click();
    await card.getByRole("button", { name: "Read-only review…", exact: true }).waitFor();
    await card.getByRole("button", { name: "Read-only review…", exact: true }).click();
    let observed;
    for (let attempt = 0; ; attempt++) {
      const after = JSON.parse(await readFile(ledgerPath, "utf8"));
      const rows = Object.values(after.observations ?? {}).flat();
      if (
        rows.length === originalCount + 1 &&
        (await card.getByRole("button", { name: "Read-only review…", exact: true }).isEnabled())
      ) {
        observed = rows.at(-1);
        assert.equal(observed.result, "hooks_unavailable");
        assert.deepEqual(after.records, before.records);
        break;
      }
      if (attempt > 150) throw new Error("Cold native writer-root drift observation missing");
      await new Promise((done) => setTimeout(done, 100));
    }
    // Restoring the ambient value cannot repair this lifetime's native custody.
    await app.evaluate((_electron, stateRoot) => {
      process.env.CODE_SHELL_HOME = stateRoot;
    }, isolated.codeShellHome);
    await card
      .getByRole("button", { name: "Review uncertain external writes", exact: true })
      .click();
    await card
      .getByRole("button", { name: "Review uncertain external writes", exact: true })
      .click();
    await card.getByRole("button", { name: "Read-only review…", exact: true }).waitFor();
    await card.getByRole("button", { name: "Read-only review…", exact: true }).click();
    for (let attempt = 0; ; attempt++) {
      const after = JSON.parse(await readFile(ledgerPath, "utf8"));
      const rows = Object.values(after.observations ?? {}).flat();
      if (
        rows.length === originalCount + 2 &&
        (await card.getByRole("button", { name: "Read-only review…", exact: true }).isEnabled())
      ) {
        assert.equal(rows.at(-1).result, "hooks_unavailable");
        assert.deepEqual(after.records, before.records);
        break;
      }
      if (attempt > 150) throw new Error("Cold native writer-root sticky rejection missing");
      await new Promise((done) => setTimeout(done, 100));
    }
    receipt.lateRoot = {
      initial: isolated.codeShellHome,
      changed: changedRoot,
      unavailable: observed.result,
      restoredStillUnavailable: true,
      mechanism:
        "Actual native process.env change after cold Main startup, matching the checked late-writer-root condition; no claim that a login shell executed.",
    };
  }
  await win.screenshot({ path: join(home, "evidence/cold-restart.png") });
  await writeFile(
    join(home, lateRoot ? "evidence/cold-main-late-root.json" : "evidence/cold-main.json"),
    JSON.stringify(receipt, null, 2),
  );
} finally {
  await app?.close();
}
