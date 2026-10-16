/* Real main/preload/renderer package-management UI in two project windows.
 * Only the native source picker is controlled; review, install, bind and restore
 * use the production UI and Host. No model or third-party credentials. */
/* global window */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  findCodeShellWindow,
  waitForAsyncFunction,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-panel-recovery-ui-");
isolated.home = await realpath(isolated.home);
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const projects = [join(isolated.home, "recovery-a"), join(isolated.home, "recovery-b")];
const source = join(isolated.home, "panel-source");
const appId = "recovery-ui-panel";
const title = "Recovery UI Panel";
let electron;
const errors = [];
const evidence = await mkdtemp(join(tmpdir(), "codeshell-panel-recovery-evidence-"));
async function writePackage(version) {
  await mkdir(join(source, ".codeshell-panel"), { recursive: true });
  await mkdir(join(source, "app"), { recursive: true });
  await writeFile(
    join(source, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: appId,
      version,
      title: { default: title },
      entry: "app/index.html",
      icon: "panel",
      singleton: true,
      placement: "right-dock",
      permissions:
        version === "1.0.0"
          ? ["context.workspace", "storage"]
          : ["context.workspace", "storage", "workspace.write"],
    }),
  );
  await writeFile(
    join(source, "app/index.html"),
    `<!doctype html><html><body>Recovery package ${version}</body></html>`,
  );
}
async function dismissTrust(win) {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 2000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
}
async function openPanels(win, project) {
  win.on("pageerror", (error) => errors.push(error.message));
  await dismissTrust(win);
  await win.evaluate((cwd) => window.codeshell.setTrust(cwd, "trusted"), project);
  await win.getByText(project.split("/").at(-1), { exact: true }).first().click();
  await dismissTrust(win);
  await win.getByRole("button", { name: /^(扩展|Extensions)$/ }).click();
  await win.getByRole("button", { name: "Panel Apps", exact: true }).click();
  await win.getByRole("button", { name: "选择源码文件夹", exact: true }).waitFor();
}
const row = (win) => win.locator("li").filter({ has: win.getByText(title, { exact: true }) });
async function binding(win, project) {
  return win.evaluate(
    async ({ cwd, id }) =>
      (await window.codeshell.getPanelAppBindings(cwd)).find((item) => item.appId === id),
    { cwd: project, id: appId },
  );
}
async function expectVersion(win, project, version) {
  await waitForAsyncFunction(
    win,
    async ({ cwd, id, version }) => {
      try {
        return (
          (await window.codeshell.getPanelAppBindings(cwd)).find((item) => item.appId === id)
            ?.version === version
        );
      } catch (error) {
        if (String(error).includes("项目面板配置已改变")) return false;
        throw error;
      }
    },
    { cwd: project, id: appId, version },
  );
  // The badge also advertises an available source update; its left side is
  // still the selected project version. A newer version alone must not pass.
  await row(win)
    .getByText(new RegExp(`^v${version.replaceAll(".", "\\.")}(?: → v\\S+)?$`))
    .waitFor();
  return binding(win, project);
}
async function expand(win) {
  const button = row(win).getByRole("button", { name: "展开", exact: true });
  if (await button.isVisible()) await button.click();
}
async function versionDialog(win, project) {
  await expand(win);
  await row(win)
    .locator("li")
    .filter({ has: win.getByText(project, { exact: true }) })
    .getByRole("button", { name: "项目版本", exact: true })
    .click();
  const dialog = win.getByRole("dialog");
  await dialog.getByText(project, { exact: true }).waitFor();
  return dialog;
}
async function reviewRestore(win, version) {
  const dialog = win.getByRole("dialog");
  await dialog.getByRole("button", { name: `审阅 v${version}`, exact: true }).click();
  await dialog.getByRole("button", { name: "确认权限并恢复项目版本", exact: true }).waitFor();
  return dialog;
}
async function confirmRestore(win) {
  await win
    .getByRole("dialog")
    .getByRole("button", { name: "确认权限并恢复项目版本", exact: true })
    .click();
  await win.getByRole("dialog").waitFor({ state: "hidden" });
}
async function closeElectron() {
  if (!electron) return;
  const closing = electron;
  electron = undefined;
  // Only this fixture's isolated child. Bound shutdown before reusing HOME.
  const child = closing.process();
  let forcedShutdown = false;
  const killTimer = setTimeout(() => {
    forcedShutdown = true;
    child.kill("SIGKILL");
  }, 10_000);
  try {
    await closing.close();
  } finally {
    clearTimeout(killTimer);
  }
  assert.equal(forcedShutdown, false, "Isolated Electron must close cleanly");
}
try {
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  for (const project of projects) {
    await mkdir(project);
    await writeFile(
      join(project, "document.json"),
      JSON.stringify({ project, schema: 1, content: "preserve my edits" }),
    );
  }
  const documents = await Promise.all(
    projects.map((project) => readFile(join(project, "document.json"), "utf8")),
  );
  await writeFile(
    join(isolated.codeShellHome, "desktop/recents.json"),
    JSON.stringify(
      projects.map((path, index) => ({
        path,
        name: path.split("/").at(-1),
        lastOpenedAt: Date.now() - index,
        pinned: true,
      })),
    ),
  );
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  await writePackage("1.0.0");
  electron = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  const first = await findCodeShellWindow(electron);
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await openPanels(first, projects[0]);
  await first.getByRole("button", { name: "选择源码文件夹", exact: true }).click();
  assert.equal(await first.getByRole("dialog").count(), 0, "Canceled picker opens no review");
  assert.equal(
    await binding(first, projects[0]),
    undefined,
    "Canceled picker cannot bind a package",
  );
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, source);
  await writeFile(join(source, ".codeshell-panel/panel.json"), "{");
  await first.getByRole("button", { name: "选择源码文件夹", exact: true }).click();
  await first
    .locator(".text-status-err")
    .filter({ hasText: /JSON|manifest|panel\.json|Unexpected/ })
    .waitFor();
  assert.equal(
    await binding(first, projects[0]),
    undefined,
    "Invalid source must not install or bind",
  );
  await writePackage("1.0.0");
  await first.getByRole("button", { name: "选择源码文件夹", exact: true }).click();
  await first.getByRole("dialog").getByText("storage", { exact: true }).waitFor();
  assert.equal(await binding(first, projects[0]), undefined, "Preview must not install or bind");
  await first.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await first.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await binding(first, projects[0]),
    undefined,
    "Canceling review cannot install or bind",
  );
  await first.getByRole("button", { name: "选择源码文件夹", exact: true }).click();
  await first.getByRole("button", { name: "确认并安装", exact: true }).dblclick();
  await first.getByRole("dialog").waitFor({ state: "hidden" });
  const original = await expectVersion(first, projects[0], "1.0.0");
  assert.ok(original.bound && original.packageDigest);

  const opened = electron.waitForEvent("window");
  await first.evaluate(() => window.codeshell.newWindow());
  const second = await opened;
  await second.locator("#root").waitFor();
  await openPanels(second, projects[1]);
  await row(second).waitFor();
  await expand(second);
  await row(second)
    .getByRole("switch", { name: /在项目 recovery-b 中启用或停用/ })
    .click();
  await waitForAsyncFunction(
    second,
    async ({ cwd, id }) => {
      try {
        return (
          (await window.codeshell.getPanelAppBindings(cwd)).find((item) => item.appId === id)
            ?.bound === true
        );
      } catch (error) {
        if (String(error).includes("项目面板配置已改变")) return false;
        throw error;
      }
    },
    { cwd: projects[1], id: appId },
  );
  assert.equal((await binding(second, projects[1])).packageDigest, original.packageDigest);

  await writePackage("2.0.0");
  await row(first)
    .getByRole("button", { name: /^(从源码更新|更新到 v\S+)$/ })
    .click();
  await first.getByRole("dialog").getByText("workspace.write", { exact: true }).waitFor();
  assert.equal((await binding(first, projects[0])).version, "1.0.0");
  await first.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await first.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await binding(first, projects[0])).packageDigest,
    original.packageDigest,
    "Canceled update preserves the project's package",
  );
  await row(first)
    .getByRole("button", { name: /^(从源码更新|更新到 v\S+)$/ })
    .click();
  await first.getByRole("dialog").getByText("workspace.write", { exact: true }).waitFor();
  await first.getByRole("button", { name: "确认并更新", exact: true }).click();
  await first.getByRole("dialog").waitFor({ state: "hidden" });
  const updated = await expectVersion(first, projects[0], "2.0.0");
  assert.notEqual(updated.packageDigest, original.packageDigest);
  await expectVersion(second, projects[1], "1.0.0");
  assert.equal((await binding(second, projects[1])).packageDigest, original.packageDigest);

  await versionDialog(first, projects[0]);
  const rollback = await reviewRestore(first, "1.0.0");
  await rollback.getByText(/切换程序版本不会恢复旧数据/).waitFor();
  assert.equal((await binding(first, projects[0])).version, "2.0.0");
  await rollback.getByRole("button", { name: "关闭版本记录", exact: true }).click();
  await first.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await binding(first, projects[0])).packageDigest,
    updated.packageDigest,
    "Canceled restore retains the current project package",
  );
  await versionDialog(first, projects[0]);
  await reviewRestore(first, "1.0.0");
  await confirmRestore(first);
  assert.equal(
    (await expectVersion(first, projects[0], "1.0.0")).packageDigest,
    original.packageDigest,
  );
  await expectVersion(second, projects[1], "1.0.0");

  // Damage the shared retained bytes. Every project selecting those bytes must
  // report unavailability rather than silently execute the newer global package.
  await writeFile(
    join(
      isolated.codeShellHome,
      "panel-apps/.versions",
      appId,
      original.packageDigest,
      "app/index.html",
    ),
    "damaged package",
  );
  await first.reload();
  await openPanels(first, projects[0]);
  await first.getByRole("button", { name: "检查可用版本", exact: true }).click();
  await first
    .getByRole("dialog")
    .getByText(/当前安装包不可用/)
    .waitFor();
  await reviewRestore(first, "2.0.0");
  assert.equal(
    await first
      .getByRole("dialog")
      .getByText(/需重新确认/)
      .count(),
    3,
  );
  assert.equal((await binding(first, projects[0])).unavailable, true);
  await confirmRestore(first);
  await expectVersion(first, projects[0], "2.0.0");
  assert.equal(
    (await binding(second, projects[1])).unavailable,
    true,
    "Repairing A must not rebind B",
  );
  await second.getByRole("button", { name: "检查可用版本", exact: true }).click();
  await reviewRestore(second, "2.0.0");
  await confirmRestore(second);
  await expectVersion(second, projects[1], "2.0.0");
  const beforeRestart = await binding(first, projects[0]);
  const originalMainPid = electron.process().pid;
  await closeElectron();
  electron = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  assert.notEqual(
    electron.process().pid,
    originalMainPid,
    "Recovery must use a fresh native process",
  );
  const restarted = await findCodeShellWindow(electron);
  await openPanels(restarted, projects[0]);
  assert.equal(
    (await expectVersion(restarted, projects[0], "2.0.0")).packageDigest,
    beforeRestart.packageDigest,
  );
  assert.equal((await binding(restarted, projects[1])).version, "2.0.0");
  assert.deepEqual(
    await Promise.all(projects.map((project) => readFile(join(project, "document.json"), "utf8"))),
    documents,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      realElectron: true,
      twoProjectWindows: true,
      installAndUpdateUi: true,
      reviewedRestoreUi: true,
      damagedPackageRepairUi: true,
      permissionReviewBeforeCommit: true,
      canceledPickerAndInstallReview: true,
      invalidSourceRetry: true,
      canceledUpdateAndRestoreReview: true,
      doubleClickInstall: true,
      coldRestartPinnedPackages: true,
      documentBytesPreserved: true,
    }),
  );
} catch (error) {
  console.error("Recovery UI failure:", error);
  console.error("Renderer errors:", errors);
  for (const [index, win] of (electron?.windows() ?? []).entries()) {
    console.error(
      `Window ${index}:`,
      await win
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
    );
    await win.screenshot({ path: join(evidence, `failure-${index}.png`) }).catch(() => {});
  }
  console.error("Evidence:", evidence);
  throw error;
} finally {
  await closeElectron();
  await isolated.cleanup();
}
