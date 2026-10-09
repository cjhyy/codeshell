/* Pure Playwright controller: no Core, provider, credentials, or model imports. */
/* global Event, localStorage, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
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
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = {
  home,
  codeShellHome: join(home, ".code-shell"),
  userDataDir: join(home, "electron-user-data"),
};
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin: "http://127.0.0.1:9",
  guardModule: new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href,
});
fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(home, "cost-gui-guard.jsonl");
let app;
try {
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
    const receipts = (await readFile(fixture.env.CODESHELL_COST_GUI_GUARD_LOG, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const spawned = (await readFile(join(home, "spawned-workers.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    for (const row of receipts) {
      assert.equal(row.homeId, homeId);
      assert.equal(row.origin, "http://127.0.0.1:9");
      assert.equal(row.negativeProbes, 7);
    }
    const workers = spawned.filter((worker) =>
      receipts.some((row) => row.pid === worker.pid && row.ppid === mainPid),
    );
    if (receipts.some((row) => row.pid === mainPid)) {
      for (const worker of workers)
        await writeFile(join(home, `worker-${worker.pid}.permit`), "verified");
      receipt = {
        mainPid,
        workers,
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
  const card = win.locator('[data-task-key="session:operation-resolution-session"]');
  await card.waitFor({ timeout: 20_000 });
  await card.getByRole("button", { name: "Review uncertain external writes", exact: true }).click();
  await card
    .getByText("Uncertainty accepted manually; result remains unknown", { exact: true })
    .waitFor();
  assert.equal(
    await card.getByRole("button", { name: "Accept after manual review…", exact: true }).count(),
    0,
  );
  assert.doesNotMatch(
    await card.innerText(),
    /PRIVATE_TITLE|PRIVATE_BODY|synthetic-account|synthetic-grant/,
  );
  assert.equal(errors.length, 0);
  await win.screenshot({ path: join(home, "evidence/cold-restart.png") });
  await writeFile(join(home, "evidence/cold-main.json"), JSON.stringify(receipt, null, 2));
} finally {
  await app?.close();
}
