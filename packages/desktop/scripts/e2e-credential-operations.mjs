/* Real Electron credential mutation retries. Only synthetic credentials are
 * written, through production IPC/storage, in a fresh HOME. The bootstrap wraps
 * those IPC handlers to defer/reject individual calls before their real write. */
/* global document, window, localStorage */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-credential-operations-");
let app;
let win;
let stage = "startup";
const rendererErrors = [];
const bootstrap = join(isolated.home, "credential-operations.cjs");
const physicalRequests = [];
const server = createServer((request, response) => {
  physicalRequests.push(request.url);
  if (request.url === "/favicon.ico") return response.writeHead(204).end();
  if (request.url !== "/login") return response.writeHead(404).end();
  response.writeHead(200, {
    "Content-Type": "text/html",
    "Set-Cookie": "synthetic-login=owned-fixture; HttpOnly; SameSite=Lax; Path=/",
  });
  response.end(
    "<!doctype html><title>Owned sign-in fixture</title><h1>Signed in to the owned fixture</h1>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function setup() {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(join(isolated.codeShellHome, "settings.json"), '{"autoUpdates":false}\n');
  await writeFile(
    bootstrap,
    `const { ipcMain, app, net } = require("electron");
const fixture = globalThis.__credentialOperations = {calls: {}, commits: {}, saveTargets: [], fail: null, defer: null, release: null, network: 0};
const deny = () => { fixture.network++; throw new Error("Credential operations fixture forbids network"); };
globalThis.fetch = async () => deny();
for (const name of ["node:http", "node:https"]) { const transport = require(name); transport.request = deny; transport.get = deny; }
net.request = deny; net.fetch = deny;
require("node:module").syncBuiltinESMExports();
app.on("web-contents-created", (_event, contents) => contents.session.webRequest.onBeforeRequest({urls:["http://*/*", "https://*/*"]}, (details, done) => {
  const url = new URL(details.url);
  if (url.origin === ${JSON.stringify(origin)} && ["/login", "/favicon.ico"].includes(url.pathname)) return done({cancel:false});
  fixture.network++; done({cancel:true});
}));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  if (["credentials:save", "credentials:patchMeta", "credentials:remove", "credentials:loginCapture", "credentials:captureAllCookiesAllSessions"].includes(channel)) {
    fixture.calls[channel] = (fixture.calls[channel] || 0) + 1;
    if (channel === "credentials:save") fixture.saveTargets.push(args[1]);
    if (fixture.defer === channel) { fixture.defer = null; await new Promise(resolve => { fixture.release = resolve; }); fixture.release = null; }
    if (fixture.fail === channel) { fixture.fail = null; throw new Error("Synthetic credential operation failure"); }
  }
  const result = await listener(...args);
  if (["credentials:save", "credentials:patchMeta", "credentials:remove"].includes(channel)) fixture.commits[channel] = (fixture.commits[channel] || 0) + 1;
  return result;
});
`,
    { mode: 0o600 },
  );
  await launch();
}

async function launch() {
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainBootstrap: bootstrap,
    env: { NODE_OPTIONS: `--require ${bootstrap}`, CODE_SHELL_TEST_HOME: isolated.codeShellHome },
  });
  win = await findCodeShellWindow(app);
  win.on("pageerror", (error) => rendererErrors.push(error));
  await win.evaluate(() => localStorage.setItem("codeshell.uiLanguage", "zh"));
  await win.reload();
  await win.setViewportSize({ width: 390, height: 844 });
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (await viewOnly.isVisible()) await viewOnly.click();
  await navigateSettingsMenu(win, /^(凭证|Credentials)$/i);
  await win.getByRole("tab", { name: /^(?:API 密钥|API keys)(?:\s|$)/i }).click();
}

async function arm(channel, { fail = false, defer = false } = {}) {
  await app.evaluate(
    (_electron, { channel, fail, defer }) => {
      const fixture = globalThis.__credentialOperations;
      fixture.fail = fail ? channel : null;
      fixture.defer = defer ? channel : null;
    },
    { channel, fail, defer },
  );
}

async function release() {
  await app.evaluate(() => globalThis.__credentialOperations.release?.());
}

async function calls(channel) {
  return app.evaluate(
    (_electron, channel) => globalThis.__credentialOperations.calls[channel] ?? 0,
    channel,
  );
}

async function errorVisible() {
  await win
    .locator('[role="status"]')
    .getByText(/操作失败|Operation failed|请重试|try again/i)
    .last()
    .waitFor({ timeout: 3_000 });
}

