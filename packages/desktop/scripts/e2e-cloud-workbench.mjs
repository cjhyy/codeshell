/* Existing local project -> explicit cloud project, using an isolated profile. */
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
  seedSessionCatalog,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-existing-cloud-e2e-");
const screenshotDir = process.env.CODESHELL_PROJECT_LOCATION_SCREENSHOT_DIR;
const localAlphaPath = join(isolated.home, "Existing local alpha");
const localBetaPath = join(isolated.home, "Existing local beta");
const sessionId = "existing-project-location-session";
const sessionTitle = "已有项目历史会话";
const historicalMessage = "这是已有项目中保存的历史消息。";
const bindingKey = (project) => `codeshell.project-cloud-target.v1:${project.id}`;
const locationTrigger = (win) =>
  win.getByRole("button", { name: /^(运行位置：此计算机|Work in: This computer)$/ });
let app, control, win;
let processLog = "";

async function captureSurface(win, surface, step) {
  const layout = await surface.evaluate((node) => {
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
    layout.width > 0 &&
      layout.left >= -1 &&
      layout.right <= layout.viewport + 1 &&
      layout.content <= layout.width + 1,
    `${step} fits the ${layout.viewport}px ${layout.language} viewport`,
  );
  if (screenshotDir)
    await win.screenshot({
      path: join(
        screenshotDir,
        `existing-project-${step}-${layout.viewport}-${layout.language}.png`,
      ),
      scale: "css",
      animations: "disabled",
    });
}

async function openSidebar(win) {
  const toggle = win.locator('[data-sidebar-action="toggle"]');
  await toggle.waitFor({ state: "visible" });
  await win.waitForFunction(() => {
    const toggle = document.querySelector('[data-sidebar-action="toggle"]');
    return (
      toggle && (toggle.getAttribute("aria-haspopup") === "dialog") === window.innerWidth < 640
    );
  });
  if (!(await win.locator("aside").isVisible())) await toggle.click();
  return win.locator("aside");
}

async function closeDrawer(win) {
  const drawer = win.getByRole("dialog", { name: /^(导航|Navigation)$/ });
  if (await drawer.isVisible()) {
    await win.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
  }
}

async function viewProjectReadOnly(win) {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 3000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
}

async function selectProject(win, name) {
  const sidebar = await openSidebar(win);
  await sidebar.getByRole("button", { name, exact: true }).click();
  await viewProjectReadOnly(win);
  await closeDrawer(win);
  await locationTrigger(win).waitFor({ state: "visible" });
}

async function openLocationMenu(win) {
  const trigger = locationTrigger(win);
  await trigger.click();
  // Radix labels this menu from its trigger, which takes precedence over the
  // content's aria-label. Identify it by the user-visible Cloud action.
  const menu = win.getByRole("menu").filter({
    has: win.getByRole("menuitem", { name: /^(云端|Cloud)$/, exact: true }),
  });
  await menu.waitFor({ state: "visible" });
  assert(
    await menu
      .getByRole("menuitem", { name: /^(此计算机|This computer)$/, exact: true })
      .isVisible(),
    "An existing project's location menu includes this computer",
  );
  await captureSurface(win, menu, "menu");
  return { trigger, menu };
}

async function openCloudDialog(win, { change = false } = {}) {
  const opened = await openLocationMenu(win);
  await opened.menu
    .getByRole("menuitem", {
      name: change ? /^(更改云端项目…|Change cloud project…)$/ : /^(云端|Cloud)$/,
      exact: true,
    })
    .click();
  const dialog = win.getByRole("dialog", { name: /^(云端运行位置|Cloud run location)$/ });
  await dialog.waitFor({ state: "visible" });
  const input = dialog.getByRole("textbox", {
    name: /^(已有云端项目链接|Existing cloud project URL)$/,
  });
  await input.waitFor({ state: "visible" });
  await captureSurface(win, dialog, "cloud");
  return { ...opened, dialog, input };
}

async function submitCloud(win, target, url) {
  await target.input.fill(url);
  const opened = app.waitForEvent("window");
  await target.dialog.getByRole("button", { name: /^(打开云端项目|Open cloud project)$/ }).click();
  const cloud = await opened;
  await target.dialog.waitFor({ state: "hidden" });
  await cloud.waitForURL(url);
  assert(
    await locationTrigger(win).isVisible(),
    "The local conversation still runs on this computer",
  );
  return cloud;
}

async function storedBinding(win, project) {
  return win.evaluate((key) => window.localStorage.getItem(key), bindingKey(project));
}

async function seedHistory() {
  const directory = join(isolated.codeShellHome, "sessions", sessionId);
  await mkdir(directory, { recursive: true });
  const now = Date.now();
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      sessionId,
      title: sessionTitle,
      cwd: localAlphaPath,
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: now - 1000,
    }),
  );
  const events = [
    { type: "session_meta", data: { sessionId } },
    { type: "message", data: { role: "user", content: "请继续已有项目。" } },
    { type: "turn_boundary", data: {} },
    { type: "message", data: { role: "assistant", content: historicalMessage } },
  ].map((event, index) => ({
    id: `${sessionId}-event-${index}`,
    timestamp: now - 1000 + index * 100,
    turnNumber: 1,
    ...event,
  }));
  await writeFile(
    join(directory, "transcript.jsonl"),
    events.map(JSON.stringify).join("\n") + "\n",
  );
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await mkdir(localAlphaPath, { recursive: true });
  await mkdir(localBetaPath, { recursive: true });
  await writeFile(join(localAlphaPath, "README.md"), "# Existing local alpha\n");
  await writeFile(join(localBetaPath, "README.md"), "# Existing local beta\n");
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
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  await setup.arrayBuffer();
  async function createCloudProject(name) {
    const response = await fetch(`${control.url}/api/v1/projects`, {
      method: "POST",
      headers: { origin: control.url, "content-type": "application/json", cookie },
      body: JSON.stringify({ name }),
    });
    assert(response.status === 201, "Precreating the existing cloud project failed");
    return (await response.json()).project;
  }
  const cloudAlpha = await createCloudProject("Existing cloud alpha");
  const cloudBeta = await createCloudProject("Existing cloud beta");
  const alphaUrl = `${control.url}/?project=${cloudAlpha.id}`;
  const betaUrl = `${control.url}/?project=${cloudBeta.id}`;
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    // Guarded Node smokes inherit an outer test HOME. Keep the session guard
    // and the Electron-owned persisted history on this same isolated root.
    env: { CODE_SHELL_TEST_HOME: isolated.codeShellHome },
  });
  app.process().stderr?.on("data", (chunk) => {
    processLog = (processLog + chunk.toString()).slice(-16_000);
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ timeout: 2500 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();

  assert(
    await locationTrigger(win).isDisabled(),
    "Unbound conversations cannot open a cloud project",
  );
  // Only the native picker is controlled. The real IPC and store register these
  // existing folders and broadcast their authoritative project IDs.
  await app.evaluate(
    ({ dialog }, paths) => {
      globalThis.projectLocationPicker = { calls: 0, paths };
      dialog.showOpenDialog = async () => {
        const picked = globalThis.projectLocationPicker.paths.shift();
        globalThis.projectLocationPicker.calls += 1;
        return picked
          ? { canceled: false, filePaths: [picked] }
          : { canceled: true, filePaths: [] };
      };
    },
    [localAlphaPath, localBetaPath],
  );
  const sidebar = await openSidebar(win);
  await sidebar
    .getByRole("button", { name: /^(添加项目|Add project)$/ })
    .first()
    .click();
  await win.waitForFunction(
    async () => (await window.codeshell.projectRegistry.list()).length === 1,
  );
  await viewProjectReadOnly(win);
  assert(
    (await win.getByRole("dialog", { name: /^(新项目|New project)$/ }).count()) === 0,
    "Add project opens the local folder picker directly",
  );
  await locationTrigger(win).waitFor({ state: "visible" });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu:add-project");
  });
  await win.waitForFunction(
    async () => (await window.codeshell.projectRegistry.list()).length === 2,
  );
  await viewProjectReadOnly(win);
  const projects = await win.evaluate(() => window.codeshell.projectRegistry.list());
  const localAlpha = projects.find((project) => project.name === "Existing local alpha");
  const localBeta = projects.find((project) => project.name === "Existing local beta");
  assert(localAlpha && localBeta, "Both existing folders have authoritative project IDs");
  assert(
    (await app.evaluate(() => globalThis.projectLocationPicker.calls)) === 2,
    "Sidebar and application menu use the native local picker",
  );

  await selectProject(win, localAlpha.name);
  let target = await openCloudDialog(win);
  assert(
    await target.dialog.getByText(localAlpha.name, { exact: false }).isVisible(),
    "Cloud location identifies its existing local project",
  );
  assert((await target.input.inputValue()) === "", "A project starts without a cloud binding");
  await target.input.fill(alphaUrl);
  await target.dialog.getByRole("button", { name: /^(取消|Cancel)$/ }).click();
  await target.dialog.waitFor({ state: "hidden" });
  assert(
    (await storedBinding(win, localAlpha)) === null,
    "Canceling does not save a cloud binding",
  );

  target = await openCloudDialog(win);
  await target.input.fill(`${control.url}/`);
  await target.dialog.getByRole("button", { name: /^(打开云端项目|Open cloud project)$/ }).click();
  await target.dialog.getByRole("alert").waitFor();
  assert(app.windows().length === 1, "A cloud homepage cannot replace an existing project URL");
  assert((await storedBinding(win, localAlpha)) === null, "Invalid targets are not saved");
  const cloud = await submitCloud(win, target, alphaUrl);
  const cloudErrors = captureRendererErrors(cloud);
  assert(
    await cloud.evaluate(() => typeof window.codeshell === "undefined"),
    "The cloud project cannot access the local preload",
  );
  await cloud.getByRole("heading", { name: "登录工作空间" }).waitFor();
  await cloud.getByLabel("用户名", { exact: true }).fill("test-owner");
  await cloud.getByLabel("密码", { exact: true }).fill(password);
  await cloud.getByRole("button", { name: "登录", exact: true }).click();
  // The real cloud records already exist. They stay stopped so this UI check
  // needs neither a Docker runtime nor a configured model.
  await cloud.getByRole("heading", { name: cloudAlpha.name, exact: true }).waitFor();
  assert(cloud.url() === alphaUrl, "Login preserves the explicit existing cloud project selection");
  assert(
    (await storedBinding(win, localAlpha)) === alphaUrl,
    "The normalized target is saved per local project",
  );
  assert(
    JSON.stringify(await win.evaluate(() => window.codeshell.projectRegistry.list())) ===
      JSON.stringify(projects),
    "Opening a cloud project does not change local project authority",
  );
  await cloud.close();

  const saved = await openLocationMenu(win);
  const reopened = app.waitForEvent("window");
  await saved.menu.getByRole("menuitem", { name: /^(云端|Cloud)$/, exact: true }).click();
  const again = await reopened;
  await again.waitForURL(alphaUrl);
  await again.getByRole("heading", { name: cloudAlpha.name, exact: true }).waitFor();
  assert(
    (await win.getByRole("dialog", { name: /^(云端运行位置|Cloud run location)$/ }).count()) === 0,
    "A saved target opens without asking for its URL again",
  );
  const navigatedAlphaUrl = `${alphaUrl}#kept-view`;
  await again.goto(navigatedAlphaUrl);
  const cloudDraft = "Keep this unsent cloud draft";
  await again.getByPlaceholder("例如：个人网站").fill(cloudDraft);
  const alphaWindowId = await app.evaluate(
    ({ BrowserWindow }, url) =>
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)?.id,
    navigatedAlphaUrl,
  );
  assert(Number.isInteger(alphaWindowId), "The first cloud target owns a native window");

  await selectProject(win, localBeta.name);
  const otherTarget = await openCloudDialog(win);
  assert(
    (await otherTarget.input.inputValue()) === "",
    "Another existing project does not reuse alpha's binding",
  );
  const other = await submitCloud(win, otherTarget, betaUrl);
  await other.getByRole("heading", { name: cloudBeta.name, exact: true }).waitFor();
  assert(other.url() === betaUrl, "The second local project opens its own exact cloud target");
  assert(
    (await storedBinding(win, localAlpha)) === alphaUrl &&
      (await storedBinding(win, localBeta)) === betaUrl,
    "Project bindings remain independent",
  );
  assert(
    app.windows().length === 3,
    "Two existing cloud projects on one origin coexist with Desktop",
  );
  assert(
    again.url() === navigatedAlphaUrl,
    "Opening another project preserves the first cloud window's navigation",
  );
  await selectProject(win, localAlpha.name);
  const firstTarget = await openLocationMenu(win);
  await firstTarget.menu.getByRole("menuitem", { name: /^(云端|Cloud)$/, exact: true }).click();
  await firstTarget.menu.waitFor({ state: "hidden" });
  await again.waitForFunction(() => document.hasFocus());
  assert(app.windows().length === 3, "Reopening the first cloud project reuses its native window");
  assert(
    (await app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)?.id,
      navigatedAlphaUrl,
    )) === alphaWindowId,
    "The first cloud project returns to the same native window after navigating",
  );
  assert(
    (await again.getByPlaceholder("例如：个人网站").inputValue()) === cloudDraft,
    "Reopening preserves the cloud page's unsent input instead of reloading it",
  );
  await again.close();
  await other.close();

  await seedHistory();
  await seedSessionCatalog(win, {
    [localAlpha.id]: {
      sessions: [
        {
          id: sessionId,
          engineSessionId: sessionId,
          title: sessionTitle,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      activeSessionId: null,
    },
  });
  // Reload the production renderer against persisted native history and the
  // durable registry, so runtime controls restore each saved cloud mapping.
  await win.reload();
  await viewProjectReadOnly(win);
  assert(
    (await storedBinding(win, localAlpha)) === alphaUrl &&
      (await storedBinding(win, localBeta)) === betaUrl,
    "Reload restores both projects' independent cloud mappings",
  );
  const historySidebar = await openSidebar(win);
  const alphaGroup = historySidebar.getByRole("button", { name: localAlpha.name, exact: true });
  if ((await alphaGroup.getAttribute("aria-expanded")) === "false") await alphaGroup.click();
  await historySidebar.getByRole("button", { name: sessionTitle, exact: true }).click();
  await viewProjectReadOnly(win);
  await win.getByText(historicalMessage, { exact: true }).waitFor();
  await locationTrigger(win).waitFor({ state: "visible" });
  const established = await openCloudDialog(win, { change: true });
  assert(
    (await established.input.inputValue()) === alphaUrl,
    "Established conversations can change their project's existing cloud target",
  );
  await win.keyboard.press("Escape");
  await established.dialog.waitFor({ state: "hidden" });

  for (const language of ["zh", "en"]) {
    if (language === "en") {
      const settings = await openSettingsMenu(win);
      await settings.getByRole("menuitem", { name: /^(切换语言|Switch language)$/ }).click();
      await win
        .getByRole("menu", { name: /^(切换语言|Switch language)$/ })
        .getByRole("menuitemradio", { name: "English", exact: true })
        .click();
      await settings.waitFor({ state: "hidden" });
      await closeDrawer(win);
    }
    for (const width of [1280, 390]) {
      await win.setViewportSize({ width, height: 760 });
      const responsive = await openCloudDialog(win, { change: true });
      assert(
        (await responsive.input.inputValue()) === alphaUrl,
        "Responsive forms retain the selected project's binding",
      );
      await win.waitForFunction(
        (node) => node === document.activeElement,
        await responsive.input.elementHandle(),
      );
      for (let index = 0; index < 6; index++) {
        await win.keyboard.press("Tab");
        assert(
          await responsive.dialog.evaluate((node) => node.contains(document.activeElement)),
          "Cloud project form retains keyboard focus",
        );
      }
      await win.keyboard.press("Escape");
      await responsive.dialog.waitFor({ state: "hidden" });
      await win.waitForFunction(
        (node) => node === document.activeElement,
        await responsive.trigger.elementHandle(),
      );
      assert(
        await locationTrigger(win).isVisible(),
        "Canceling a cloud target keeps this computer selected",
      );
      assert(app.windows().length === 1, "Canceling a cloud target opens no remote window");
    }
  }
  assert(errors.length === 0 && cloudErrors.length === 0, "No renderer exceptions occurred");
  console.log(
    "PASS: direct local folder picker -> existing project Work in menu -> explicit cloud URL/login isolation -> per-project bindings -> same-origin project windows coexist and preserve navigation/drafts -> established conversations -> responsive Chinese/English focus and screenshots",
  );
} catch (error) {
  if (win) {
    if (screenshotDir)
      await win
        .screenshot({
          path: join(screenshotDir, "existing-project-failure.png"),
          scale: "css",
          animations: "disabled",
        })
        .catch(() => {});
    console.error(
      "Desktop failure state:",
      await win
        .evaluate(() => ({
          text: document.body.innerText.slice(-8000),
          sidebarButtons: Array.from(document.querySelectorAll("aside button")).map((button) => ({
            text: button.textContent,
            label: button.getAttribute("aria-label"),
            title: button.getAttribute("title"),
          })),
          menus: Array.from(document.querySelectorAll('[role="menu"]')).map((menu) => ({
            label: menu.getAttribute("aria-label"),
            labelledBy: menu.getAttribute("aria-labelledby"),
          })),
        }))
        .catch(() => ({})),
    );
    console.error(
      "Local registry:",
      await win.evaluate(() => window.codeshell.projectRegistry.list()).catch(() => []),
    );
  }
  if (processLog) console.error("Electron output:", processLog);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await control?.close();
  await isolated.cleanup();
}
