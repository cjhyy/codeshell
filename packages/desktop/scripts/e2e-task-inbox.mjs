/*
 * Task center renderer/bridge acceptance in real Electron. Synthetic IPC sources
 * run under an isolated profile; no model, real task, or user data is changed.
 */
/* global document, localStorage, window */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-task-inbox-e2e-");
let app;
let win;
try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1280, height: 820 });
  const trust = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  )
    await trust.click();
  await app.evaluate(({ ipcMain }) => {
    const now = Date.now();
    const make = (id, status, patch = {}) => ({
      schemaVersion: 1,
      taskKey: `session:${id}`,
      source: "session",
      sourceId: id,
      title: `任务 ${id}`,
      status,
      createdAt: now - 1000,
      updatedAt: now,
      sourceRevision: "r1",
      artifacts: [],
      capabilities: ["open"],
      ...patch,
    });
    const fixture = (globalThis.__taskInboxFixture = {
      version: 1,
      actions: [],
      listCalls: 0,
      records: [
        make("waiting", "waiting", {
          capabilities: ["pause", "cancel", "retry"],
          workspacePath: "/workspace/one",
          summary: "等待审批后继续",
        }),
        make("running", "running", {
          source: "background-job",
          workspacePath: "/workspace/two",
          capabilities: ["cancel"],
        }),
        make("failure", "failed", { error: "来源错误示例", stale: true, capabilities: ["pause"] }),
        make("history", "done", {
          source: "legacy-run",
          sourceId: "run-fixture",
          capabilities: ["open"],
          summary: "历史运行结果",
        }),
        ...Array.from({ length: 2046 }, (_, index) =>
          make(`archive-${index}`, "done", { capabilities: [] }),
        ),
      ],
    });
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace("taskInbox:list", (_event, query = {}) => {
      fixture.listCalls += 1;
      const offset = Number(query.cursor ?? 0);
      const records = fixture.records.slice(offset, offset + 200);
      return {
        version: fixture.version,
        records,
        errors: [{ source: "automation", message: "synthetic partial outage" }],
        ...(offset + 200 < fixture.records.length ? { nextCursor: String(offset + 200) } : {}),
      };
    });
    replace("taskInbox:act", (_event, input) => {
      fixture.actions.push(input);
      return {
        status: "ok",
        record: fixture.records.find((record) => record.taskKey === input.taskKey),
      };
    });
    replace("runs:list", () => [
      {
        runId: "run-fixture",
        objective: "原始运行详情",
        status: "completed",
        cwd: "/workspace/one",
        createdAt: now - 1000,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        sessionId: null,
        error: null,
      },
    ]);
    replace("runs:get", (_event, id) => {
      if (id !== "run-fixture") throw new Error("Wrong original run selected");
      return {
        runId: id,
        objective: "原始运行详情",
        status: "completed",
        cwd: "/workspace/one",
        createdAt: now - 1000,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        sessionId: null,
        error: null,
        summary: "已选中准确的原始运行",
        prompt: null,
        model: null,
        provider: null,
        durationMs: null,
        usage: null,
        attemptCount: 1,
        latestCheckpointId: null,
        latestApprovalId: null,
        tags: [],
        metadata: {},
        checkpoints: [],
        artifacts: [],
        events: [],
      };
    });
  });
  await navigateSettingsMenu(win, "任务中心", { activity: true });
  await win.getByRole("heading", { name: "任务中心", level: 1 }).waitFor();
  await win.getByText("2050 项", { exact: true }).waitFor();
  assert(
    (await win.locator("article[data-task-key]").count()) === 53,
    "Rendering is bounded per group at 2050 records",
  );
  const headings = await win.locator("main h2").allTextContents();
  assert(
    headings[0].includes("等待处理") &&
      headings[1].includes("运行中") &&
      headings[2].includes("失败") &&
      headings[3].includes("已完成"),
    "Attention-first groups",
  );
  assert(
    (await win.getByText(/synthetic partial outage/).count()) === 1,
    "Partial source error is visible",
  );
  assert(
    await win.getByRole("button", { name: "暂停：任务 failure", exact: true }).isDisabled(),
    "Stale card does not offer writes",
  );
  const source = win.getByLabel("来源", { exact: true });
  await source.focus();
  await win.keyboard.press("b");
  await source.selectOption("background-job");
  assert(
    (await win.locator("article[data-task-key]").count()) === 1,
    "Source filter works with native keyboard-selectable control",
  );
  await source.selectOption("");
  await win.getByLabel("搜索任务标题", { exact: true }).fill("waiting");
  const cancel = win.getByRole("button", { name: "取消任务：任务 waiting", exact: true });
  await cancel.focus();
  await win.keyboard.press("Enter");
  const dialog = win.getByRole("dialog");
  await dialog.waitFor();
  assert(
    (await app.evaluate(() => globalThis.__taskInboxFixture.actions.length)) === 0,
    "Keyboard activation requires confirmation",
  );
  await win.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(
    await cancel.evaluate((node) => node === document.activeElement),
    "Confirmation cancellation restores keyboard focus",
  );
  await cancel.press("Enter");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const actions = await app.evaluate(() => globalThis.__taskInboxFixture.actions);
  assert(
    actions.length === 1 &&
      actions[0].taskKey === "session:waiting" &&
      actions[0].expectedRevision === "r1",
    "Confirmed action reaches preload with exact identity and revision",
  );
  await win.getByLabel("搜索任务标题", { exact: true }).fill("history");
  await win.getByRole("button", { name: "打开来源：任务 history", exact: true }).press("Enter");
  await win.getByRole("heading", { name: "运行记录", exact: true, level: 1 }).waitFor();
  await win.getByText("已选中准确的原始运行", { exact: true }).waitFor();
  console.log("PASS: original Run detail navigation");
  await navigateSettingsMenu(win, "任务中心", { activity: true });
  await win.getByText("2050 项", { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const fixture = globalThis.__taskInboxFixture;
    fixture.version += 1;
    fixture.records[0] = {
      ...fixture.records[0],
      title: "事件更新后的任务",
      status: "done",
      updatedAt: Date.now(),
      sourceRevision: "r2",
    };
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("taskInbox:changed", fixture.version);
  });
  await win.getByRole("heading", { name: "事件更新后的任务", exact: true, level: 3 }).waitFor();
  for (const width of [1280, 820, 390]) {
    await win.setViewportSize({ width, height: 760 });
    for (const lang of ["zh", "en"]) {
      await win.evaluate((value) => {
        localStorage.setItem("codeshell.uiLanguage", value);
        window.dispatchEvent(new window.Event("codeshell:language-changed"));
      }, lang);
      await navigateSettingsMenu(win, /^(任务中心|Task center)$/, { activity: true });
      await win.getByRole("heading", { name: /^(任务中心|Task center)/, level: 1 }).waitFor();
      const sizes = await win.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      assert(sizes.content <= sizes.viewport + 1, `Task center fits ${width}px (${lang})`);
      if (width === 390) {
        await win.locator('[data-sidebar-action="toggle"][aria-expanded="false"]').waitFor();
        assert(
          !(await win.getByRole("dialog", { name: /^(导航|Navigation)$/ }).isVisible()),
          `Task center navigation closes the narrow sidebar (${lang})`,
        );
      }
      const search = win.getByRole("textbox", { name: /^(搜索任务标题|Search task titles)$/ });
      await search.fill("事件更新后的任务");
      assert(
        (await win.locator("article[data-task-key]").count()) === 1,
        `Task controls remain usable after menu navigation at ${width}px (${lang})`,
      );
      await search.fill("");
    }
  }
  assert(errors.length === 0, `No renderer errors: ${errors.join("; ")}`);
  console.log(
    "PASS: task inbox 2050-record projection, four groups, source/search, stale/partial errors, keyboard confirmation, live refresh and settings activity navigation in Chinese/English at 1280, 820 and 390px",
  );
} catch (error) {
  if (win)
    console.error(
      (
        await win
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-6000),
    );
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
    await isolated.cleanup();
  }
}
