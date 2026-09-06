/*
 * Real Electron workspace-page regression suite. Uses an isolated home and
 * synthetic automation / credential metadata without configuring a model.
 * Exercises navigation, cancel-only editing, keyboard focus, and responsive
 * light/dark layouts. CODESHELL_WORKSPACE_SCREENSHOT_DIR enables screenshots.
 */
/* global document, getComputedStyle, localStorage, window */
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
const isolated = await makeIsolatedElectronHome("codeshell-workspace-e2e-");
const screenshotDir = process.env.CODESHELL_WORKSPACE_SCREENSHOT_DIR;
let app;
let win;
let processLog = "";

async function screenshot(filename) {
  if (!screenshotDir) return;
  await win.screenshot({
    path: join(screenshotDir, filename),
    scale: "css",
    animations: "disabled",
  });
}

async function dismissTrustDialog() {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  const opened = await viewOnly
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) await viewOnly.click();
}

async function assertPageLayout(heading, label) {
  const metrics = await win.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  assert(
    metrics.content <= metrics.viewport + 1,
    `${label} overflowed horizontally: content=${metrics.content}, viewport=${metrics.viewport}`,
  );
  const box = await heading.boundingBox();
  assert(
    box && box.width > 0 && box.x >= -1 && box.x + box.width <= metrics.width + 1,
    `${label} page heading is missing or clipped horizontally`,
  );
  const overflowing = await win.evaluate(() =>
    Array.from(document.querySelectorAll("div, section, article, main, ul"))
      .filter((node) => {
        const style = getComputedStyle(node);
        return (
          node.getClientRects().length > 0 &&
          node.clientWidth > 0 &&
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          node.scrollWidth > node.clientWidth + 1
        );
      })
      .map((node) => ({
        tag: node.tagName,
        role: node.getAttribute("role"),
        width: node.clientWidth,
        content: node.scrollWidth,
      })),
  );
  assert(
    overflowing.length === 0,
    `${label} contains horizontal page overflow: ${JSON.stringify(overflowing)}`,
  );
}

async function installSyntheticMetadata() {
  // Only list handlers are replaced. Keyboard checks select / filter metadata
  // and cancel edits; they never save, delete, run, or connect an item.
  await app.evaluate(({ ipcMain }) => {
    const nextRun = Date.now() + 86_400_000;
    const base = {
      schedule: "0 9 * * *",
      prompt: "整理项目进度与待处理事项，生成一份简明摘要。",
      enabled: true,
      cwd: null,
      timezone: "Asia/Singapore",
      permissionLevel: "read-only",
      lastRun: null,
      nextRun,
      runCount: 0,
      createdAt: Date.now(),
      lastRunId: null,
      once: false,
      resumeSessionId: null,
    };
    ipcMain.removeHandler("automation:list");
    ipcMain.handle("automation:list", () => [
      { ...base, id: "ui-daily", name: "每日工作摘要" },
      {
        ...base,
        id: "ui-weekly",
        name: "每周计划与进度回顾",
        schedule: "0 10 * * 1",
        enabled: false,
      },
      {
        ...base,
        id: "ui-once",
        name: "发布前最后一次检查",
        schedule: new Date(nextRun).toISOString(),
        once: true,
        enabled: false,
      },
    ]);
    ipcMain.removeHandler("credentials:list");
    ipcMain.handle("credentials:list", () => [
      {
        id: "ui-work",
        type: "cookie",
        label: "工作账号",
        hasSecret: true,
        secretHint: "••••",
        meta: { platform: "Example", domain: "example.com" },
      },
      {
        id: "ui-notes",
        type: "cookie",
        label: "个人笔记",
        hasSecret: true,
        secretHint: "••••",
        meta: { platform: "Notes", domain: "notes.example.com" },
      },
      {
        id: "ui-api",
        type: "token",
        label: "开发环境服务",
        hasSecret: true,
        secretHint: "••••",
        exposeAsEnv: "DEV_API_TOKEN",
      },
      { id: "ui-docs", type: "token", label: "文档服务", hasSecret: false },
    ]);
  });
}

