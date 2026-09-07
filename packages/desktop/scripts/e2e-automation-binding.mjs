/*
 * Real Electron regression for choosing an automation's conversation context.
 * Uses an isolated home and synthetic IPC metadata/mutations. No model is
 * configured, no prompt is sent, and no real automation is created or run.
 * CODESHELL_AUTOMATION_SCREENSHOT_DIR enables optional preview images.
 */
/* global document, getComputedStyle, localStorage */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-automation-binding-e2e-");
const screenshotDir = process.env.CODESHELL_AUTOMATION_SCREENSHOT_DIR;
const jobName = "每日工作摘要";
const localTitle = "工作进度与计划";
const diskTitle = "发布前的对话回顾";
let app;
let win;
let processLog = "";

const execution = () => win.getByRole("region", { name: "执行方式", exact: true });
const detail = () => win.getByRole("region", { name: jobName, exact: true });
const picker = () => execution().getByRole("combobox", { name: "绑定的对话", exact: true });
const save = () => execution().getByRole("button", { name: "保存执行方式", exact: true });
const mode = (name) => execution().getByRole("button", { name, exact: true });

async function screenshot(name) {
  if (screenshotDir) {
    await win.screenshot({
      path: join(screenshotDir, name),
      scale: "css",
      animations: "disabled",
    });
  }
}

async function dismissTrustDialog() {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await viewOnly.click();
  }
}

async function installFixture() {
  await app.evaluate(({ ipcMain }) => {
    const now = Date.now();
    const fixture = {
      job: {
        id: "ui-binding-job",
        name: "每日工作摘要",
        schedule: "0 9 * * *",
        prompt: "整理这段对话中的项目进度和待处理事项。",
        enabled: false,
        cwd: null,
        timezone: "Asia/Singapore",
        permissionLevel: "read-only",
        lastRun: null,
        nextRun: now + 86_400_000,
        runCount: 0,
        createdAt: now,
        lastRunId: null,
        once: false,
        resumeSessionId: null,
      },
      diskSessions: [
        {
          id: "disk-binding-review",
          engineSessionId: "engine-binding-review",
          cwd: "/fixture/发布项目",
          title: "发布前的对话回顾",
          updatedAt: now - 60_000,
          origin: "desktop",
        },
        {
          id: "disk-binding-child",
          engineSessionId: "engine-binding-child",
          cwd: "/fixture/发布项目",
          title: "不应出现在选择器的子任务",
          updatedAt: now - 120_000,
          origin: "subagent",
          parentSessionId: "engine-binding-review",
        },
      ],
      updates: [],
      failNextSave: false,
      holdNextSave: false,
      releaseSave: null,
      runAttempts: 0,
      transcriptReads: [],
    };
    globalThis.__automationBindingFixture = fixture;
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace("automation:list", () => [{ ...fixture.job }]);
    replace("automation:get", (_event, id) => (id === fixture.job.id ? { ...fixture.job } : null));
    replace("automation:update", async (_event, id, patch) => {
      fixture.updates.push({ id, patch });
      if (id !== fixture.job.id) throw new Error("Unexpected non-fixture automation update");
      if (fixture.holdNextSave) {
        fixture.holdNextSave = false;
        await new Promise((resolveSave) => {
          fixture.releaseSave = resolveSave;
        });
        fixture.releaseSave = null;
      }
      if (fixture.failNextSave) {
        fixture.failNextSave = false;
        throw new Error("synthetic binding save failure");
      }
      fixture.job = { ...fixture.job, ...patch };
      if (patch.resumeSessionId === "engine-binding-review") {
        fixture.job.cwd = "/fixture/发布项目";
      }
      return true;
    });
    replace("automation:runNow", () => {
      fixture.runAttempts += 1;
      throw new Error("Automation execution is forbidden in this metadata-only fixture");
    });
    replace("runs:list", () => []);
    replace("sessions:list", () => []);
    replace("sessions:titles", () => ({}));
    replace("sessions:listDisk", () => ({ sessions: fixture.diskSessions, nextCursor: null }));
    replace("sessions:transcript", (_event, sessionId) => {
      fixture.transcriptReads.push(sessionId);
      return [];
    });
    replace("sessions:transcriptPage", () => ({ items: [], loadedBytes: 0, hasMore: false }));
    replace("agent:subscribe", () => ({ events: [], nextSeq: 0, topLevelRunning: false }));
  });
  await win.evaluate(() => {
    const now = Date.now();
    localStorage.setItem(
      "codeshell.sessionIndex.__no_repo__",
      JSON.stringify({
        activeSessionId: null,
        sessions: [
          {
            id: "ui-binding-local",
            engineSessionId: "engine-binding-local",
            title: "工作进度与计划",
            createdAt: now - 3_600_000,
            updatedAt: now,
          },
          {
            id: "ui-binding-draft",
            title: "尚未开始的草稿对话",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "ui-binding-archived",
            engineSessionId: "engine-binding-archived",
            title: "已经归档的旧对话",
            createdAt: now - 86_400_000,
            updatedAt: now - 86_400_000,
            archived: true,
          },
        ],
      }),
    );
  });
}

