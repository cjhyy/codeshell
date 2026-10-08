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
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-native-cloud-e2e-");
let app, control;
try {
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
  await navigateSettingsMenu(win, /^(云端工作台|Cloud workbench)$/);
  const prompt = win.getByRole("dialog", { name: /^(云端工作台|Cloud workbench)$/ });
  await prompt.getByPlaceholder("https://cloud.example.com").fill(control.url);
  const opened = app.waitForEvent("window");
  await prompt.getByRole("button", { name: /打开工作台|Open workbench/ }).click();
  const cloud = await opened;
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
  await navigateSettingsMenu(win, /^(云端工作台|Cloud workbench)$/);
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
  const settings = drawer.getByRole("button", { name: /^(设置|Settings)$/ });
  await win.waitForFunction(
    (node) => node === document.activeElement,
    await settings.elementHandle(),
  );
  assert(
    (await win.locator('[data-sidebar-action="toggle"]').getAttribute("aria-expanded")) === "true",
    "Escape closes only the Cloud prompt and keeps the narrow sidebar open",
  );
  assert(app.windows().length === 1, "Cancelling the Cloud prompt opens no remote window");
  await win.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await win.setViewportSize({ width: 1280, height: 820 });

  await navigateSettingsMenu(win, /^(云端工作台|Cloud workbench)$/);
  await prompt.getByPlaceholder("https://cloud.example.com").waitFor();
  assert(
    (await prompt.getByPlaceholder("https://cloud.example.com").inputValue()) === `${control.url}/`,
    "Last cloud address not restored",
  );
  const reopened = app.waitForEvent("window");
  await prompt.getByRole("button", { name: /打开工作台|Open workbench/ }).click();
  const again = await reopened;
  await again.getByRole("heading", { name: "Cloud-only project", exact: true }).waitFor();
  assert(errors.length === 0 && cloudErrors.length === 0, "Renderer errors occurred");
  console.log(
    "PASS: production Desktop settings menu -> isolated cloud window -> real Hub login -> cloud project creation -> unchanged local registry -> narrow Cloud prompt focus/Tab/Escape -> login/project preserved on reopen",
  );
} finally {
  await app?.close().catch(() => {});
  await control?.close();
  await isolated.cleanup();
}
