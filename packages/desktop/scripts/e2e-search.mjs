/*
 * Real Electron search and command-palette regression suite. Uses an isolated
 * home and synthetic conversation metadata; never calls a model or reads a
 * developer profile. CODESHELL_SEARCH_SCREENSHOT_DIR enables optional previews.
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
  seedSessionCatalog,
  waitForSessionCatalogSelection,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-search-e2e-");
const screenshotDir = process.env.CODESHELL_SEARCH_SCREENSHOT_DIR;
let app;

async function waitForSelectedVisible(win) {
  await win.waitForFunction(
    () => {
      const selected = document.querySelector('[role="option"][aria-selected="true"]');
      if (!selected) return false;
      const item = selected.getBoundingClientRect();
      const list = selected.closest('[role="listbox"]').getBoundingClientRect();
      return item.top >= list.top - 1 && item.bottom <= list.bottom + 1;
    },
    undefined,
    { timeout: 5000 },
  );
}

async function screenshot(win, name) {
  if (!screenshotDir) return;
  await win.screenshot({ path: join(screenshotDir, name), scale: "css", animations: "disabled" });
}

try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  const win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  const trust = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  )
    await trust.click();

  // These are local drafts, so selecting one needs no engine session or model.
  const sessions = Array.from({ length: 24 }, (_, index) => ({
    id: `ui-search-${index + 1}`,
    title: `界面任务 ${String(index + 1).padStart(2, "0")}`,
    createdAt: Date.now() - index * 60_000,
    updatedAt: Date.now() - index * 60_000,
  }));
  sessions.push({
    id: "ui-search-archived",
    title: "界面任务 archived",
    createdAt: 1,
    updatedAt: 1,
    archived: true,
  });
  await seedSessionCatalog(win, {
    __no_repo__: { sessions, activeSessionId: null },
  });
  await win.reload();
  await win.getByRole("button", { name: "搜索", exact: true }).waitFor();
  const searchButton = win.getByRole("button", { name: "搜索", exact: true });
  const openSearch = async () => {
    await win.waitForFunction(() => {
      const toggle = document.querySelector('[data-sidebar-action="toggle"]');
      return (toggle?.getAttribute("aria-haspopup") === "dialog") === window.innerWidth < 640;
    });
    if (!(await searchButton.isVisible())) {
      await win.getByRole("button", { name: "展开侧栏", exact: true }).click();
      await win.getByRole("dialog", { name: "导航", exact: true }).waitFor();
    }
    await searchButton.focus();
    await searchButton.click();
    const dialog = win.getByRole("dialog", { name: "搜索对话", exact: true });
    await dialog.waitFor();
    return dialog;
  };

  await win.setViewportSize({ width: 1280, height: 820 });
  let dialog = await openSearch();
  let input = dialog.getByRole("combobox");
  assert(
    await input.evaluate((element) => element === document.activeElement),
    "Search must receive focus",
  );
  await input.press("Tab");
  assert(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    "Tab navigation must remain in the modal",
  );
  await win.keyboard.press("Shift+Tab");
  assert(
    await input.evaluate((element) => element === document.activeElement),
    "Reverse tab navigation must return to the search input",
  );
  await input.fill("界面任务");
  const options = dialog.getByRole("option");
  await options.last().waitFor();
  assert(
    (await options.count()) === 24,
    "Title results must include all matches and exclude archived drafts",
  );
  await input.press("End");
  await win.waitForFunction(() =>
    document
      .querySelector('[role="option"][aria-selected="true"]')
      ?.textContent?.includes("界面任务 24"),
  );
  await waitForSelectedVisible(win);
  await screenshot(win, "conversation-search.png");
  if (screenshotDir) {
    await input.press("Home");
    await waitForSelectedVisible(win);
    await screenshot(win, "conversation-search.png");
    await win.evaluate(() => document.documentElement.classList.add("dark"));
    await screenshot(win, "conversation-search-dark.png");
    await win.evaluate(() => document.documentElement.classList.remove("dark"));
  }
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    bubbles: true,
  });
  assert(await dialog.isVisible(), "IME confirmation must not open a conversation");
  const background = await win.evaluate(() => localStorage.getItem("codeshell.view"));
  await input.press("Meta+b");
  assert(
    (await win.evaluate(() => localStorage.getItem("codeshell.view"))) === background,
    "Modal input must not toggle background UI",
  );
  await input.press("Home");
  await input.press("ArrowDown");
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await waitForSessionCatalogSelection(win, "__no_repo__", "ui-search-2");

  dialog = await openSearch();
  input = dialog.getByRole("combobox");
  await input.fill("no-matching-conversation");
  await dialog.getByText("没有匹配的对话", { exact: true }).waitFor();
  await input.press("ArrowDown");
  await input.press("Enter");
  assert(await dialog.isVisible(), "An empty list must not select a conversation");
  await input.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await win.waitForFunction(() => document.activeElement?.textContent?.trim() === "搜索");

  // Drive the real preload IPC method with deterministic search outcomes.
  await app.evaluate(({ ipcMain }) => {
    let failed = false;
    ipcMain.removeHandler("session:content-search");
    ipcMain.handle("session:content-search", (_event, query) => {
      if (query === "重试" && !failed) {
        failed = true;
        throw new Error("search fixture unavailable");
      }
      return {
        matches: [
          {
            sessionId: "ui-search-3",
            title: "界面任务 03",
            cwd: null,
            updatedAt: Date.now(),
            snippets: [{ text: `找到内容：${query}`, turnNumber: 1 }],
          },
        ],
        scannedSessions: 24,
        truncated: false,
      };
    });
  });
  dialog = await openSearch();
  await dialog.getByRole("button", { name: "对话内容", exact: true }).click();
  input = dialog.getByRole("combobox");
  await input.fill("重试");
  await dialog.getByText("搜索暂时失败，请重试。", { exact: true }).waitFor();
  const retry = dialog.getByRole("button", { name: "重试", exact: true });
  await retry.focus();
  await retry.press("Enter");
  await dialog.getByRole("option", { name: /界面任务 03/ }).waitFor();
  await input.focus();
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await waitForSessionCatalogSelection(win, "__no_repo__", "ui-search-3");

  for (const width of [680, 390]) {
    await win.setViewportSize({ width, height: 620 });
    dialog = await openSearch();
    input = dialog.getByRole("combobox");
    await input.fill("> 内容");
    await dialog.getByRole("option", { name: /界面任务 03/ }).waitFor();
    assert(
      (await dialog
        .getByRole("button", { name: "对话内容", exact: true })
        .getAttribute("aria-pressed")) === "true",
      "Legacy prefix should select content mode",
    );
    const bounds = await dialog.boundingBox();
    assert(
      bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 620,
      "Search must fit the viewport",
    );
    await screenshot(win, `conversation-search-${width}.png`);
    await input.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }

  await win.setViewportSize({ width: 1280, height: 820 });
  // This opener survives the resize below. The sidebar's own search button is
  // intentionally unmounted when narrow navigation closes.
  await win.locator('[data-sidebar-action="toggle"]').focus();
  await win.keyboard.press("Meta+k");
  const palette = win.getByRole("dialog", { name: "命令面板", exact: true });
  await palette.waitFor();
  const commandInput = palette.getByRole("combobox");
  await commandInput.press("End");
  await win.waitForFunction(() =>
    document
      .querySelector('[role="option"][aria-selected="true"]')
      ?.textContent?.includes("新窗口"),
  );
  if (screenshotDir) {
    await commandInput.press("Home");
    await waitForSelectedVisible(win);
  }
  await screenshot(win, "command-palette.png");
  if (screenshotDir) {
    await win.evaluate(() => document.documentElement.classList.add("dark"));
    await screenshot(win, "command-palette-dark.png");
    await win.evaluate(() => document.documentElement.classList.remove("dark"));
  }
  await commandInput.fill("搜索当前");
  await palette.getByRole("option").waitFor();
  await commandInput.press("Enter");
  await palette.waitFor({ state: "hidden" });
  const inlineSearch = win.getByRole("search");
  await inlineSearch.waitFor();
  await win.waitForFunction(() =>
    document.querySelector('[role="search"]')?.contains(document.activeElement),
  );
  await win.setViewportSize({ width: 390, height: 620 });
  const bounds = await inlineSearch.boundingBox();
  assert(
    bounds.x >= 0 && bounds.x + bounds.width <= 390,
    "Inline search must fit a narrow chat column",
  );
  await inlineSearch
    .getByRole("textbox")
    .dispatchEvent("keydown", { key: "Escape", code: "Escape", isComposing: true, bubbles: true });
  assert(await inlineSearch.isVisible(), "IME cancellation must not close inline search");
  await inlineSearch.getByRole("textbox").press("Escape");
  await inlineSearch.waitFor({ state: "hidden" });
  await win.waitForFunction(
    () => document.activeElement?.getAttribute("data-sidebar-action") === "toggle",
  );
  assert(errors.length === 0, `Renderer emitted ${errors.length} errors`);
  console.log(
    "CodeShell search Electron e2e: passed (focus, IME, scrolling, result selection, retry, shortcuts, narrow layouts)",
  );
} catch (error) {
  if (app) {
    const win = await findCodeShellWindow(app);
    await screenshot(win, "search-failure.png");
    console.error(
      await win.evaluate(() => ({
        focus: document.activeElement?.outerHTML.slice(0, 500),
        selected: document
          .querySelector('[role="option"][aria-selected="true"]')
          ?.getBoundingClientRect()
          .toJSON(),
        list: document.querySelector('[role="listbox"]')?.getBoundingClientRect().toJSON(),
        text: document.querySelector('[role="dialog"]')?.textContent?.slice(-1000),
      })),
    );
  }
  throw error;
} finally {
  await app?.close();
  await isolated.cleanup();
}
