/*
 * Real Electron Link-page smoke.
 *
 * Boots the production main/preload/renderer stack in an isolated HOME and
 * proves the four independent credential categories, local/server Link split,
 * ten-provider catalog, five zero-copy CLI entry points, manual credential
 * fallback, and responsive layout.
 */
/* global document */
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
const isolated = await makeIsolatedElectronHome("codeshell-link-e2e-");
const projectPath = join(isolated.home, "link-project");
const screenshotDir = process.env.CODESHELL_LINK_SCREENSHOT_DIR;
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
  const heading = win.locator(`${selector} section`).first().getByRole("heading", { level: 2 });
  const box = await heading.boundingBox();
  assert(box && box.width >= 160, `${label} hero heading collapsed to ${box?.width ?? 0}px`);
}

async function openCliDialog(providerId, providerName, quickAuthPattern) {
  const card = win.locator(
    `article[data-link-integration="${providerId}"][data-link-runtime="local"]`,
  );
  await card.getByRole("button", { name: /连接本地|Connect locally/i }).click();
  const dialog = win.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: new RegExp(`连接 ${providerName}|Connect ${providerName}`, "i") })
    .waitFor({ state: "visible", timeout: 15_000 });
  await dialog.getByText(quickAuthPattern).first().waitFor({ state: "visible", timeout: 15_000 });
  await dialog
    .getByRole("button", { name: /打开创建页面|Open credential page/i })
    .waitFor({ state: "visible" });
  return dialog;
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
  await dismissTrustDialog(win);

  await win.getByRole("button", { name: /^(凭证|Credentials)$/i }).click();
  await win
    .getByRole("heading", { name: /^(凭证|Credentials)$/i })
    .waitFor({ state: "visible", timeout: 20_000 });

  assert((await win.getByRole("tab").count()) === 4, "Credentials page did not render four tabs");
  await win.locator("[data-cookie-page]").waitFor({ state: "visible", timeout: 20_000 });
  await assertNoHorizontalOverflow("desktop Cookie page");
  await screenshot("credentials-cookie.png");

  await win.getByRole("tab", { name: /^Permission Token$/i }).click();
  await win.locator("[data-token-page]").waitFor({ state: "visible", timeout: 20_000 });
  await assertNoHorizontalOverflow("desktop Permission Token page");
  await screenshot("credentials-token.png");

  await win.getByRole("tab", { name: /^(沟通渠道|Channels)$/i }).click();
  await win.locator("[data-channel-page]").waitFor({ state: "visible", timeout: 20_000 });
  await assertNoHorizontalOverflow("desktop Channels page");
  await screenshot("credentials-channels.png");

  await win.getByRole("tab", { name: /^Link$/i }).click();
  await win.locator("[data-link-page]").waitFor({ state: "visible", timeout: 20_000 });

  assert(
    (await win.locator('[data-link-runtime-section="local"]').count()) === 1,
    "Link page did not render one independent local section",
  );
  assert(
    (await win.locator('[data-link-runtime-section="server"]').count()) === 1,
    "Link page did not render one independent server section",
  );
  assert(
    (await win.locator('article[data-link-runtime="local"]').count()) === 10,
    "Link page did not render all ten local provider methods",
  );
  assert(
    (await win.locator('article[data-link-runtime="server"]').count()) === 10,
    "Link page did not render all ten server provider methods",
  );
  await assertNoHorizontalOverflow("desktop Link page");
  await screenshot("link-desktop.png");

  const quickAuthProviders = [
    ["github", "GitHub", /使用 GitHub CLI 登录|Sign in with GitHub CLI/i],
    ["gitlab", "GitLab", /使用 GitLab CLI 登录|Sign in with GitLab CLI/i],
    ["notion", "Notion", /使用 Notion CLI 登录|Sign in with Notion CLI/i],
    ["todoist", "Todoist", /使用 Todoist CLI 登录|Sign in with Todoist CLI/i],
    ["vercel", "Vercel", /使用 Vercel CLI 登录|Sign in with Vercel CLI/i],
  ];
  for (const [providerId, providerName, pattern] of quickAuthProviders) {
    const dialog = await openCliDialog(providerId, providerName, pattern);
    if (providerId === "github") {
      await win.waitForTimeout(350);
      await screenshot("link-github-connect.png");
    }
    await dialog.getByRole("button", { name: "Close" }).click();
    await dialog.waitFor({ state: "hidden" });
  }

  await win.setViewportSize({ width: 700, height: 900 });
  const responsiveTabs = [
    [/^Cookie$/i, "[data-cookie-page]", "Cookie", "credentials-cookie-mobile.png"],
    [
      /^Permission Token$/i,
      "[data-token-page]",
      "Permission Token",
      "credentials-token-mobile.png",
    ],
    [
      /^(沟通渠道|Channels)$/i,
      "[data-channel-page]",
      "Channels",
      "credentials-channels-mobile.png",
    ],
    [/^Link$/i, "[data-link-page]", "Link", "link-mobile.png"],
  ];
  for (const [name, selector, label, screenshotName] of responsiveTabs) {
    await win.getByRole("tab", { name }).click();
    await win.locator(selector).waitFor({ state: "visible", timeout: 20_000 });
    await win.locator(`${selector} section`).first().scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(`mobile ${label} page`);
    await assertReadableHero(selector, `mobile ${label} page`);
    await screenshot(screenshotName);
  }

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