async function fixtureState() {
  return app.evaluate(() => ({
    job: globalThis.__automationBindingFixture.job,
    updates: globalThis.__automationBindingFixture.updates,
    runAttempts: globalThis.__automationBindingFixture.runAttempts,
  }));
}

async function openAutomations() {
  await win.setViewportSize({ width: 1280, height: 820 });
  await win.getByRole("button", { name: "自动化", exact: true }).first().click();
  await detail().getByRole("heading", { name: jobName, exact: true }).waitFor();
  await execution().waitFor();
}

async function selectConversation(title, searchText = title) {
  await picker().click();
  const search = win.getByPlaceholder("搜索对话标题或项目…", { exact: true });
  await search.fill(searchText);
  await win.getByRole("option", { name: new RegExp(title) }).click();
  await search.waitFor({ state: "hidden" });
  assert((await picker().innerText()).includes(title), `Conversation picker selected ${title}`);
}

async function assertUpdate(count, resumeSessionId) {
  const state = await fixtureState();
  assert(
    state.updates.length === count,
    `Expected ${count} update calls, got ${state.updates.length}`,
  );
  const last = state.updates.at(-1);
  assert(last.id === "ui-binding-job", "Update targets the selected automation");
  assert(
    JSON.stringify(last.patch) === JSON.stringify({ resumeSessionId }),
    `Binding update must contain only the durable session ID: ${JSON.stringify(last.patch)}`,
  );
  assert(state.job.resumeSessionId === resumeSessionId, "Binding was persisted by the host");
  assert(
    state.job.permissionLevel === "read-only",
    "Changing context does not silently raise the saved permission level",
  );
}

async function waitForSaved() {
  // The save button changes its name during IPC. Draft controls disappear only
  // after the host's stored automation has been reloaded successfully.
  await execution().getByRole("button", { name: "取消", exact: true }).waitFor({ state: "hidden" });
}

async function checkLayouts(label, withPicker = false) {
  for (const width of [1280, 390]) {
    await win.setViewportSize({ width, height: 820 });
    for (const dark of [false, true]) {
      await win.evaluate(
        (enabled) => document.documentElement.classList.toggle("dark", enabled),
        dark,
      );
      await execution().scrollIntoViewIfNeeded();
      if (withPicker) await picker().click();
      const overflow = await win.evaluate(() => ({
        page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        nested: Array.from(document.querySelectorAll("div, section, article, main, ul"))
          .filter((node) => {
            const style = getComputedStyle(node);
            return (
              node.getClientRects().length > 0 &&
              node.clientWidth > 0 &&
              ["auto", "scroll"].includes(style.overflowX) &&
              node.scrollWidth > node.clientWidth + 1
            );
          })
          .map((node) => ({
            role: node.getAttribute("role"),
            width: node.clientWidth,
            content: node.scrollWidth,
          })),
      }));
      assert(
        !overflow.page && overflow.nested.length === 0,
        `${label} ${width}px ${dark ? "dark" : "light"} overflow: ${JSON.stringify(overflow)}`,
      );
      for (const control of [mode("每次新建对话"), mode("续接已有对话"), picker()]) {
        const box = await control.boundingBox();
        assert(
          box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
          `${label} execution control is clipped at ${width}px`,
        );
      }
      if (withPicker) {
        const popup = win.getByRole("listbox");
        const box = await popup.boundingBox();
        assert(
          box && box.x >= -1 && box.x + box.width <= width + 1,
          `Conversation search popup is clipped at ${width}px`,
        );
      }
      await screenshot(`${label}-${width}${dark ? "-dark" : "-light"}.png`);
      if (withPicker) await win.keyboard.press("Escape");
    }
  }
  await win.setViewportSize({ width: 1280, height: 820 });
  await win.evaluate(() => document.documentElement.classList.remove("dark"));
  console.log(`PASS: ${label} light/dark layouts at 1280 and 390px`);
}

