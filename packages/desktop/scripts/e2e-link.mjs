/*
 * Real Electron Link-page smoke.
 *
 * Boots the production main/preload/renderer stack in an isolated HOME and
 * proves the four independent credential categories, ten provider dialogs
 * cards with one unified Figma API/MCP entry, five zero-copy CLI
 * entry points, manual credential fallback, and responsive layout.
 */
/* global document, window, getComputedStyle */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const isolated = await makeIsolatedElectronHome("codeshell-link-e2e-");
const projectPath = join(isolated.home, "link-project");
const screenshotDir = process.env.CODESHELL_LINK_SCREENSHOT_DIR;
const networkReceipt = join(isolated.home, "network-attempts.jsonl");
async function networkAttempts() {
  const receipt = await readFile(networkReceipt, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return receipt.trim()
    ? receipt
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}
// Match the current localized category names; descriptions use aria-description.
const credentialTabNames = {
  cookie: /^(?:网站登录|Website sign-ins)(?:\s|$)/i,
  token: /^(?:API 密钥|API keys)(?:\s|$)/i,
  channels: /^(沟通渠道|Channels)(?:\s|$)/i,
  link: /^Link(?:\s|$)/i,
};
let app;
let win;

/**
 * The first launch in an isolated home raises the trust prompt over a modal
 * overlay that swallows every click, so it must be dismissed before any
 * navigation. Same guard the other e2e scripts carry.
 */
async function dismissTrustDialog(win) {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  const opened = await viewOnly
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) await viewOnly.click();
}

