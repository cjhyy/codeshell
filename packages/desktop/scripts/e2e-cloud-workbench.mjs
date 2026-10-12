/* global document, window */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProjectControlServer, resolveWebAppRoot } from "@cjhyy/code-shell-server/serve";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  openSettingsMenu,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-native-cloud-e2e-");
const screenshotDir = process.env.CODESHELL_PROJECT_LOCATION_SCREENSHOT_DIR;
let app, control;

async function captureDialog(win, chooser, step) {
  const layout = await chooser.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: node.clientWidth,
      content: node.scrollWidth,
      viewport: window.innerWidth,
      language: window.localStorage.getItem("codeshell.uiLanguage") ?? "zh",
    };
  });
  assert(
    layout.left >= -1 && layout.right <= layout.viewport + 1 && layout.content <= layout.width + 1,
    `${step} fits the ${layout.viewport}px ${layout.language} viewport`,
  );
  if (screenshotDir)
    await win.screenshot({
      path: join(screenshotDir, `new-project-${step}-${layout.viewport}-${layout.language}.png`),
      scale: "css",
      animations: "disabled",
    });
}

async function openNewProject(win) {
  const toggle = win.locator('[data-sidebar-action="toggle"]');
  await toggle.waitFor({ state: "visible" });
  await win.waitForFunction(() => {
    const toggle = document.querySelector('[data-sidebar-action="toggle"]');
    return (
      toggle && (toggle.getAttribute("aria-haspopup") === "dialog") === window.innerWidth < 640
    );
  });
  const opener = win
    .locator("aside")
    .getByRole("button", { name: /^(新项目|New project)$/ })
    .first();
  if (!(await opener.isVisible())) await toggle.click();
  await opener.click();
  const chooser = win.getByRole("dialog", { name: /^(新项目|New project)$/ });
  await chooser.waitFor({ state: "visible" });
  await captureDialog(win, chooser, "location");
  return { chooser, opener };
}