async function checkBinding() {
  assert(
    (await mode("每次新建对话").getAttribute("aria-pressed")) === "true",
    "Fresh mode is selected",
  );
  assert((await picker().count()) === 0, "Fresh runs do not require a conversation");
  await mode("续接已有对话").click();
  await picker().waitFor();
  assert(await save().isDisabled(), "Cannot save resume mode without a durable conversation");

  await picker().click();
  const search = win.getByPlaceholder("搜索对话标题或项目…", { exact: true });
  await search.waitFor();
  assert(
    (await win.getByRole("option", { name: /尚未开始的草稿对话/ }).count()) === 0,
    "Draft sessions are excluded",
  );
  assert(
    (await win.getByRole("option", { name: /已经归档的旧对话/ }).count()) === 0,
    "Archived sessions are excluded",
  );
  assert(
    (await win.getByRole("option", { name: /不应出现在选择器的子任务/ }).count()) === 0,
    "Subagent sessions are excluded",
  );
  await search.fill("没有这个对话的搜索结果");
  await win.getByText("没有匹配的对话", { exact: true }).waitFor();
  assert((await win.getByRole("option").count()) === 0, "Unmatched query produces an empty list");
  await win.keyboard.press("Escape");
  await selectConversation(localTitle);
  assert(
    (await fixtureState()).updates.length === 0,
    "Choosing a conversation only changes the draft",
  );
  await execution().getByRole("button", { name: "取消", exact: true }).click();
  assert(
    (await mode("每次新建对话").getAttribute("aria-pressed")) === "true",
    "Cancel restores fresh mode",
  );
  assert((await fixtureState()).updates.length === 0, "Cancel does not submit an update");

  await mode("续接已有对话").click();
  await selectConversation(localTitle);
  await app.evaluate(() => {
    globalThis.__automationBindingFixture.holdNextSave = true;
  });
  await save().click();
  await execution().getByRole("button", { name: "保存中…", exact: true }).waitFor();
  for (const control of [
    mode("每次新建对话"),
    mode("续接已有对话"),
    picker(),
    detail().getByRole("button", { name: "立即运行", exact: true }),
    detail().getByRole("combobox", { name: "频率", exact: true }),
    detail().getByRole("combobox", { name: "权限", exact: true }),
    detail().getByRole("combobox", { name: "项目", exact: true }),
    detail().getByLabel("运行时间", { exact: true }),
  ]) {
    assert(
      await control.isDisabled(),
      "Running and changing configuration are blocked until binding saves",
    );
  }
  await app.evaluate(() => {
    globalThis.__automationBindingFixture.releaseSave();
  });
  await waitForSaved();
  await assertUpdate(1, "engine-binding-local");
  assert(
    (await mode("续接已有对话").getAttribute("aria-pressed")) === "true",
    "Saved resume mode remains selected",
  );
  await detail()
    .getByRole("button", { name: /打开对话/ })
    .waitFor();
  assert(
    await detail().getByText("沿用绑定对话的权限和工具设置", { exact: true }).isVisible(),
    "Bound automation describes its inherited permissions",
  );
  assert(
    await detail().getByText("跟随绑定的对话", { exact: true }).isVisible(),
    "Bound automation describes its inherited project",
  );
  assert(
    (await detail().getByRole("combobox", { name: "权限", exact: true }).count()) === 0 &&
      (await detail().getByRole("combobox", { name: "项目", exact: true }).count()) === 0,
    "Inherited project and permissions do not expose independent editing controls",
  );
  console.log("PASS: engine-ID binding, binding-only patches, cancel, and pending-save guards");

  await checkLayouts("automation-bound");
  await checkLayouts("automation-session-picker", true);
  await win.reload();
  await execution().waitFor();
  assert(
    (await picker().innerText()).includes(localTitle),
    "Persisted binding survives renderer reload",
  );
  assert(
    (await mode("续接已有对话").getAttribute("aria-pressed")) === "true",
    "Reload retains resume mode",
  );
  await detail()
    .getByRole("button", { name: /打开对话/ })
    .click();
  await win.waitForFunction(() => {
    const index = JSON.parse(localStorage.getItem("codeshell.sessionIndex.__no_repo__") || "{}");
    const view = JSON.parse(localStorage.getItem("codeshell.view") || "{}");
    return index.activeSessionId === "ui-binding-local" && view.viewMode === "chat";
  });
  await openAutomations();
  console.log("PASS: binding survives reload and opens the correct local UI conversation");

  await selectConversation(diskTitle, "发布项目");
  await app.evaluate(() => {
    globalThis.__automationBindingFixture.failNextSave = true;
  });
  await save().click();
  await detail().getByRole("alert").filter({ hasText: "synthetic binding save failure" }).waitFor();
  assert(
    (await picker().innerText()).includes(diskTitle),
    "Rejected save retains the new draft conversation",
  );
  assert(await save().isEnabled(), "Rejected save can be retried");
  assert(
    (await fixtureState()).job.resumeSessionId === "engine-binding-local",
    "Rejected save preserves previous binding",
  );
  assert(
    await detail().getByRole("heading", { name: jobName, exact: true }).isVisible(),
    "Save error keeps the task detail mounted",
  );
  await save().click();
  await waitForSaved();
  await assertUpdate(3, "engine-binding-review");
  assert(
    (await detail().getByRole("alert").count()) === 0,
    "Successful retry clears the inline error",
  );
  assert(
    (await fixtureState()).job.cwd === "/fixture/发布项目",
    "Rebinding uses the host-derived project for the selected disk conversation",
  );
  console.log(
    "PASS: project search, disk-session rebind, rejected-save draft preservation, and retry",
  );

  await app.evaluate(() => {
    globalThis.__automationBindingFixture.failNextSave = true;
  });
  await mode("每次新建对话").click();
  await save().click();
  await detail().getByRole("alert").filter({ hasText: "synthetic binding save failure" }).waitFor();
  await execution().getByRole("button", { name: "取消", exact: true }).click();
  assert(
    (await detail().getByRole("alert").count()) === 0,
    "Cancelling a failed edit clears its error",
  );
  assert(
    (await picker().innerText()).includes(diskTitle),
    "Cancel restores the saved disk binding",
  );
  assert((await fixtureState()).updates.length === 4, "Cancelling a failed edit does not resubmit");

  await mode("每次新建对话").click();
  await save().click();
  await waitForSaved();
  await assertUpdate(5, null);
  assert((await picker().count()) === 0, "Unbinding restores fresh-run configuration");
  assert(
    await detail().getByRole("combobox", { name: "权限", exact: true }).isEnabled(),
    "Unbinding restores the independent permission control",
  );
  assert(
    await detail().getByRole("combobox", { name: "项目", exact: true }).isEnabled(),
    "Unbinding restores the independent project control",
  );
  await win.reload();
  await execution().waitFor();
  assert(
    (await mode("每次新建对话").getAttribute("aria-pressed")) === "true",
    "Unbinding survives reload",
  );
  console.log("PASS: unbind persists null and restores fresh conversations");
}

