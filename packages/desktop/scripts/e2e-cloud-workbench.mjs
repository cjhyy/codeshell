/* global document, window */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bounded, prepareCloudChooserFixture } from "./cloud-chooser-fixture.mjs";
import {
  assert,
  captureRendererErrors,
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  openSettingsMenu,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "linux" && !process.argv.includes("--server-only"))
  throw new Error(
    "Native chooser acceptance runs only with the owned Linux SecretService; macOS Keychain remains an independent gate.",
  );
const isolated = await makeIsolatedElectronHome("codeshell-native-cloud-e2e-");
const screenshotDir = process.env.CODESHELL_PROJECT_LOCATION_SCREENSHOT_DIR;
let app, fixture;
let passed = false,
  guardReceipt,
  nativeKeyring;
let exitedProcesses = 0;
let primaryError;
const ownedPids = new Set();
async function closeApp() {
  if (!app) return;
  const closing = app;
  const failures = [];
  ownedPids.add(closing.process().pid);
  try {
    const metrics = await bounded(
      closing.evaluate(({ app }) => app.getAppMetrics().map((row) => row.pid)),
      "Electron process inventory",
      5000,
    );
    for (const pid of metrics) ownedPids.add(pid);
  } catch (error) {
    failures.push(error);
  }
  try {
    await bounded(closing.close(), "Electron application close");
  } catch (error) {
    failures.push(error);
  }
  try {
    exitedProcesses = await fixture.assertElectronExited(closing, ownedPids);
    app = undefined;
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "Electron cleanup was not fully acknowledged", {
      cause: failures[0],
    });
}

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
  await expandSidebar(win);
  const opener = win
    .locator("aside")
    .getByRole("button", { name: /^(新项目|New project)$/ })
    .first();
  await opener.click();
  const chooser = win.getByRole("dialog", { name: /^(新项目|New project)$/ });
  await chooser.waitFor({ state: "visible" });
  await captureDialog(win, chooser, "location");
  return { chooser, opener };
}