async function checkCredentialsKeyboard(win) {
  const cookieTab = win.locator('[role="tab"][id$="-tab-cookie"]');
  const tokenTab = win.locator('[role="tab"][id$="-tab-token"]');
  const cookiePage = win.locator("[data-cookie-page]");
  const tokenPage = win.locator("[data-token-page]");
  await cookieTab.focus();
  await cookieTab.press("ArrowRight");
  assert(
    await tokenTab.evaluate((node) => node === document.activeElement),
    "Credential arrow key moves focus to Token",
  );
  assert(
    (await cookieTab.getAttribute("aria-selected")) === "true",
    "Arrow key retains the active Cookie category",
  );
  assert(
    (await tokenTab.getAttribute("aria-selected")) === "false",
    "Arrow key does not activate Token",
  );
  assert(
    (await cookiePage.isVisible()) && (await tokenPage.count()) === 0,
    "Arrow navigation does not remount the credential page",
  );

  // The same tab nodes must retain focus when their grid changes to two columns.
  await win.setViewportSize({ width: 390, height: 700 });
  assert(
    await tokenTab.evaluate((node) => node === document.activeElement),
    "Credential tab focus survives the narrow layout",
  );
  await tokenTab.press("Enter");
  await tokenPage.waitFor({ state: "visible" });
  assert(
    (await tokenTab.getAttribute("aria-selected")) === "true",
    "Enter activates the focused Token category",
  );
  const panel = win.getByRole("tabpanel");
  assert(
    (await panel.getAttribute("aria-labelledby")) === (await tokenTab.getAttribute("id")),
    "Active credential panel is labelled by Token",
  );
  assert(
    (await tokenTab.getAttribute("aria-controls")) === (await panel.getAttribute("id")),
    "Token points to its active panel",
  );
  await tokenPage.getByRole("article", { name: "文档服务", exact: true }).waitFor();
  assert(
    (await tokenPage.getByRole("article").count()) === 2,
    "Both synthetic tokens are initially visible",
  );
  const search = tokenPage.getByRole("searchbox", {
    name: "搜索名称、引用键或环境变量",
    exact: true,
  });
  await search.fill("DEV_API_TOKEN");
  await tokenPage
    .getByRole("article", { name: "文档服务", exact: true })
    .waitFor({ state: "detached" });
  assert(
    (await tokenPage.getByRole("article").count()) === 1,
    "Environment variable query filters to one token",
  );
  assert(
    await tokenPage.getByRole("article", { name: "开发环境服务", exact: true }).isVisible(),
    "The matching token remains visible",
  );
  await tokenPage.getByRole("button", { name: "清空搜索", exact: true }).click();
  await tokenPage.getByRole("article", { name: "文档服务", exact: true }).waitFor();
  assert((await search.inputValue()) === "", "Clearing token search resets the value");
  assert(
    await search.evaluate((node) => node === document.activeElement),
    "Clearing token search restores focus to the field",
  );
  assert(
    (await tokenPage.getByRole("article").count()) === 2,
    "Clearing token search restores both tokens",
  );
  await win.setViewportSize({ width: 1280, height: 820 });
  console.log(
    "PASS: credential keyboard activation, responsive focus, metadata filtering, and clear-search focus",
  );
}

