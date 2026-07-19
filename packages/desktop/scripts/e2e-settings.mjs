/*
 * Real Electron settings smoke.
 *
 * Boots the production main/preload/renderer stack in an isolated HOME, seeds
 * one tracked project, and exercises the settings information architecture at
 * desktop and mobile widths. Optional screenshots are written when
 * CODESHELL_SETTINGS_SCREENSHOT_DIR is set.
 */
/* global document, getComputedStyle, localStorage */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const isolated = await makeIsolatedElectronHome("codeshell-settings-e2e-");
const projectPath = join(isolated.home, "settings-project");
const screenshotDir = process.env.CODESHELL_SETTINGS_SCREENSHOT_DIR;
let app;
let win;

async function seedFixture() {
  await mkdir(projectPath, { recursive: true });
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "desktop", "recents.json"),
    `${JSON.stringify(
      [
        {
          path: projectPath,
          name: basename(projectPath),
          lastOpenedAt: Date.now(),
          pinned: true,
        },
      ],
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    `${JSON.stringify({ autoUpdates: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
}

async function openSettings(win) {
  const settings = win.getByRole("button", { name: /设置|Settings/i }).last();
  await settings.waitFor({ state: "visible", timeout: 20_000 });
  await settings.click();
  const menu = win.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const menuLabels = await menu.getByRole("menuitem").allTextContents();
  assert(
    /打开设置|Open settings/i.test(menuLabels.at(-1) ?? ""),
    "Open settings is not the last menu action",
  );
  const language = menu.getByRole("menuitem", { name: /切换语言|Switch language/i });
  await language.hover();
  assert(
    (await win.getByRole("menuitemradio").count()) === 0,
    "Language submenu opened from hover instead of an explicit click",
  );
  await language.click();
  await win.getByRole("menuitemradio").first().waitFor({ state: "visible", timeout: 10_000 });
  await screenshot(win, "settings-menu-language.png");
  await language.click();
  await win.getByRole("menuitemradio").first().waitFor({ state: "hidden", timeout: 10_000 });
  const open = win.getByText(/打开设置|Open settings/i).first();
  if (await open.isVisible().catch(() => false)) await open.click();
  await win.waitForFunction(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === "settings_page"
      );
    } catch {
      return false;
    }
  });
  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .waitFor({ state: "visible", timeout: 20_000 });
}

async function openProjectSettings(win) {
  await win.getByRole("button", { name: /返回应用|Back to app/i }).click();
  await win.waitForFunction(() => {
    try {
      return JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === "chat";
    } catch {
      return false;
    }
  });
  const project = win.getByText(basename(projectPath), { exact: true });
  assert((await project.count()) === 1, "Seeded project entry is not unique");
  await project.click({ button: "right" });
  const open = win.getByRole("menuitem", { name: /项目配置|Project configuration/i });
  await open.waitFor({ state: "visible", timeout: 10_000 });
  await open.click();
  await win.waitForFunction(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === "project_config"
      );
    } catch {
      return false;
    }
  });
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (await viewOnly.isVisible().catch(() => false)) await viewOnly.click();
}

async function assertNoHorizontalOverflow(win, label) {
  const metrics = await win.evaluate(() => {
    const navigation = document.querySelector(
      'nav[aria-label="设置导航"], nav[aria-label="Settings navigation"]',
    );
    // The chat workspace stays mounted (aria-hidden) behind Settings, so a
    // document-wide `querySelector("main")` can select the hidden chat main.
    // Resolve the settings main from the navigation's own shell instead.
    const main = navigation?.parentElement?.querySelector("main");
    return {
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      mainClient: main?.clientWidth ?? 0,
      mainContent: main?.scrollWidth ?? 0,
      mainOverflowY: main ? getComputedStyle(main).overflowY : "",
      navigationClient: navigation?.clientWidth ?? 0,
      navigationContent: navigation?.scrollWidth ?? 0,
    };
  });
  assert(
    metrics.content <= metrics.viewport + 1,
    `${label} overflowed horizontally: content=${metrics.content}, viewport=${metrics.viewport}`,
  );
  assert(
    metrics.mainContent <= metrics.mainClient + 1,
    `${label} main content overflowed horizontally: content=${metrics.mainContent}, client=${metrics.mainClient}`,
  );
  assert(
    metrics.navigationContent <= metrics.navigationClient + 1,
    `${label} navigation overflowed horizontally: content=${metrics.navigationContent}, client=${metrics.navigationClient}`,
  );
  assert(
    metrics.mainOverflowY === "auto" || metrics.mainOverflowY === "scroll",
    `${label} main content is not independently scrollable`,
  );
}

async function screenshot(win, filename) {
  if (!screenshotDir) return;
  const output = join(screenshotDir, filename);
  await win.screenshot({ path: output, fullPage: true });
  console.log(`settings visual: ${output}`);
}

try {
  await seedFixture();
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1_440, height: 960 });
  await win.locator("#root").waitFor({ state: "visible", timeout: 20_000 });
  await openSettings(win);

  await win.getByRole("heading", { name: /常规|General/i }).waitFor({ state: "visible" });
  assert(
    (await win.getByRole("combobox", { name: /配置范围|Configuration scope/i }).count()) === 0,
    "Ordinary settings still rendered a page-wide project scope picker",
  );
  await win
    .getByText(/扩展能力|Extensions/i)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await win
    .getByText(/环境与连接|Environment|Connections/i)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await assertNoHorizontalOverflow(win, "global settings");
  await screenshot(win, "settings-global.png");

  const search = win.getByRole("searchbox", { name: /搜索设置|Search settings/i });
  await search.fill("MCP");
  await win.getByRole("button", { name: /MCP/i }).waitFor({ state: "visible" });
  assert(
    (await win.getByRole("button", { name: /外观|Appearance/i }).count()) === 0,
    "settings search did not filter unrelated navigation items",
  );
  await search.fill("");

  await win.getByRole("button", { name: /外观|Appearance/i }).click();
  await win.getByRole("heading", { name: /外观|Appearance/i }).waitFor({ state: "visible" });
  await openProjectSettings(win);
  await win
    .getByRole("heading", { name: /项目概览|Project overview/i })
    .waitFor({ state: "visible", timeout: 10_000 });
  await win.getByText(projectPath, { exact: false }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "project settings");
  await screenshot(win, "settings-project.png");

  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .getByRole("button", { name: /数字人|Digital humans/i })
    .click();
  await win
    .getByRole("heading", { name: /数字人|Digital humans/i, level: 1 })
    .waitFor({ state: "visible" });

  await win.setViewportSize({ width: 700, height: 900 });
  await win
    .getByRole("combobox", { name: /设置导航|Settings navigation/i })
    .waitFor({ state: "visible", timeout: 10_000 });
  assert(
    await win.getByRole("navigation", { name: /设置导航|Settings navigation/i }).isHidden(),
    "desktop settings navigation remained visible at the mobile breakpoint",
  );
  await assertNoHorizontalOverflow(win, "mobile settings");
  await screenshot(win, "settings-mobile.png");

  assert(rendererErrors.length === 0, `renderer emitted ${rendererErrors.length} page error(s)`);
  console.log("CodeShell Electron settings E2E: passed");
} catch (error) {
  if (win) {
    const headings = await win
      .locator("h1, h2, h3")
      .allTextContents()
      .catch(() => []);
    console.error("settings headings at failure:", headings);
    if (screenshotDir) {
      const failurePath = join(screenshotDir, "settings-failure.png");
      await win.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined);
      console.error(`settings failure visual: ${failurePath}`);
    }
  }
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await isolated.cleanup();
}