async function openCloudProjects(win) {
  const opened = await openNewProject(win);
  await opened.chooser.getByRole("button", { name: /^(云端|Cloud)/ }).click();
  await opened.chooser.getByPlaceholder("https://cloud.example.com").waitFor();
  await captureDialog(win, opened.chooser, "cloud");
  return opened;
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  control = await startProjectControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: join(isolated.home, "cloud-control"),
    staticRootDir: resolveWebAppRoot(),
  });
  const password = "native-cloud-test-password";
  const setup = await fetch(`${control.url}/api/v1/auth/setup`, {
    method: "POST",
    headers: { origin: control.url, "content-type": "application/json" },
    body: JSON.stringify({ token: control.bootstrapToken, username: "test-owner", password }),
  });
  assert(setup.status === 200, "Cloud test administrator setup failed");
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  const win = await findCodeShellWindow(app),
    errors = captureRendererErrors(win);
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 2500 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();

  const initialProjects = await win.evaluate(() => window.codeshell.projectRegistry.list());
  // A controlled cancellation exercises the renderer's real local-project
  // bridge without opening an OS picker against the operator's filesystem.
  await app.evaluate(({ ipcMain }) => {
    globalThis.projectLocationPicker = { calls: 0, resolve: null };
    ipcMain.removeHandler("projectRegistry:createFromPicker");
    ipcMain.handle("projectRegistry:createFromPicker", () => {
      globalThis.projectLocationPicker.calls += 1;
      return new Promise((resolve) => {
        globalThis.projectLocationPicker.resolve = resolve;
      });
    });
  });
  const local = await openNewProject(win);
  const computer = local.chooser.getByRole("button", { name: /^(此计算机|This computer)/ });
  await computer.dblclick();
  assert(await local.chooser.isVisible(), "The chooser remains open while the local picker waits");
  assert(await computer.isDisabled(), "The local choice cannot open another picker while pending");
  assert(
    (await app.evaluate(() => globalThis.projectLocationPicker.calls)) === 1,
    "A double click starts only one native picker",
  );
  await app.evaluate(() => globalThis.projectLocationPicker.resolve(null));
  await local.chooser.waitFor({ state: "hidden" });
  assert(
    JSON.stringify(await win.evaluate(() => window.codeshell.projectRegistry.list())) ===
      JSON.stringify(initialProjects),
    "Canceling the local picker preserves the project registry",
  );

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu:add-project");
  });
  const menuChooser = win.getByRole("dialog", { name: /^(新项目|New project)$/ });
  await menuChooser.waitFor({ state: "visible" });
  assert(
    await menuChooser.getByRole("button", { name: /^(云端|Cloud)/ }).isVisible(),
    "The application Add project menu opens the same location chooser",
  );
  await win.keyboard.press("Escape");
  await menuChooser.waitFor({ state: "hidden" });

  await win.getByRole("button", { name: /^(不使用项目|No project)$/ }).click();
  await win.getByRole("button", { name: /^(添加新项目|Add new project)$/ }).click();
  await menuChooser.waitFor({ state: "visible" });
  assert(
    await menuChooser.getByRole("button", { name: /^(此计算机|This computer)/ }).isVisible(),
    "The composer Add new project action opens the same location chooser",
  );
  await win.keyboard.press("Escape");
  await menuChooser.waitFor({ state: "hidden" });

  const firstCloud = await openCloudProjects(win);
  const prompt = firstCloud.chooser;
  await prompt.getByPlaceholder("https://cloud.example.com").fill(`${control.url}/?token=secret`);
  await prompt.getByRole("button", { name: /打开云端项目|Open cloud projects/ }).click();
  await prompt.getByText(/请填写工作台首页地址/).waitFor();
  assert(app.windows().length === 1, "Invalid cloud addresses open no remote window");
  await prompt.getByRole("button", { name: /^(返回|Back)$/ }).click();
  assert(
    await prompt.getByRole("button", { name: /^(此计算机|This computer)/ }).isVisible(),
    "Back returns to the project location choices",
  );
  await prompt.getByRole("button", { name: /^(云端|Cloud)/ }).click();
  await prompt.getByPlaceholder("https://cloud.example.com").fill(control.url);
  const opened = app.waitForEvent("window");
  await prompt.getByRole("button", { name: /打开云端项目|Open cloud projects/ }).click();
  const cloud = await opened;
  await prompt.waitFor({ state: "hidden" });
  await cloud.waitForURL(`${control.url}/`);
  const cloudErrors = captureRendererErrors(cloud);
  await cloud.getByRole("heading", { name: "登录工作空间" }).waitFor();
  assert(
    await cloud.evaluate(() => typeof window.codeshell === "undefined"),
    "Remote page has the local preload",
  );
  await cloud.getByLabel("用户名", { exact: true }).fill("test-owner");
  await cloud.getByLabel("密码", { exact: true }).fill(password);
  await cloud.getByRole("button", { name: "登录", exact: true }).click();
  await cloud.getByRole("heading", { name: "你的项目", exact: true }).waitFor();
  await cloud.getByPlaceholder("例如：个人网站").fill("Cloud-only project");
  await cloud.getByRole("button", { name: "创建项目", exact: true }).click();
  await cloud.getByRole("heading", { name: "Cloud-only project", exact: true }).waitFor();
  const desktopProjects = await win.evaluate(() => window.codeshell.projectRegistry.list());
  assert(
    !JSON.stringify(desktopProjects).includes("Cloud-only project"),
    "Cloud project leaked into the local project registry",
  );
  assert(
    (await win.evaluate(() => window.localStorage.getItem("codeshell.cloud-workbench.v1"))) ===
      `${control.url}/`,
    "The clean cloud address was not saved",
  );
  await cloud.close();

  await win.setViewportSize({ width: 390, height: 760 });
  const narrowCloud = await openCloudProjects(win);
  const address = prompt.getByPlaceholder("https://cloud.example.com");
  await address.waitFor({ state: "visible" });
  await win.waitForFunction(
    (node) => node === document.activeElement,
    await address.elementHandle(),
  );
  for (let index = 0; index < 6; index += 1) {
    await win.keyboard.press("Tab");
    assert(
      await prompt.evaluate((node) => node.contains(document.activeElement)),
      `Cloud address prompt retains keyboard focus after Tab ${index + 1}`,
    );
  }
  await win.keyboard.press("Escape");
  await prompt.waitFor({ state: "hidden" });
  const drawer = win.getByRole("dialog", { name: /^(导航|Navigation)$/ });
  await drawer.waitFor({ state: "visible" });
  await win.waitForFunction(
    (node) => node === document.activeElement,
    await narrowCloud.opener.elementHandle(),
  );
  assert(
    (await win.locator('[data-sidebar-action="toggle"]').getAttribute("aria-expanded")) === "true",
    "Escape closes only the Cloud prompt and keeps the narrow sidebar open",
  );
  assert(app.windows().length === 1, "Cancelling the Cloud prompt opens no remote window");
  await win.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await win.setViewportSize({ width: 1280, height: 820 });

  await openCloudProjects(win);
  await prompt.getByPlaceholder("https://cloud.example.com").waitFor();
  assert(
    (await prompt.getByPlaceholder("https://cloud.example.com").inputValue()) === `${control.url}/`,
    "Last cloud address not restored",
  );
  const reopened = app.waitForEvent("window");
  await prompt.getByRole("button", { name: /打开云端项目|Open cloud projects/ }).click();
  const again = await reopened;
  await again.getByRole("heading", { name: "Cloud-only project", exact: true }).waitFor();
  await again.close();

  const settings = await openSettingsMenu(win);
  await settings.getByRole("menuitem", { name: /^(切换语言|Switch language)$/ }).click();
  await win
    .getByRole("menu", { name: /^(切换语言|Switch language)$/ })
    .getByRole("menuitemradio", { name: "English", exact: true })
    .click();
  await settings.waitFor({ state: "hidden" });
  for (const width of [1280, 390]) {
    await win.setViewportSize({ width, height: 760 });
    const english = await openNewProject(win);
    assert(
      await english.chooser.getByRole("button", { name: "This computer", exact: true }).isVisible(),
      "The local project choice follows the English UI language",
    );
    await english.chooser.getByRole("button", { name: "Cloud", exact: true }).click();
    await english.chooser.getByLabel("Cloud service address", { exact: true }).waitFor();
    assert(
      await english.chooser
        .getByRole("button", { name: "Open cloud projects", exact: true })
        .isVisible(),
      "The cloud form follows the English UI language",
    );
    await captureDialog(win, english.chooser, "cloud");
    await win.keyboard.press("Escape");
    await english.chooser.waitFor({ state: "hidden" });
  }
  assert(errors.length === 0 && cloudErrors.length === 0, "Renderer errors occurred");
  console.log(
    "PASS: New project location chooser -> local picker duplicate guard/cancellation -> application menu and composer chooser -> cloud address validation/Back -> isolated cloud window -> real Hub login/project -> unchanged local registry -> narrow focus/Tab/Escape -> login/project preserved on reopen -> bounded Chinese/English chooser and cloud form",
  );
} finally {
  await app?.close().catch(() => {});
  await control?.close();
  await isolated.cleanup();
}