async function openCloudProjects(win) {
  const opened = await openNewProject(win);
  await opened.chooser.getByRole("button", { name: /^(云端|Cloud)/ }).click();
  await opened.chooser.getByRole("button", { name: /^(返回|Back)$/ }).waitFor();
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
  fixture = await prepareCloudChooserFixture(appDir, isolated, {
    failAfterReady: process.argv.includes("--fail-after-ready"),
  });
  if (process.argv.includes("--server-only")) {
    const login = await fixture.request(fixture.accountOrigin, "/api/v1/account/login", {
      method: "POST",
      body: { username: "chooser-owner", password: "chooser-synthetic-password" },
    });
    assert(login.status === 200, "Synthetic Account login contract");
    const ticket = await fixture.request(
      fixture.accountOrigin,
      "/api/v1/account/cloud-management/tickets",
      {
        method: "POST",
        body: { cloudOrigin: fixture.cloudOrigin, installationId: fixture.installationId },
        token: login.body.accessToken,
      },
    );
    assert(
      ticket.status === 201 && ticket.body.accountOrigin === fixture.accountOrigin,
      "Exact Account ticket contract",
    );
    const grant = await fixture.request(fixture.cloudOrigin, "/api/v1/cloud-management/session", {
      method: "POST",
      body: { ticket: ticket.body.ticket },
    });
    assert(grant.status === 201, "Actual Cloud ticket redemption");
    const created = await fixture.request(fixture.cloudOrigin, "/api/v1/projects", {
      method: "POST",
      body: { name: "Cloud-only project" },
      token: grant.body.token,
    });
    assert(created.status === 201, "Actual Cloud project creation");
    const id = created.body.project.id;
    for (const action of ["start", "stop"]) {
      const response = await fixture.request(
        fixture.cloudOrigin,
        `/api/v1/projects/${id}/${action}`,
        { method: "POST", body: {}, token: grant.body.token },
      );
      assert(response.status === 200, `Actual Cloud ${action}`);
    }
    guardReceipt = await fixture.assertGuards();
    passed = true;
  } else {
    nativeKeyring = await fixture.keyring();
    app = await launchCodeShellElectron({
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: fixture.mainEntry,
      env: fixture.electronEnv,
    });
    await fixture.assertGuards(app);
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
    assert(
      await local.chooser.isVisible(),
      "The chooser remains open while the local picker waits",
    );
    assert(
      await computer.isDisabled(),
      "The local choice cannot open another picker while pending",
    );
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
    await prompt.getByLabel("云服务地址", { exact: true }).fill(fixture.accountOrigin);
    await prompt.getByLabel("账号名称", { exact: true }).fill("chooser-owner");
    await prompt
      .getByLabel("密码（至少 12 位）", { exact: true })
      .fill("chooser-synthetic-password");
    await prompt.getByRole("button", { name: "登录", exact: true }).click();
    const address = prompt.getByPlaceholder("https://cloud.example.com");
    await address.waitFor({ state: "visible" });
    const crypto = await app.evaluate(({ app, safeStorage }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend(),
      mock: app.commandLine.hasSwitch("use-mock-keychain"),
    }));
    assert(
      crypto.available && crypto.backend === "gnome_libsecret" && !crypto.mock,
      "Account login used native SecretService encryption",
    );
    const encrypted = await readFile(join(isolated.userDataDir, "cloud-account/session.enc"));
    assert(
      !encrypted.includes(Buffer.from("chooser-owner")) &&
        !encrypted.includes(Buffer.from("chooser-synthetic-password")),
      "Account registration is encrypted on disk",
    );
    await address.fill(`${fixture.cloudOrigin}/?token=secret`);
    await prompt.getByRole("button", { name: "连接并加载项目", exact: true }).click();
    await prompt.getByRole("alert").filter({ hasText: "HTTPS" }).waitFor();
    assert(app.windows().length === 1, "Invalid Cloud address opens no remote window");
    await prompt.getByRole("button", { name: /^(返回|Back)$/ }).click();
    await prompt.getByRole("button", { name: /^(云端|Cloud)/ }).click();
    await prompt.getByPlaceholder("https://cloud.example.com").fill(fixture.cloudOrigin);
    await prompt.getByRole("button", { name: "连接并加载项目", exact: true }).click();
    await prompt.getByText("Existing Cloud project", { exact: true }).waitFor();
    await prompt.getByRole("textbox", { name: "项目名称", exact: true }).fill("Cloud-only project");
    await prompt.getByRole("button", { name: "创建项目", exact: true }).click();
    let row = prompt.getByRole("listitem").filter({ hasText: "Cloud-only project" });
    await row.getByText("已停止", { exact: true }).waitFor();
    await row.getByRole("button", { name: "启动", exact: true }).click();
    await row.getByText("运行中", { exact: true }).waitFor();
    const opened = app.waitForEvent("window");
    await row.getByRole("button", { name: "打开云端项目", exact: true }).click();
    const cloud = await opened;
    await prompt.waitFor({ state: "hidden" });
    await cloud.getByRole("heading", { name: "Cloud project window", exact: true }).waitFor();
    assert(
      new URL(cloud.url()).origin === fixture.cloudOrigin &&
        /^[0-9a-f-]{36}$/.test(new URL(cloud.url()).searchParams.get("project")),
      "Native window opens the selected exact project",
    );
    const cloudErrors = captureRendererErrors(cloud);
    assert(
      await cloud.evaluate(
        () =>
          typeof window.codeshell === "undefined" &&
          typeof window.require === "undefined" &&
          document.cookie === "",
      ),
      "Cloud page has no local bridge, Node or script-readable grant",
    );
    const remote = await app.evaluate(async ({ BrowserWindow }, origin) => {
      const win = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().startsWith(origin),
      );
      const prefs = win.webContents.getLastWebPreferences();
      const cookies = await win.webContents.session.cookies.get({ url: origin });
      return {
        id: win.id,
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        preload: prefs.preload,
        cookies: cookies.map(({ name, secure, httpOnly, sameSite }) => ({
          name,
          secure,
          httpOnly,
          sameSite,
        })),
      };
    }, fixture.cloudOrigin);
    assert(
      remote.sandbox && remote.contextIsolation && !remote.nodeIntegration && !remote.preload,
      "Managed native window keeps production browser isolation",
    );
    assert(
      remote.cookies.length === 1 &&
        remote.cookies[0].name === "cs_cloud_management" &&
        remote.cookies[0].secure &&
        remote.cookies[0].httpOnly &&
        remote.cookies[0].sameSite === "strict",
      "Native scoped cookie has exact secure attributes",
    );
    assert(
      JSON.stringify(await win.evaluate(() => window.codeshell.projectRegistry.list())) ===
        JSON.stringify(initialProjects),
      "Cloud creation does not change the local project registry",
    );
    assert(
      (await win.evaluate(() => window.localStorage.getItem("codeshell.cloud-workbench.v1"))) ===
        `${fixture.cloudOrigin}/`,
      "Clean Cloud address is saved",
    );
    await openCloudProjects(win);
    await prompt.getByRole("button", { name: "连接并加载项目", exact: true }).click();
    row = prompt.getByRole("listitem").filter({ hasText: "Cloud-only project" });
    await row.getByRole("button", { name: "停止", exact: true }).click();
    await row.getByText("已停止", { exact: true }).waitFor();
    await prompt.getByRole("button", { name: "退出此云端", exact: true }).click();
    const cloudClosed = cloud.waitForEvent("close");
    await prompt.getByRole("button", { name: "确认退出此云端", exact: true }).click();
    await prompt.getByRole("button", { name: "连接并加载项目", exact: true }).waitFor();
    await bounded(cloudClosed, "Scoped Cloud window close");
    assert(
      app.windows().length === 1 &&
        (await win.evaluate(() => window.codeshell.cloudAccount.status())).state === "signed-in",
      "Scoped Cloud logout closes its window and retains Account login",
    );
    await prompt.getByRole("button", { name: "连接并加载项目", exact: true }).click();
    await prompt.getByText("Cloud-only project", { exact: true }).waitFor();
    await win.keyboard.press("Escape");
    await prompt.waitFor({ state: "hidden" });
    await win.setViewportSize({ width: 390, height: 760 });
    const narrowCloud = await openCloudProjects(win);
    await address.waitFor({ state: "visible" });
    await address.focus();
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
      (await win.locator('[data-sidebar-action="toggle"]').getAttribute("aria-expanded")) ===
        "true",
      "Escape closes only the Cloud prompt and keeps the narrow sidebar open",
    );
    assert(app.windows().length === 1, "Cancelling the Cloud prompt opens no remote window");
    await win.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    await win.setViewportSize({ width: 1280, height: 820 });

    await openCloudProjects(win);
    await prompt.getByPlaceholder("https://cloud.example.com").waitFor();
    assert(
      (await prompt.getByPlaceholder("https://cloud.example.com").inputValue()) ===
        `${fixture.cloudOrigin}/`,
      "Last cloud address not restored",
    );
    await win.keyboard.press("Escape");
    await prompt.waitFor({ state: "hidden" });

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
        await english.chooser
          .getByRole("button", { name: "This computer", exact: true })
          .isVisible(),
        "The local project choice follows the English UI language",
      );
      await english.chooser.getByRole("button", { name: "Cloud", exact: true }).click();
      await english.chooser.getByLabel("Cloud service address", { exact: true }).waitFor();
      assert(
        await english.chooser
          .getByRole("button", { name: "Connect and load projects", exact: true })
          .isVisible(),
        "The cloud form follows the English UI language",
      );
      await captureDialog(win, english.chooser, "cloud");
      await win.keyboard.press("Escape");
      await english.chooser.waitFor({ state: "hidden" });
    }
    assert(errors.length === 0 && cloudErrors.length === 0, "Renderer errors occurred");
    guardReceipt = await fixture.assertGuards(app);
    await closeApp();
    app = await launchCodeShellElectron({
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: fixture.mainEntry,
      env: fixture.electronEnv,
    });
    await fixture.assertGuards(app);
    const cold = await findCodeShellWindow(app);
    const status = await cold.evaluate(() => window.codeshell.cloudAccount.status());
    assert(
      status.state === "signed-in" && status.account.id === fixture.accountId,
      "Cold native Main decrypts the same Account identity",
    );
    const coldCloud = (await openCloudProjects(cold)).chooser;
    await coldCloud.getByRole("button", { name: "Connect and load projects", exact: true }).click();
    await coldCloud.getByText("Cloud-only project", { exact: true }).waitFor();
    await cold.evaluate(() => window.codeshell.cloudAccount.logout());
    await coldCloud.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert(
      (await cold.evaluate(() => window.codeshell.cloudAccount.status())).state === "signed-out",
      "Root Account logout is acknowledged by the real Main IPC",
    );
    await fixture.assertGuards(app);
    passed = true;
  }
} catch (error) {
  primaryError = error;
} finally {
  const failures = [];
  try {
    await closeApp();
  } catch (error) {
    failures.push(error);
  }
  let serverReceipt;
  try {
    serverReceipt = await fixture?.close();
  } catch (error) {
    failures.push(error);
  }
  if (passed && failures.length === 0 && serverReceipt) {
    await isolated.cleanup();
    console.log(
      JSON.stringify({
        passed: true,
        nativeMain: !process.argv.includes("--server-only"),
        nativeKeyring,
        guardReceipt,
        exitedProcesses,
        started: serverReceipt.started,
        stopped: serverReceipt.stopped,
        redeemed: serverReceipt.redeemed,
        sockets: serverReceipt.sockets,
        listeners: serverReceipt.listeners,
        runtime: "controlled",
        account: "synthetic",
        remotePage: "synthetic",
      }),
    );
  } else console.error(`Cloud chooser state preserved for evidence/exit audit: ${isolated.home}`);
  if (failures.length)
    primaryError = new AggregateError(
      [...(primaryError ? [primaryError] : []), ...failures],
      "Cloud chooser cleanup was not fully acknowledged",
      { cause: primaryError ?? failures[0] },
    );
}

if (primaryError) throw primaryError;