async function seedFixture() {
  await mkdir(projectPath, { recursive: true });
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "desktop", "recents.json"),
    `${JSON.stringify(
      [{ path: projectPath, name: basename(projectPath), lastOpenedAt: Date.now(), pinned: true }],
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

async function screenshot(filename) {
  if (!screenshotDir) return;
  const output = join(screenshotDir, filename);
  await win.screenshot({ path: output, fullPage: true });
  console.log(`Link visual: ${output}`);
}

async function assertNoHorizontalOverflow(label) {
  const metrics = await win.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert(
    metrics.content <= metrics.viewport + 1,
    `${label} overflowed horizontally: content=${metrics.content}, viewport=${metrics.viewport}`,
  );
}

async function assertReadableHero(selector, label) {
  const heading = win.locator(selector).getByRole("heading", { level: 2 }).first();
  const box = await heading.boundingBox();
  const naturalWidth = await heading.evaluate((node) => {
    const style = getComputedStyle(node);
    const context = document.createElement("canvas").getContext("2d");
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = node.textContent ?? "";
    return (
      context.measureText(text).width +
      (parseFloat(style.letterSpacing) || 0) * Math.max(0, text.length - 1)
    );
  });
  assert(
    box && box.width >= Math.min(160, naturalWidth) - 1,
    `${label} hero heading collapsed to ${box?.width ?? 0}px`,
  );
}

async function openCliDialog(providerId, providerName) {
  const card = await expandProvider(providerId);
  const method = card.locator(
    `[data-link-method-provider="${providerId}"][data-link-runtime="local"]`,
  );
  const localConnect = method.getByRole("button", { name: /连接本地|Connect locally/i });
  if (await localConnect.isVisible()) await localConnect.click();
  else await card.locator(`[data-link-dialog-connect="${providerId}"]`).click();
  const dialog = win.getByRole("dialog", {
    name: new RegExp(`连接 ${providerName}|Connect ${providerName}`, "i"),
  });
  await dialog
    .getByRole("heading", { name: new RegExp(`连接 ${providerName}|Connect ${providerName}`, "i") })
    .waitFor({ state: "visible", timeout: 15_000 });
  const advancedModes = dialog.getByRole("button", { name: /高级设置|Advanced settings/i });
  if (await advancedModes.count()) await advancedModes.click();
  await dialog.locator('[data-link-auth-mode="cli-session"]').click();
  await dialog
    .locator('[data-link-authorization-step="local-session"]')
    .waitFor({ state: "visible" });
  await dialog
    .getByRole("button", { name: /检查登录状态|Check sign-in status/i })
    .waitFor({ state: "visible" });
  return dialog;
}

async function expandProvider(providerId) {
  const card = win.locator(`article[data-link-provider-card="${providerId}"]`);
  await card.waitFor({ state: "visible" });
  await card.locator("[data-link-provider-toggle], [data-link-primary-connect]").click();
  const dialog = win.locator(`[data-link-provider-dialog="${providerId}"]`);
  await dialog.waitFor({ state: "visible" });
  const advanced = dialog.locator(`[data-link-advanced-toggle="${providerId}"]`);
  if ((await advanced.count()) && (await advanced.getAttribute("aria-expanded")) === "false")
    await advanced.click();
  return dialog;
}

async function collapseProvider(providerId) {
  const dialog = win.locator(`[data-link-provider-dialog="${providerId}"]`);
  await dialog.locator(`[data-link-dialog-close="${providerId}"]`).click();
  await dialog.waitFor({ state: "hidden" });
}

try {
  await seedFixture();
  const networkGuard = join(isolated.home, "deny-network.cjs");
  await writeFile(
    networkGuard,
    `const hostnameOf = (input) => {
  try { return new URL(typeof input === "string" || input instanceof URL ? input : input?.url ?? (input?.hostname || input?.host ? "https://" + (input.hostname || input.host) : "https://unknown.invalid")).hostname; }
  catch { return "unknown.invalid"; }
};
const deny = (input) => { require("node:fs").appendFileSync(${JSON.stringify(networkReceipt)}, JSON.stringify({ pid: process.pid, hostname: hostnameOf(input) }) + "\\n", { mode: 0o600 }); throw new Error("Link fixture forbids network"); };
globalThis.fetch = async (input) => deny(input);
for (const name of ["node:http", "node:https"]) {
  const transport = require(name);
  transport.request = deny;
  transport.get = deny;
}
require("node:module").syncBuiltinESMExports();
`,
    { mode: 0o600 },
  );
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainBootstrap: networkGuard,
    env: {
      NODE_OPTIONS: `--require ${networkGuard}`,
      CODE_SHELL_REMOTE_LINK_DISABLED: "1",
      CODESHELL_GITHUB_APP_CLIENT_ID: "",
      CODESHELL_GITLAB_OAUTH_CLIENT_ID: "",
    },
  });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1_440, height: 960 });
  await win.locator("#root").waitFor({ state: "visible", timeout: 20_000 });
  await dismissTrustDialog(win);

  await navigateSettingsMenu(win, /^(凭证|Credentials)$/i);
  await win
    .getByRole("heading", { name: /^(凭证|Credentials)$/i })
    .waitFor({ state: "visible", timeout: 20_000 });

  assert((await win.getByRole("tab").count()) === 4, "Credentials page did not render four tabs");
  await win.locator("[data-cookie-page]").waitFor({ state: "visible", timeout: 20_000 });
  await assertNoHorizontalOverflow("desktop Cookie page");
  await screenshot("credentials-cookie.png");

  await win.getByRole("tab", { name: credentialTabNames.token }).click();
  await win.locator("[data-token-page]").waitFor({ state: "visible", timeout: 20_000 });
  await assertNoHorizontalOverflow("desktop Permission Token page");
  await screenshot("credentials-token.png");

  await win.getByRole("tab", { name: credentialTabNames.channels }).click();
  await win.locator("[data-channel-page]").waitFor({ state: "visible", timeout: 20_000 });
  await assertNoHorizontalOverflow("desktop Channels page");
  await screenshot("credentials-channels.png");

  await win.getByRole("tab", { name: credentialTabNames.link }).click();
  await win.locator("[data-link-page]").waitFor({ state: "visible", timeout: 20_000 });

  await win.locator('article[data-link-provider-card="github"]').waitFor({ state: "visible" });
  assert(
    (await win.locator("[data-link-runtime-section]").count()) === 0,
    "Link page retained the old runtime directory split",
  );
  const providerIds = await win
    .locator("article[data-link-provider-card]")
    .evaluateAll((cards) => cards.map((card) => card.dataset.linkProviderCard));
  const expectedProviders = [
    "github",
    "gitlab",
    "sentry",
    "vercel",
    "slack",
    "notion",
    "linear",
    "todoist",
    "airtable",
    "figma",
  ];
  assert(
    JSON.stringify([...providerIds].sort()) === JSON.stringify([...expectedProviders].sort()),
    `Link directory does not contain exactly one card per service: ${JSON.stringify(providerIds)}`,
  );
  for (const providerId of expectedProviders) {
    const card = win.locator(`article[data-link-provider-card="${providerId}"]`);
    assert(
      (await card
        .locator("[data-link-provider-toggle], [data-link-primary-connect]")
        .getAttribute("data-state")) === "closed",
      `${providerId} dialog was open before user interaction`,
    );
    assert(
      !(await win.locator(`[data-link-provider-details="${providerId}"]`).isVisible()),
      `${providerId} management details were initially visible`,
    );
  }
  await assertNoHorizontalOverflow("desktop Link directory");
  await screenshot("link-desktop.png");
  const figma = await expandProvider("figma");
  assert(
    (await figma
      .locator('[data-link-method-provider="figma"][data-link-runtime="local"]')
      .count()) === 1,
    "Figma local API channel is missing",
  );
  const mcp = figma.locator('[data-figma-channel="mcp"]');
  assert((await mcp.count()) === 1, "Figma official MCP channel is missing");
  const officialMcpName = /连接设计上下文|Connect design context/i;
  const officialMcpAction = mcp.getByRole("button", { name: officialMcpName });
  assert(
    (await officialMcpAction.count()) === 1 ||
      (await figma.locator('[data-link-dialog-connect="figma"]').count()) === 1,
    "Official MCP connect is missing from the Figma card",
  );
  assert(
    (await win.getByRole("button", { name: officialMcpName }).count()) ===
      (await officialMcpAction.count()),
    "Official Figma MCP connect leaked outside the unified card",
  );
  assert(
    (await mcp.locator("[data-figma-mcp-connection]").count()) === 0,
    "An isolated unauthenticated HOME acquired a Figma MCP connection",
  );
  assert(
    !/即将开放|Coming soon/i.test(await figma.innerText()),
    "Figma rendered failed or unavailable discovery as an unimplemented service",
  );
  const snapshot = await win.evaluate(
    (cwd) => window.codeshell.links.remoteSnapshot(cwd),
    projectPath,
  );
  assert(
    !snapshot.connections.some((connection) => connection.providerId === "figma"),
    "Viewing Figma settings created a connection without consent",
  );
  assert(
    (await networkAttempts()).length === 0,
    `Unauthenticated Link settings attempted authorization or content retrieval: ${JSON.stringify(await networkAttempts())}`,
  );
  await assertNoHorizontalOverflow("expanded Figma settings");
  await figma.evaluate((card) => card.scrollIntoView({ block: "start" }));
  await screenshot("link-figma-expanded.png");
  await collapseProvider("figma");

  const quickAuthProviders = [
    ["github", "GitHub", /使用 GitHub CLI 登录|Sign in with GitHub CLI/i],
    ["gitlab", "GitLab", /使用 GitLab CLI 登录|Sign in with GitLab CLI/i],
    ["notion", "Notion", /使用 Notion CLI 登录|Sign in with Notion CLI/i],
    ["todoist", "Todoist", /使用 Todoist CLI 登录|Sign in with Todoist CLI/i],
    ["vercel", "Vercel", /使用 Vercel CLI 登录|Sign in with Vercel CLI/i],
  ];
  for (const [providerId, providerName] of quickAuthProviders) {
    const dialog = await openCliDialog(providerId, providerName);
    if (providerId === "github") {
      await win.waitForTimeout(350);
      await screenshot("link-github-connect.png");
    }
    await dialog.locator('[data-link-auth-mode="token"]').click();
    await dialog.locator('input[name="token"][type="password"]').waitFor({ state: "visible" });
    if (providerId === "github") await screenshot("link-github-token.png");
    await dialog.getByRole("button", { name: "Close" }).click();
    await dialog.waitFor({ state: "hidden" });
    await collapseProvider(providerId);
  }

  const responsiveTabs = [
    [credentialTabNames.cookie, "[data-cookie-page]", "Cookie", "credentials-cookie-mobile.png"],
    [
      credentialTabNames.token,
      "[data-token-page]",
      "Permission Token",
      "credentials-token-mobile.png",
    ],
    [
      credentialTabNames.channels,
      "[data-channel-page]",
      "Channels",
      "credentials-channels-mobile.png",
    ],
    [credentialTabNames.link, "[data-link-page]", "Link", "link-mobile.png"],
  ];
  for (const width of [700, 390]) {
    await win.setViewportSize({ width, height: 900 });
    for (const [name, selector, label, screenshotName] of responsiveTabs) {
      await win.getByRole("tab", { name }).click();
      await win.locator(selector).waitFor({ state: "visible", timeout: 20_000 });
      await win
        .locator(selector)
        .getByRole("heading", { level: 2 })
        .first()
        .scrollIntoViewIfNeeded();
      await assertNoHorizontalOverflow(`${width}px ${label} page`);
      await assertReadableHero(selector, `${width}px ${label} page`);
      await screenshot(`${width}-${screenshotName}`);
    }
  }

  const mobileFigma = await expandProvider("figma");
  await assertNoHorizontalOverflow("mobile expanded Figma settings");
  await mobileFigma.evaluate((card) => card.scrollIntoView({ block: "start" }));
  await screenshot("link-figma-mobile.png");
  await collapseProvider("figma");

  assert(
    (await networkAttempts()).length === 0,
    "Link settings attempted network access without explicit authorization",
  );
  assert(rendererErrors.length === 0, `renderer emitted ${rendererErrors.length} page error(s)`);
  console.log("CodeShell Electron Link E2E: passed");
} catch (error) {
  if (win && screenshotDir) {
    const output = join(screenshotDir, "link-failure.png");
    await win.screenshot({ path: output, fullPage: true }).catch(() => undefined);
    console.error(`Link failure visual: ${output}`);
  }
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await isolated.cleanup();
}