async function checkNoResumableSessions() {
  await app.evaluate(() => {
    globalThis.__automationBindingFixture.diskSessions = [];
  });
  await win.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("codeshell.sessionIndex.")) localStorage.removeItem(key);
    }
    localStorage.setItem(
      "codeshell.sessionIndex.__no_repo__",
      JSON.stringify({
        activeSessionId: null,
        sessions: [
          {
            id: "ui-only-draft",
            title: "尚未开始的草稿对话",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    );
  });
  await win.reload();
  await execution().waitFor();
  await mode("续接已有对话").click();
  assert(await save().isDisabled(), "No persisted conversations keeps Save disabled");
  await execution()
    .getByText("还没有可绑定的对话。先在聊天中发送一条消息，再回到这里选择。", { exact: true })
    .waitFor();
  await picker().click();
  await win.getByPlaceholder("搜索对话标题或项目…", { exact: true }).waitFor();
  assert(
    (await win.getByRole("option").count()) === 0,
    "Draft-only account has no resumable options",
  );
  await screenshot("automation-no-resumable-conversations.png");
  await win.keyboard.press("Escape");
  assert((await fixtureState()).updates.length === 5, "Empty picker does not submit an update");
  console.log("PASS: draft-only sessions cannot be saved as automation context");
}

try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    `${JSON.stringify({ autoUpdates: false })}\n`,
    { mode: 0o600 },
  );
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  app.process().stderr?.on("data", (chunk) => {
    processLog = (processLog + chunk.toString()).slice(-16_000);
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1280, height: 820 });
  await dismissTrustDialog();
  await installFixture();
  await win.reload();
  await openAutomations();
  await checkBinding();
  await checkNoResumableSessions();
  assert((await fixtureState()).runAttempts === 0, "No automation was executed");
  assert(errors.length === 0, "No renderer exceptions");
  console.log("PASS: automation conversation binding and responsive layouts");
} catch (error) {
  if (win) {
    await screenshot("automation-binding-failure.png").catch(() => undefined);
    console.error(
      (
        await win
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-8_000),
    );
  }
  if (processLog) console.error("Electron output:", processLog.slice(-8_000));
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
    await isolated.cleanup();
  }
}