async function checkAutomationKeyboard(win) {
  const jobs = win.getByRole("list", { name: "自动化任务", exact: true });
  const weekly = jobs.getByRole("button", { name: /^每周计划与进度回顾/ });
  const once = jobs.getByRole("button", { name: /^发布前最后一次检查/ });
  await weekly.focus();
  await weekly.press("Enter");
  const weeklyDetail = win.getByRole("region", { name: "每周计划与进度回顾", exact: true });
  await weeklyDetail.getByRole("heading", { name: "每周计划与进度回顾", exact: true }).waitFor();
  assert(
    (await weekly.getAttribute("aria-pressed")) === "true",
    "Enter selects the second automation",
  );
  assert(
    await weeklyDetail.getByText("已暂停", { exact: true }).isVisible(),
    "Selected paused automation has a text status",
  );

  await once.focus();
  await once.press("Space");
  const detail = win.getByRole("region", { name: "发布前最后一次检查", exact: true });
  await detail.getByRole("heading", { name: "发布前最后一次检查", exact: true }).waitFor();
  assert(
    (await once.getAttribute("aria-pressed")) === "true" &&
      (await weekly.getAttribute("aria-pressed")) === "false",
    "Space selects the third automation and deselects the previous job",
  );
  assert(
    (await once.innerText()).includes("一次性"),
    "One-time schedule is identified in the list",
  );
  const detailSchedule = await detail.locator("p").first().innerText();
  assert(
    detailSchedule.startsWith("一次性") && !detailSchedule.includes("每天"),
    "One-time detail uses its one-time label instead of a recurring cadence",
  );

  const instructions = detail.getByRole("region", { name: "任务指令", exact: true });
  const originalPrompt = await instructions.locator("pre").innerText();
  const edit = instructions.getByRole("button", { name: "编辑", exact: true });
  await edit.focus();
  await edit.press("Enter");
  const prompt = instructions.getByRole("textbox", { name: "任务指令", exact: true });
  await prompt.waitFor();
  assert(
    await prompt.evaluate((node) => node === document.activeElement),
    "Opening instructions moves focus into the labelled editor",
  );
  assert(
    (await prompt.inputValue()) === originalPrompt,
    "Instructions editor starts with the stored prompt",
  );
  await prompt.fill("仅用于隔离窗口的临时输入，不保存。");
  await instructions.getByRole("button", { name: "取消", exact: true }).click();
  await instructions.locator("pre").waitFor();
  assert(
    await edit.evaluate((node) => node === document.activeElement),
    "Cancelling instructions returns focus to Edit",
  );
  assert(
    (await instructions.locator("pre").innerText()) === originalPrompt,
    "Cancel preserves the original instructions",
  );
  await edit.press("Enter");
  await prompt.waitFor();
  assert(
    (await prompt.inputValue()) === originalPrompt,
    "Reopening instructions discards the cancelled draft",
  );
  await instructions.getByRole("button", { name: "取消", exact: true }).click();
  assert(
    await edit.evaluate((node) => node === document.activeElement),
    "Second cancel also returns focus to Edit",
  );
  console.log(
    "PASS: automation keyboard selection, one-time labels, and cancel-only instruction editing",
  );
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
  await win.locator("#root").waitFor({ state: "visible", timeout: 20_000 });
  await dismissTrustDialog();
  await installSyntheticMetadata();

  for (const page of [
    { label: "扩展", id: "extensions", title: "插件包" },
    { label: "凭证", id: "credentials", title: "凭证" },
    { label: "自动化", id: "automation", title: "自动化" },
  ]) {
    // Navigate at desktop width; narrow layouts keep their drawer closed and
    // must retain focus when the existing page changes its column arrangement.
    await win.setViewportSize({ width: 1280, height: 820 });
    await win.getByRole("button", { name: page.label, exact: true }).first().click();
    await win.waitForFunction(
      (id) => JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === id,
      page.id,
    );
    const heading = win.getByRole("heading", { name: page.title, level: 1, exact: true });
    await heading.waitFor({ state: "visible" });
    if (page.id === "automation") {
      await win.getByRole("heading", { name: "每日工作摘要", exact: true }).waitFor();
    }
    if (page.id === "credentials") {
      await win.getByRole("article", { name: "工作账号", exact: true }).waitFor();
    }

    for (const [width, height, suffix] of [
      [1280, 820, ""],
      [820, 700, "-compact"],
      [390, 700, "-narrow"],
    ]) {
      await win.setViewportSize({ width, height });
      for (const dark of [false, true]) {
        await win.evaluate(
          (enabled) => document.documentElement.classList.toggle("dark", enabled),
          dark,
        );
        await assertPageLayout(heading, `${page.id} at ${width}px (${dark ? "dark" : "light"})`);
        if (dark && page.id === "automation") {
          const time = win.locator('input[type="time"]');
          await time.waitFor({ state: "visible" });
          assert(
            (await time.evaluate((node) => getComputedStyle(node).colorScheme)) === "dark",
            `Native automation time input must use the dark color scheme at ${width}px`,
          );
        }
        await screenshot(`${page.id}${suffix}${dark ? "-dark" : ""}.png`);
      }
    }
    await win.evaluate(() => document.documentElement.classList.remove("dark"));
    await win.setViewportSize({ width: 1280, height: 820 });
    console.log(`PASS: ${page.id} heading and light/dark layouts at 1280, 820, and 390px`);
    if (page.id === "credentials") await checkCredentialsKeyboard(win);
    if (page.id === "automation") await checkAutomationKeyboard(win);
  }
  assert(errors.length === 0, "No renderer exceptions");
  console.log("PASS: workspace page layouts, native dark controls, and keyboard interactions");
} catch (error) {
  if (win) {
    await screenshot("workspace-failure.png").catch(() => undefined);
    console.error(
      (
        await win
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-5_000),
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
