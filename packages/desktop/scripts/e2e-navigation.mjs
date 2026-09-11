/*
 * Real Electron navigation regression: narrow drawers preserve desktop sidebar
 * preferences and keep focus through dismissal, page navigation, and search.
 * Uses an isolated empty profile. Optional screenshots are local previews.
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
  seedSessionCatalog,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-navigation-e2e-");
const screenshotDir = process.env.CODESHELL_NAVIGATION_SCREENSHOT_DIR;
let app;

async function screenshot(win, name) {
  if (screenshotDir)
    await win.screenshot({ path: join(screenshotDir, name), scale: "css", animations: "disabled" });
}

async function desktopPreference(win) {
  return win.evaluate(
    () => JSON.parse(localStorage.getItem("codeshell.view") || "{}").sidebarCollapsed ?? false,
  );
}

async function waitForToggleFocus(win) {
  await win.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "展开侧栏",
  );
}

async function expectMenuInsideWindow(win, name) {
  await win.waitForFunction((label) => {
    const menu = document.querySelector(`[role="menu"][aria-label="${label}"]`);
    if (!menu) return false;
    const rect = menu.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.x >= 0 &&
      rect.right <= window.innerWidth &&
      menu.scrollWidth <= menu.clientWidth + 1
    );
  }, name);
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

  await seedSessionCatalog(win, {
    __no_repo__: {
      sessions: [
        {
          id: "ui-navigation-draft",
          title: "界面导航草稿",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      activeSessionId: null,
    },
  });
  await win.reload();

  await win.setViewportSize({ width: 1280, height: 820 });
  const expand = win.getByRole("button", { name: "展开侧栏", exact: true });
  const collapse = win.getByRole("button", { name: "折叠侧栏", exact: true });
  await collapse.waitFor();
  assert(
    await win.getByRole("button", { name: "扩展", exact: true }).isVisible(),
    "Desktop navigation starts visible",
  );
  assert((await desktopPreference(win)) === false, "Desktop sidebar starts expanded");

  await win.setViewportSize({ width: 390, height: 700 });
  await expand.waitFor();
  assert(
    !(await win.getByRole("button", { name: "扩展", exact: true }).isVisible()),
    "Narrow windows start with navigation closed",
  );
  assert(
    (await desktopPreference(win)) === false,
    "Narrow layout does not overwrite the desktop preference",
  );
  await screenshot(win, "navigation-narrow-home.png");

  const openDrawer = async () => {
    await expand.click();
    const drawer = win
      .getByRole("dialog")
      .filter({ has: win.getByRole("button", { name: "扩展", exact: true }) });
    await drawer.waitFor();
    await win.waitForFunction(() =>
      document.querySelector('[role="dialog"]')?.contains(document.activeElement),
    );
    return drawer;
  };
  let drawer = await openDrawer();
  const bounds = await drawer.boundingBox();
  assert(
    bounds.x >= 0 && bounds.width >= 240 && bounds.x + bounds.width < 390,
    "Drawer fits and leaves room to dismiss outside it",
  );
  assert(
    (await drawer.getAttribute("aria-modal")) === "true",
    "Narrow navigation is a modal surface",
  );
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let step = 0; step < 12; step++) {
      await win.keyboard.press(key);
      assert(
        await drawer.evaluate((node) => node.contains(document.activeElement)),
        "Keyboard focus remains inside navigation",
      );
    }
  }
  await screenshot(win, "navigation-narrow-drawer.png");
  await win.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await waitForToggleFocus(win);

  drawer = await openDrawer();
  const draft = drawer.getByRole("button", { name: "界面导航草稿", exact: true });
  await draft.focus();
  await draft.click({ button: "right" });
  const contextMenu = drawer.getByRole("menu");
  await contextMenu.waitFor();
  const menuItems = contextMenu.getByRole("menuitem");
  const expectMenuFocus = async (index) => {
    await win.waitForFunction(
      (index) =>
        document.querySelectorAll('[role="menu"] [role="menuitem"]')[index] ===
        document.activeElement,
      index,
    );
  };
  await expectMenuFocus(0);
  await win.keyboard.press("End");
  await expectMenuFocus((await menuItems.count()) - 1);
  await win.keyboard.press("ArrowDown");
  await expectMenuFocus(0);
  await win.keyboard.press("ArrowUp");
  await expectMenuFocus((await menuItems.count()) - 1);
  await win.keyboard.press("Home");
  await expectMenuFocus(0);
  await menuItems.first().dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    bubbles: true,
  });
  assert(await contextMenu.isVisible(), "Composing Escape keeps the session menu open");
  await win.keyboard.press("Escape");
  await contextMenu.waitFor({ state: "hidden" });
  assert(await drawer.isVisible(), "Escape dismisses the session menu before navigation");
  assert(
    await draft.evaluate((node) => node === document.activeElement),
    "Closing the session menu restores its persistent opener",
  );
  await draft.click({ button: "right" });
  await expectMenuFocus(0);
  await win.keyboard.press("ArrowDown");
  await expectMenuFocus(1);
  assert(
    (await menuItems.nth(1).innerText()) === "重命名…",
    "Keyboard navigation selects the rename action",
  );
  await win.keyboard.press("Enter");
  const rename = win.getByRole("dialog", { name: "重命名会话", exact: true });
  await rename.waitFor();
  const titleInput = rename.getByRole("textbox");
  await win.waitForFunction(() => document.activeElement?.tagName === "INPUT");
  await titleInput.dispatchEvent("compositionstart");
  for (const key of ["Enter", "Escape"]) {
    await titleInput.dispatchEvent("keydown", { key, isComposing: true, bubbles: true });
    assert(await rename.isVisible(), `Composing ${key} keeps the rename dialog open`);
  }
  await titleInput.dispatchEvent("compositionend");
  await rename.getByRole("button", { name: "取消", exact: true }).click();
  await rename.waitFor({ state: "hidden" });
  await drawer.waitFor();
  await win.waitForFunction(() => document.activeElement?.textContent?.trim() === "界面导航草稿");
  await win.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await waitForToggleFocus(win);

  drawer = await openDrawer();
  await win.mouse.click(385, 400);
  await drawer.waitFor({ state: "hidden" });
  await waitForToggleFocus(win);
  assert(
    (await desktopPreference(win)) === false,
    "Drawer dismissal leaves desktop preference untouched",
  );

  drawer = await openDrawer();
  await drawer.getByRole("button", { name: "扩展", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
  await win.getByRole("heading", { name: "插件包", exact: true }).waitFor();
  const content = await win.getByRole("heading", { name: "插件包", exact: true }).boundingBox();
  assert(content.x < 100, "Selected page uses the full narrow content area");
  await screenshot(win, "navigation-narrow-extensions.png");

  drawer = await openDrawer();
  await drawer.getByRole("button", { name: "搜索", exact: true }).click();
  const search = win.getByRole("dialog", { name: "搜索对话", exact: true });
  await search.waitFor();
  await drawer.waitFor({ state: "hidden" });
  await win.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox");
  await search.getByRole("combobox").press("Escape");
  await search.waitFor({ state: "hidden" });
  await waitForToggleFocus(win);

  drawer = await openDrawer();
  await drawer.getByRole("button", { name: "设置", exact: true }).click();
  const settingsMenu = win.getByRole("menu", { name: "设置", exact: true });
  await settingsMenu.waitFor();
  const language = settingsMenu.getByRole("menuitem", { name: "切换语言", exact: true });
  const languageMenu = win.getByRole("menu", { name: "切换语言", exact: true });
  await language.hover();
  assert(!(await languageMenu.isVisible()), "Hover alone does not open the language submenu");
  await language.focus();
  await language.press("ArrowRight");
  await languageMenu.waitFor();
  await expectMenuInsideWindow(win, "切换语言");
  await languageMenu.getByRole("menuitemradio").first().hover();
  await settingsMenu
    .getByRole("menuitem", { name: /^打开设置/ })
    .hover({ position: { x: 12, y: 12 } });
  await win.waitForTimeout(400); // Beyond Radix's pointer grace and exit animation.
  assert(await languageMenu.isVisible(), "Hovering past a child keeps the language menu open");
  await languageMenu.getByRole("menuitemradio").first().dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    bubbles: true,
  });
  assert(await languageMenu.isVisible(), "Composing Escape keeps the settings submenu open");
  await win.keyboard.press("Escape");
  await languageMenu.waitFor({ state: "hidden" });
  assert(await settingsMenu.isVisible(), "Escape closes only the active settings submenu");
  assert(
    await language.evaluate((node) => node === document.activeElement),
    "Submenu dismissal returns focus to its trigger",
  );
  await language.press("ArrowRight");
  await languageMenu.waitFor();
  await languageMenu.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await settingsMenu.waitFor({ state: "hidden" });
  const englishSettings = win.getByRole("button", { name: "Settings", exact: true });
  await englishSettings.waitFor();
  await win.waitForFunction(() => document.activeElement?.textContent?.trim() === "Settings");
  await englishSettings.click();
  await win.getByRole("menuitem", { name: "Activity", exact: true }).click();
  await expectMenuInsideWindow(win, "Activity");
  await screenshot(win, "navigation-narrow-activity-en.png");
  await win.keyboard.press("Escape");
  await win.getByRole("menuitem", { name: "Switch language", exact: true }).click();
  await win.getByRole("menuitemradio", { name: "中文", exact: true }).click();
  await win.getByRole("button", { name: "设置", exact: true }).waitFor();
  await drawer.getByRole("button", { name: "设置", exact: true }).click();
  await settingsMenu.waitFor();
  const activity = settingsMenu.getByRole("menuitem", { name: "活动记录", exact: true });
  await activity.focus();
  await activity.press("ArrowRight");
  const activityMenu = win.getByRole("menu", { name: "活动记录", exact: true });
  await activityMenu.waitFor();
  await expectMenuInsideWindow(win, "活动记录");
  await activityMenu.getByRole("menuitem", { name: "日志", exact: true }).hover();
  await language.hover({ position: { x: 12, y: 12 } });
  await win.waitForTimeout(400);
  assert(await activityMenu.isVisible(), "Hovering past a child keeps the activity menu open");
  assert(!(await languageMenu.isVisible()), "Hover does not switch the active submenu");
  await activityMenu.getByRole("menuitem").first().focus();
  await screenshot(win, "navigation-narrow-activity.png");
  await win.keyboard.press("ArrowLeft");
  await activityMenu.waitFor({ state: "hidden" });
  assert(
    await activity.evaluate((node) => node === document.activeElement),
    "ArrowLeft returns to the activity submenu trigger",
  );
  await win.keyboard.press("Escape");
  await settingsMenu.waitFor({ state: "hidden" });
  assert(await drawer.isVisible(), "Escape dismisses settings options before navigation");
  await drawer.getByRole("button", { name: "设置", exact: true }).click();
  await settingsMenu.getByRole("menuitem", { name: "活动记录", exact: true }).click();
  await activityMenu.getByRole("menuitem", { name: "日志", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
  await win.getByRole("heading", { name: "日志", level: 1, exact: true }).waitFor();
  await win.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== "none");
  drawer = await openDrawer();
  await drawer.getByRole("button", { name: "设置", exact: true }).click();
  await settingsMenu.getByRole("menuitem", { name: /^打开设置/ }).click();
  await drawer.waitFor({ state: "hidden" });
  const backToApp = win.getByRole("button", { name: "返回应用", exact: true });
  await backToApp.waitFor();
  await win.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== "none");
  await backToApp.click();
  await expand.waitFor();
  assert(
    !(await win.getByRole("dialog").isVisible()),
    "Returning from settings keeps narrow navigation closed",
  );

  await win.setViewportSize({ width: 1280, height: 820 });
  await collapse.waitFor();
  assert(
    await win.getByRole("button", { name: "扩展", exact: true }).isVisible(),
    "Returning to desktop restores expanded navigation",
  );
  await collapse.click();
  await expand.waitFor();
  assert((await desktopPreference(win)) === true, "Desktop collapse is persisted");

  await win.setViewportSize({ width: 390, height: 700 });
  drawer = await openDrawer();
  await win.setViewportSize({ width: 1280, height: 820 });
  await drawer.waitFor({ state: "hidden" });
  await expand.waitFor();
  assert(
    (await desktopPreference(win)) === true,
    "Closing a drawer through resize restores a collapsed desktop",
  );
  assert(
    !(await win.getByRole("button", { name: "扩展", exact: true }).isVisible()),
    "A temporary drawer does not expand desktop navigation",
  );

  await win.setViewportSize({ width: 390, height: 700 });
  await win.reload();
  await expand.waitFor();
  assert((await desktopPreference(win)) === true, "Narrow reload preserves the desktop preference");
  await expand.focus();
  await win.keyboard.press("Meta+b");
  drawer = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("button", { name: "扩展", exact: true }) });
  await drawer.waitFor();
  await win.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await waitForToggleFocus(win);
  assert(errors.length === 0, `Renderer emitted ${errors.length} errors`);
  console.log(
    "CodeShell navigation Electron e2e: passed (responsive preference, drawer focus, dismissal, page/search handoff, resize, reload, shortcuts)",
  );
} catch (error) {
  if (app) {
    const win = await findCodeShellWindow(app);
    await screenshot(win, "navigation-failure.png");
    console.error(
      await win.evaluate(() => ({
        focus: document.activeElement?.outerHTML.slice(0, 600),
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((node) =>
          node.textContent?.slice(0, 600),
        ),
        view: localStorage.getItem("codeshell.view"),
      })),
    );
  }
  throw error;
} finally {
  await app?.close();
  await isolated.cleanup();
}