async function clearToasts() {
  const dismiss = win.locator('[role="status"]').getByRole("button", { name: /关闭|Dismiss/ });
  while (await dismiss.count()) await dismiss.first().click();
}

async function waitPending() {
  await app.evaluate(async () => {
    const deadline = Date.now() + 3_000;
    while (!globalThis.__credentialOperations.release && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!globalThis.__credentialOperations.release) throw new Error("Deferred IPC was not reached");
  });
}

async function list() {
  return win.evaluate(() => window.codeshell.credentials.list(""));
}

async function waitForStored(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const items = await list();
    if (predicate(items)) return items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Credential operation did not complete in production storage");
}

async function loginWindow() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (candidate === win) continue;
      if (
        await candidate
          .locator("#__cs_login_bar__")
          .isVisible()
          .catch(() => false)
      )
        return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Production login window did not expose its save/cancel toolbar");
}

async function confirmDialog() {
  const dialog = win.getByRole("dialog");
  await dialog.getByRole("button", { name: /^(确认|确定|Confirm)$/ }).click();
  await dialog.waitFor({ state: "hidden" });
}

try {
  await setup();
  stage = "token save failure";
  await win.locator("#token-id").fill("synthetic-token");
  await win.locator("#token-name").fill("Synthetic account");
  await win.locator("#token-secret").fill("synthetic-credential-no-provider");
  const save = win
    .locator("[data-token-page]")
    .getByRole("button", { name: /保存|Save/ })
    .first();
  await arm("credentials:save", { fail: true, defer: true });
  await save.click();
  await waitPending();
  const pendingSaveDisabled = await save.isDisabled();
  const pendingDraftDisabled = await win.locator("#token-id").isDisabled();
  await win.setViewportSize({ width: 820, height: 900 });
  const saveBox = await save.boundingBox();
  await win.mouse.click(saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2);
  assert(
    (await calls("credentials:save")) === 1,
    "A physical repeated click issued a second pending save",
  );
  await release();
  await errorVisible();
  assert(pendingSaveDisabled, "A pending token save remained clickable");
  assert(pendingDraftDisabled, "A pending token save allowed editing its draft");
  assert(
    (await win.locator("#token-id").inputValue()) === "synthetic-token",
    "A rejected token save lost its draft",
  );
  assert((await calls("credentials:save")) === 1, "A single token save issued multiple writes");
  assert(rendererErrors.length === 0, "Credential failure escaped as a renderer error");
  console.log(
    "PASS token save failure: pending lock, visible error, draft retained, no renderer errors",
  );
  stage = "token retry";
  await save.click();
  const card = win.getByRole("article", { name: "Synthetic account" });
  await card.waitFor();
  assert(
    (await win.locator("#token-secret").inputValue()) === "",
    "Successful token save retained its secret draft",
  );
  assert((await calls("credentials:save")) === 2, "Retry did not use exactly one production write");
  console.log(
    "PASS token retry: production IPC persists the synthetic credential and clears draft",
  );
  stage = "token permissions";
  await clearToasts();
  const aiUse = card.getByRole("switch").nth(0);
  await arm("credentials:patchMeta", { fail: true, defer: true });
  await aiUse.click();
  await waitPending();
  assert(await aiUse.isDisabled(), "Pending permission write remained interactive");
  await release();
  await errorVisible();
  assert(
    (await aiUse.getAttribute("aria-checked")) === "false",
    "Rejected permission write changed the visible grant",
  );
  assert(
    (await list()).find((item) => item.id === "synthetic-token").autoUseByAI !== true,
    "Rejected permission write persisted a grant",
  );
  await aiUse.click();
  await win.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Synthetic account"] [role="switch"]')
        ?.getAttribute("aria-checked") === "true",
  );
  const envSwitch = card.getByRole("switch").nth(1);
  const beforeCancel = await calls("credentials:patchMeta");
  await envSwitch.click();
  await win
    .getByRole("dialog")
    .getByRole("button", { name: /^(取消|Cancel)$/ })
    .click();
  await win.getByRole("dialog").waitFor({ state: "hidden" });
  assert(
    (await calls("credentials:patchMeta")) === beforeCancel,
    "Cancelled environment prompt wrote metadata",
  );
  await envSwitch.click();
  await win.getByRole("dialog").getByRole("textbox").fill("SYNTHETIC_OPERATION_TOKEN");
  await confirmDialog();
  await card.getByText("env · SYNTHETIC_OPERATION_TOKEN", { exact: true }).waitFor();
  console.log(
    "PASS token grants: rejected write leaves grant off; retry enables it; env prompt cancel has zero writes and confirmation persists one write",
  );

  stage = "token deletion cancellation";
  const tokenDelete = card.getByRole("button", { name: /删除/ });
  const beforeDeleteCancel = await calls("credentials:remove");
  await tokenDelete.click();
  await win
    .getByRole("dialog")
    .getByRole("button", { name: /^(取消|Cancel)$/ })
    .click();
  await win.getByRole("dialog").waitFor({ state: "hidden" });
  assert(
    (await calls("credentials:remove")) === beforeDeleteCancel,
    "Cancelled token deletion wrote storage",
  );
  assert(await card.isVisible(), "Cancelled token deletion removed its card");

  stage = "cookie login rejection and cancellation";
  await win.setViewportSize({ width: 390, height: 844 });
  await win.getByRole("tab", { name: /^(?:网站登录|Website sign-ins)(?:\s|$)/i }).click();
  const loginUrl = win.locator("#cookie-login-url");
  await loginUrl.fill(`${origin}/login`);
  const login = win.getByRole("button", { name: /弹窗登录并保存|Sign in.*save/i });
  await clearToasts();
  await arm("credentials:loginCapture", { fail: true, defer: true });
  await login.click();
  await waitPending();
  assert(await loginUrl.isDisabled(), "Pending login allowed its URL to change");
  await release();
  await errorVisible();
  assert((await loginUrl.inputValue()) === `${origin}/login`, "Rejected login erased its URL");
  const beforeLoginCancel = await calls("credentials:save");
  await login.click();
  const cancelledWindow = await loginWindow();
  await cancelledWindow.getByRole("button", { name: "取消", exact: true }).click();
  await loginUrl.waitFor({ state: "visible" });
  await win.waitForFunction(() => !document.querySelector("#cookie-login-url")?.disabled);
  assert(
    (await calls("credentials:save")) === beforeLoginCancel,
    "Cancelling the real login window saved a credential",
  );
  assert(
    (await loginUrl.inputValue()) === `${origin}/login`,
    "Cancelling the login window erased its URL",
  );

  stage = "cookie production login save";
  await login.click();
  const savedWindow = await loginWindow();
  await savedWindow.getByRole("button", { name: "我已登录,保存", exact: true }).click();
  await win.waitForFunction(() => document.querySelector("#cookie-login-url")?.value === "");
  const cookie = (await list()).find((item) => item.type === "cookie");
  assert(
    cookie?.hasSecret === true && cookie.meta?.domain === "127.0.0.1",
    "Production login failed to persist the owned cookie jar",
  );
  assert(
    (await calls("credentials:save")) === beforeLoginCancel + 1,
    "Production login save issued more than one write",
  );
  const cookieCard = win.getByRole("article", { name: cookie.label, exact: true });
  await cookieCard.waitFor();
  console.log(
    "PASS cookie login: real isolated BrowserHost cancel creates no credential; real save captures owned HTTP cookie and persists one encrypted jar",
  );

  stage = "cookie rename rejection and retry";
  await clearToasts();
  await cookieCard.getByRole("button", { name: /编辑/ }).click();
  await win.getByRole("dialog").getByRole("textbox").fill("Renamed owned cookie");
  await arm("credentials:patchMeta", { fail: true });
  await confirmDialog();
  await errorVisible();
  assert(
    (await list()).find((item) => item.id === cookie.id).label === cookie.label,
    "Rejected rename changed the durable cookie label",
  );
  await cookieCard.getByRole("button", { name: /编辑/ }).click();
  await win.getByRole("dialog").getByRole("textbox").fill("Renamed owned cookie");
  await confirmDialog();
  await win.getByRole("article", { name: "Renamed owned cookie", exact: true }).waitFor();
  assert(rendererErrors.length === 0, "Credential retries emitted renderer errors");

  stage = "durable restart recovery";
  const firstReceipt = await app.evaluate(() => ({
    calls: globalThis.__credentialOperations.calls,
    commits: globalThis.__credentialOperations.commits,
    network: globalThis.__credentialOperations.network,
  }));
  assert(firstReceipt.network === 0, "Credential flow attempted an unowned network origin");
  assert(
    firstReceipt.calls["credentials:save"] === 3 && firstReceipt.commits["credentials:save"] === 2,
    "Token retry/cookie capture write receipt changed",
  );
  assert(
    firstReceipt.calls["credentials:patchMeta"] === 5 &&
      firstReceipt.commits["credentials:patchMeta"] === 3,
    "Permission/rename write receipt changed",
  );
  await app.close();
  await launch();
  const restored = await list();
  assert(
    restored.find((item) => item.id === "synthetic-token")?.autoUseByAI === true,
    "Restart lost the saved token grant",
  );
  assert(
    restored.find((item) => item.id === "synthetic-token")?.exposeAsEnv ===
      "SYNTHETIC_OPERATION_TOKEN",
    "Restart lost the token environment binding",
  );
  assert(
    restored.find((item) => item.id === cookie.id)?.label === "Renamed owned cookie",
    "Restart lost the cookie rename",
  );
  console.log(
    "PASS restart: real disk storage restores token grant/env binding and renamed cookie with masked secrets",
  );

  stage = "token deletion rejection and retry";
  const restoredToken = win.getByRole("article", { name: "Synthetic account", exact: true });
  await restoredToken.waitFor();
  await arm("credentials:remove", { fail: true, defer: true });
  await restoredToken.getByRole("button", { name: /删除/ }).click();
  await confirmDialog();
  await waitPending();
  assert(
    await restoredToken.getByRole("button", { name: /删除/ }).isDisabled(),
    "Pending delete remained clickable",
  );
  await release();
  await errorVisible();
  assert(await restoredToken.isVisible(), "Rejected delete removed its token card");
  await restoredToken.getByRole("button", { name: /删除/ }).click();
  await confirmDialog();
  await restoredToken.waitFor({ state: "hidden" });
  assert(
    !(await list()).some((item) => item.id === "synthetic-token"),
    "Retry did not remove the token from real storage",
  );

  stage = "cookie deletion rejection and retry";
  await win.getByRole("tab", { name: /^(?:网站登录|Website sign-ins)(?:\s|$)/i }).click();
  const restoredCookie = win.getByRole("article", { name: "Renamed owned cookie", exact: true });
  await clearToasts();
  await arm("credentials:remove", { fail: true });
  await restoredCookie.getByRole("button", { name: /删除/ }).click();
  await confirmDialog();
  await errorVisible();
  assert(await restoredCookie.isVisible(), "Rejected delete removed its cookie card");
  await restoredCookie.getByRole("button", { name: /删除/ }).click();
  await confirmDialog();
  await restoredCookie.waitFor({ state: "hidden" });
  assert((await list()).length === 0, "Credential deletion left an unexpected stored record");
  const lastReceipt = await app.evaluate(() => ({
    calls: globalThis.__credentialOperations.calls,
    commits: globalThis.__credentialOperations.commits,
    network: globalThis.__credentialOperations.network,
  }));
  assert(
    lastReceipt.network === 0 && rendererErrors.length === 0,
    "Credentials emitted an external request or renderer error",
  );
  assert(
    lastReceipt.calls["credentials:remove"] === 4 &&
      lastReceipt.commits["credentials:remove"] === 2,
    "Credential delete retry write receipt changed",
  );
  await app.close();
  await launch();
  assert((await list()).length === 0, "Restart restored a successfully deleted credential");
  stage = "credential target project picker setup";
  const projectA = join(isolated.home, "project-a");
  const projectB = join(isolated.home, "project-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await win.setViewportSize({ width: 1280, height: 900 });
  await expandSidebar(win);
  await app.evaluate(
    ({ dialog }, paths) => {
      globalThis.__credentialOperations.projectPickerCalls = 0;
      dialog.showOpenDialog = async () => {
        globalThis.__credentialOperations.projectPickerCalls++;
        return { canceled: false, filePaths: [paths.shift()] };
      };
    },
    [projectA, projectB],
  );
  for (const name of ["project-a", "project-b"]) {
    await win
      .getByRole("button", { name: /^(新项目|New project)$/ })
      .first()
      .click();
    await win
      .getByRole("dialog")
      .getByRole("button", { name: /^(此计算机|This computer)/i })
      .click();
    const trust = win.getByRole("button", { name: /仅查看|View only/i });
    if (
      await trust
        .waitFor({ state: "visible", timeout: 2_000 })
        .then(() => true)
        .catch(() => false)
    )
      await trust.click();
    await win
      .locator("#codeshell-sidebar-navigation")
      .getByRole("button", { name, exact: true })
      .waitFor();
  }
  const selectProject = async (name) => {
    await win
      .locator("#codeshell-sidebar-navigation")
      .getByRole("button", { name, exact: true })
      .click();
    const trust = win.getByRole("button", { name: /仅查看|View only/i });
    if (await trust.isVisible()) await trust.click();
  };
  stage = "credential target select project A";
  await selectProject("project-a");
  stage = "credential target save project A";
  await win.locator("#token-id").fill("project-a-token");
  await win.locator("#token-name").fill("Project A token");
  await win.locator("#token-secret").fill("owned-project-a-fixture");
  await arm("credentials:save", { defer: true });
  await win
    .locator("[data-token-page]")
    .getByRole("button", { name: /保存|Save/ })
    .first()
    .click();
  await waitPending();
  stage = "credential target select project B";
  await selectProject("project-b");
  await win.waitForFunction(
    () => {
      const input = document.querySelector("#token-id");
      return input && !input.disabled && input.value === "";
    },
    null,
    { timeout: 3_000 },
  );
  assert(
    await win.locator("#token-id").isEnabled(),
    "Project B inherited project A's pending credential operation",
  );
  assert(
    (await win.locator("#token-id").inputValue()) === "",
    "Project B inherited project A's credential draft",
  );
  await win.locator("#token-id").fill("project-b-draft");
  await win.locator("#token-name").fill("Project B draft");
  await release();
  stage = "credential target token completion";
  await waitForStored((items) => items.some((item) => item.id === "project-a-token"));
  assert(
    (await win.locator("#token-id").inputValue()) === "project-b-draft",
    "Project A completion erased project B's new credential draft",
  );
  assert(
    (await app.evaluate(() => globalThis.__credentialOperations.saveTargets)).every(
      (cwd) => cwd === projectA,
    ),
    "Project A credential write was redirected to project B",
  );
  await win.getByRole("tab", { name: /^(?:网站登录|Website sign-ins)(?:\s|$)/i }).click();
  await selectProject("project-a");
  await win.locator("#cookie-login-url").fill(`${origin}/login`);
  await win.getByRole("button", { name: /弹窗登录并保存|Sign in.*save/i }).click();
  const oldLoginWindow = await loginWindow();
  await selectProject("project-b");
  await win.waitForFunction(
    () => {
      const input = document.querySelector("#cookie-login-url");
      return input && !input.disabled && input.value === "";
    },
    null,
    { timeout: 3_000 },
  );
  assert(
    await win.locator("#cookie-login-url").isEnabled(),
    "Project B inherited project A's pending login window",
  );
  await win.locator("#cookie-login-url").fill("https://project-b-draft.invalid/sign-in");
  await oldLoginWindow.getByRole("button", { name: "我已登录,保存", exact: true }).click();
  stage = "credential target cookie login completion";
  await waitForStored((items) => items.some((item) => item.type === "cookie"));
  assert(
    (await win.locator("#cookie-login-url").inputValue()) ===
      "https://project-b-draft.invalid/sign-in",
    "Project A login completion erased project B's URL draft",
  );
  assert(
    (await app.evaluate(() => globalThis.__credentialOperations.saveTargets)).every(
      (cwd) => cwd === projectA,
    ),
    "Project A login save was redirected to project B",
  );
  const targetReceipt = await app.evaluate(() => ({
    calls: globalThis.__credentialOperations.calls,
    commits: globalThis.__credentialOperations.commits,
    saveTargets: globalThis.__credentialOperations.saveTargets,
    network: globalThis.__credentialOperations.network,
  }));
  console.log(`Credential target receipt: ${JSON.stringify(targetReceipt)}`);
  assert(
    targetReceipt.commits["credentials:save"] === 2 &&
      targetReceipt.network === 0 &&
      rendererErrors.length === 0,
    "Cross-project operations wrote unexpected state or emitted an error",
  );
  console.log(
    "PASS cross-project pending completion: project B starts fresh and editable; project A token/login writes retain A authority and preserve B's new drafts",
  );
  console.log(
    `Credential operation receipts: ${JSON.stringify({ firstReceipt, lastReceipt, targetReceipt, physicalRequests })}`,
  );
  console.log("CodeShell credential operations E2E: passed");
} catch (error) {
  console.error(`Credential operations failed during ${stage}: ${error?.name ?? "Error"}`);
  console.error(`Renderer error count: ${rendererErrors.length}`);
  if (error?.name === "Error") console.error(String(error.message).split("\n")[0]);
  if (stage.includes("credential target")) {
    console.error(
      await win
        .locator("#codeshell-sidebar-navigation")
        .getByRole("button")
        .allTextContents()
        .catch(() => []),
    );
    await win
      .screenshot({ path: "/private/tmp/codeshell-credential-target-failure.png" })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await release().catch(() => {});
  if (app) await app.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await isolated.cleanup();
}
