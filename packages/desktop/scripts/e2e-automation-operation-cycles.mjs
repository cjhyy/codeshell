/* Real renderer → preload → Main Cron store. Only controlled mutation failures are injected. */
/* global window */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-automation-cycles-");
const evidence = join(isolated.home, "evidence");
await mkdir(evidence, { mode: 0o700 });
await mkdir(isolated.codeShellHome, { recursive: true });
await writeFile(
  join(isolated.codeShellHome, "settings.json"),
  JSON.stringify({ autoUpdates: false }),
  { mode: 0o600 },
);
const fixture = await prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin: "http://127.0.0.1:9",
});
const reports = [];
let app,
  win,
  stage = "launch";
try {
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: fixture.env,
    mainEntry: fixture.mainEntry,
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1100, height: 800 });
  const trust = win.getByRole("button", { name: /仅查看|View only/ });
  if (
    await trust.waitFor({ timeout: 1500 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
  const jobs = await win.evaluate(async () => {
    const result = [];
    for (const name of ["Cycle Alpha", "Cycle Beta"]) {
      const job = await window.codeshell.createAutomation({
        name,
        schedule: "0 0 1 1 *",
        prompt: "Synthetic reminder: do not execute a model turn.",
        timezone: "Asia/Singapore",
        permissionLevel: "read-only",
      });
      await window.codeshell.pauseAutomation(job.id);
      result.push(job);
    }
    return result;
  });
  await win.getByRole("button", { name: "自动化", exact: true }).click();
  const list = win.getByRole("list", { name: "自动化任务", exact: true });
  const select = async (name) => {
    await list.getByRole("button", { name: new RegExp("^" + name) }).click();
  };
  const detail = (name) => win.getByRole("region", { name, exact: true });
  const execution = (name) => detail(name).getByRole("region", { name: "执行方式", exact: true });
  await select("Cycle Alpha");
  stage = "unsaved binding mode must stay with its job";
  await execution("Cycle Alpha").getByRole("button", { name: "续接已有对话", exact: true }).click();
  await select("Cycle Beta");
  assert.equal(
    await execution("Cycle Beta")
      .getByRole("button", { name: "每次新建对话", exact: true })
      .getAttribute("aria-pressed"),
    "true",
    "Changing jobs cannot copy an unsaved execution-mode draft",
  );
  reports.push({ operation: "switch jobs with unsaved resume mode", result: "isolated" });
  stage = "late mutation failure belongs to its source job";
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("automation:update");
    const state = (globalThis.__automationCycles = { calls: [], pending: null, holdNext: true });
    ipcMain.removeHandler("automation:update");
    ipcMain.handle("automation:update", async (event, id, patch) => {
      state.calls.push({ id, patch });
      if (state.holdNext) {
        state.holdNext = false;
        await new Promise((resolve, reject) => {
          state.pending = { resolve, reject };
        });
      }
      return original(event, id, patch);
    });
  });
  await select("Cycle Alpha");
  const frequency = detail("Cycle Alpha").getByRole("combobox", { name: "频率", exact: true });
  await frequency.click();
  await win.getByRole("option", { name: "工作日", exact: true }).click();
  await app.evaluate(async () => {
    for (let i = 0; i < 100 && !globalThis.__automationCycles.pending; i++)
      await new Promise((r) => setTimeout(r, 10));
    if (!globalThis.__automationCycles.pending)
      throw new Error("Pending automation mutation was not reached");
  });
  assert.equal(await app.evaluate(() => globalThis.__automationCycles.calls.length), 1);
  await select("Cycle Beta");
  await app.evaluate(() =>
    globalThis.__automationCycles.pending.reject(new Error("Owned Alpha save failure")),
  );
  await win.waitForTimeout(100);
  assert.equal(
    await detail("Cycle Beta")
      .getByText(/Owned Alpha save failure/)
      .count(),
    0,
    "Alpha failure cannot appear in Beta",
  );
  await select("Cycle Alpha");
  await detail("Cycle Alpha")
    .getByRole("alert")
    .filter({ hasText: "Owned Alpha save failure" })
    .waitFor();
  reports.push({
    operation: "fail delayed Alpha save after selecting Beta",
    result: "error retained only for Alpha",
    rejectedMutationRequests: 1,
  });
  stage = "retry saved schedule reaches actual durable Cron store";
  await detail("Cycle Alpha").getByRole("combobox", { name: "频率", exact: true }).click();
  await win.getByRole("option", { name: "工作日", exact: true }).click();
  await win.waitForFunction(
    async (id) => (await window.codeshell.getAutomation(id)).schedule === "0 9 * * 1-5",
    jobs[0].id,
  );
  const durable = JSON.parse(await readFile(join(isolated.codeShellHome, "cron.json"), "utf8"));
  assert.ok(JSON.stringify(durable).includes(jobs[0].id));
  await win.reload();
  await select("Cycle Alpha");
  assert.equal(
    await detail("Cycle Alpha").getByRole("combobox", { name: "频率", exact: true }).textContent(),
    "工作日",
  );
  assert.deepEqual(errors, []);
  reports.push({
    operation: "retry schedule, reload renderer, read Cron file",
    result: "persisted without executing a model",
  });

  const readJob = (id) => win.evaluate((value) => window.codeshell.getAutomation(value), id);
  stage = "cancel prompt edit leaves durable job unchanged";
  await detail("Cycle Alpha").getByRole("button", { name: "编辑", exact: true }).click();
  await detail("Cycle Alpha")
    .getByRole("textbox", { name: "任务指令", exact: true })
    .fill("Cancelled draft");
  await detail("Cycle Alpha").getByRole("button", { name: "取消", exact: true }).click();
  assert.equal((await readJob(jobs[0].id)).prompt, jobs[0].prompt);
  reports.push({ operation: "cancel prompt edit", result: "no durable write" });

  stage = "failed prompt save preserves draft for retry";
  await app.evaluate(() => {
    globalThis.__automationCycles.holdNext = true;
    globalThis.__automationCycles.pending = null;
  });
  await detail("Cycle Alpha").getByRole("button", { name: "编辑", exact: true }).click();
  await detail("Cycle Alpha")
    .getByRole("textbox", { name: "任务指令", exact: true })
    .fill("Updated synthetic reminder");
  await detail("Cycle Alpha").getByRole("button", { name: "保存", exact: true }).click();
  await app.evaluate(async () => {
    for (let i = 0; i < 100 && !globalThis.__automationCycles.pending; i++)
      await new Promise((r) => setTimeout(r, 10));
    if (!globalThis.__automationCycles.pending) throw new Error("Prompt mutation was not reached");
    globalThis.__automationCycles.pending.reject(new Error("Owned prompt save failure"));
  });
  await detail("Cycle Alpha")
    .getByRole("alert")
    .filter({ hasText: "Owned prompt save failure" })
    .waitFor();
  assert.equal((await readJob(jobs[0].id)).prompt, jobs[0].prompt);
  await detail("Cycle Alpha").getByRole("button", { name: "编辑", exact: true }).click();
  assert.equal(
    await detail("Cycle Alpha")
      .getByRole("textbox", { name: "任务指令", exact: true })
      .inputValue(),
    "Updated synthetic reminder",
  );
  await detail("Cycle Alpha").getByRole("button", { name: "保存", exact: true }).click();
  await win.waitForFunction(
    async (id) =>
      (await window.codeshell.getAutomation(id)).prompt === "Updated synthetic reminder",
    jobs[0].id,
  );
  reports.push({
    operation: "fail prompt save and retry preserved draft",
    result: "original retained on failure; retry persisted",
  });

  stage = "toggle failure leaves enabled state unchanged and permits retry";
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("automation:resume");
    const state = (globalThis.__automationResume = { calls: 0 });
    ipcMain.removeHandler("automation:resume");
    ipcMain.handle("automation:resume", async (event, ...args) => {
      if (++state.calls === 1) throw new Error("Owned resume failure");
      return original(event, ...args);
    });
  });
  const enabled = detail("Cycle Alpha").getByRole("switch", { name: "启用此自动化", exact: true });
  await enabled.click();
  await detail("Cycle Alpha")
    .getByRole("alert")
    .filter({ hasText: "Owned resume failure" })
    .waitFor();
  assert.equal((await readJob(jobs[0].id)).enabled, false);
  await enabled.click();
  await win.waitForFunction(
    async (id) => (await window.codeshell.getAutomation(id)).enabled === true,
    jobs[0].id,
  );
  await enabled.click();
  await win.waitForFunction(
    async (id) => (await window.codeshell.getAutomation(id)).enabled === false,
    jobs[0].id,
  );
  reports.push({
    operation: "fail resume, retry, pause",
    result: "store and switch agree; no model turn started",
  });

  stage = "delete failure retains job and retry removes only its source";
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("automation:delete");
    const state = (globalThis.__automationDelete = { calls: 0 });
    ipcMain.removeHandler("automation:delete");
    ipcMain.handle("automation:delete", async (event, ...args) => {
      if (++state.calls === 1) throw new Error("Owned delete failure");
      return original(event, ...args);
    });
  });
  await select("Cycle Beta");
  const remove = detail("Cycle Beta").getByRole("button", { name: "删除自动化", exact: true });
  await remove.click();
  await detail("Cycle Beta")
    .getByRole("alert")
    .filter({ hasText: "Owned delete failure" })
    .waitFor();
  assert.equal((await readJob(jobs[1].id)).id, jobs[1].id);
  await remove.click();
  await win.waitForFunction(
    async (id) => !(await window.codeshell.listAutomations()).some((job) => job.id === id),
    jobs[1].id,
  );
  assert.equal((await readJob(jobs[0].id)).id, jobs[0].id);
  assert.deepEqual(errors, []);
  reports.push({
    operation: "fail delete and retry",
    result: "failed delete retained job; retry removed Beta only",
  });
  await win.screenshot({ path: join(evidence, "automation-cycles.png") });
  await writeFile(join(evidence, "report.json"), JSON.stringify({ reports, errors }, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ result: "pass", reports, evidence }));
} catch (error) {
  await win?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ stage, error: String(error) }, null, 2),
    { mode: 0o600 },
  );
  console.error("Automation cycles failed at", stage, "evidence", evidence);
  throw error;
} finally {
  await app?.close();
}
