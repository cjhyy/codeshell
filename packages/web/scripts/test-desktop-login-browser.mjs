/** Owned desktop-login browser fixture; no provider, real account, or Host credentials.
 * Run through scripts/run-isolated-node-smoke.mjs.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WebsiteEntry} from './WebsiteShell.js';import './app.css';createRoot(document.getElementById('root')).render(<WebsiteEntry setupToken=""/>);`,
    resolveDir: path.join(repo, "packages/web/app"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  outdir: "/owned-output",
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = output.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = output.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "";
const origin = "https://desktop-login.fixture.invalid";
const ticket = "T".repeat(43);
const user = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  username: "desktop-user",
  displayName: "桌面测试账号",
  role: "member",
};
const rootId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const errors = [],
  blocked = [],
  results = [];
const screenshots = [];
const screenshotDirectory = process.argv.includes("--screenshots")
  ? mkdtempSync(path.join(tmpdir(), "codeshell-desktop-login-"))
  : undefined;
async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  const file = path.join(screenshotDirectory, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}
let context;
async function mount({ signedIn = true, expiresAt = Date.now() + 600000 } = {}) {
  await context?.close();
  context = await browser.newContext({ serviceWorkers: "block" });
  const calls = [];
  const state = { signedIn };
  const session = () => ({
    authenticated: state.signedIn,
    refreshRequired: false,
    cloudTarget: null,
    ...(state.signedIn
      ? {
          account: user,
          session: { id: rootId, expiresAt: Date.now() + 900000 },
          csrfToken: "C".repeat(43),
          overview: {
            account: user,
            security: { hasPassword: true, githubLinked: false },
            capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
            stats: { activeSessions: 1, loginMethods: 1 },
            features: {},
          },
        }
      : {}),
  });
  await context.routeWebSocket("**/*", (socket) => {
    blocked.push(socket.url());
    socket.close();
  });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      blocked.push(url.href);
      return route.abort();
    }
    calls.push({ path: url.pathname, method: request.method(), query: url.search });
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (url.pathname === "/fixture.css")
      return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname === "/desktop-login")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
      });
    if (url.pathname === "/api/v1/account/status")
      return json({ registrationAllowed: true, githubEnabled: false, features: {} });
    if (["/api/v1/account/login", "/api/v1/account/register"].includes(url.pathname)) {
      assert.equal(request.postDataJSON().username, "desktop-user");
      return json({
        accessToken: "A".repeat(43),
        refreshToken: "R".repeat(43),
        sessionId: rootId,
        accessTokenExpiresAt: Date.now() + 600000,
        account: user,
      });
    }
    if (url.pathname === "/api/v1/account/web/session") {
      if (request.method() === "POST") {
        assert.equal(request.headers().authorization, "Bearer " + "A".repeat(43));
        state.signedIn = true;
      }
      return json(session());
    }
    assert.equal(request.headers().authorization, undefined);
    if (url.pathname === "/api/v1/account/web/browser/request") {
      assert.equal(url.searchParams.get("request"), ticket);
      return json({ deviceName: "测试用 MacBook", expiresAt });
    }
    if (
      ["/api/v1/account/web/browser/approve", "/api/v1/account/web/browser/deny"].includes(
        url.pathname,
      )
    ) {
      assert.deepEqual(request.postDataJSON(), { request: ticket });
      assert.equal(request.headers()["x-codeshell-csrf"], "C".repeat(43));
      return json(url.pathname.endsWith("approve") ? { approved: true } : { denied: true });
    }
    blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, calls, state };
}
try {
  let fixture = await mount({ signedIn: false });
  await fixture.page.goto(`${origin}/desktop-login?request=${ticket}`);
  await fixture.page.getByRole("heading", { name: "登录 CodeShell 电脑端" }).waitFor();
  await screenshot(fixture.page, "01-browser-login");
  await fixture.page.getByLabel("用户名", { exact: true }).fill("desktop-user");
  await fixture.page.getByLabel("密码", { exact: true }).fill("test-only-password");
  await fixture.page.getByRole("button", { name: "登录", exact: true }).click();
  await fixture.page.getByRole("heading", { name: "确认登录这台电脑" }).waitFor();
  await fixture.page.getByText("测试用 MacBook", { exact: true }).waitFor();
  assert.equal(new URL(fixture.page.url()).searchParams.get("request"), ticket);
  assert.equal(fixture.calls.filter((call) => call.path.endsWith("/approve")).length, 0);
  assert.equal(
    fixture.calls.some((call) => call.path.includes("cloud")),
    false,
  );
  assert.equal(await fixture.page.evaluate(() => globalThis.localStorage.length), 0);
  assert.equal(await fixture.page.evaluate(() => globalThis.sessionStorage.length), 0);
  results.push(
    "password login preserves the desktop request and still requires explicit confirmation",
  );
  await screenshot(fixture.page, "02-confirm-desktop");
  await fixture.page.setViewportSize({ width: 390, height: 844 });
  const width = await fixture.page.evaluate(() => ({
    body: globalThis.document.body.scrollWidth,
    viewport: globalThis.innerWidth,
  }));
  assert.ok(width.body <= width.viewport, "Desktop confirmation fits a narrow browser");
  await screenshot(fixture.page, "03-confirm-mobile");
  await fixture.page.getByRole("button", { name: "登录这台电脑", exact: true }).click();
  await fixture.page.getByRole("heading", { name: "已确认，请返回 CodeShell" }).waitFor();
  await screenshot(fixture.page, "04-confirmed");
  assert.equal(fixture.calls.filter((call) => call.path.endsWith("/approve")).length, 1);
  assert.equal(
    await fixture.page.getByRole("button", { name: "登录这台电脑", exact: true }).count(),
    0,
  );
  results.push(
    "one explicit approval completes browser confirmation without claiming native persistence",
  );

  fixture = await mount({ signedIn: false });
  await fixture.page.goto(`${origin}/desktop-login?request=${ticket}`);
  await fixture.page.getByRole("button", { name: "没有账号？创建账号" }).click();
  await fixture.page.getByLabel("昵称", { exact: true }).fill("桌面测试账号");
  await fixture.page.getByLabel("用户名", { exact: true }).fill("desktop-user");
  await fixture.page.getByLabel("密码", { exact: true }).fill("test-only-password");
  await fixture.page.getByLabel("确认密码", { exact: true }).fill("test-only-password");
  await fixture.page.getByRole("button", { name: "创建账号", exact: true }).click();
  await fixture.page.getByRole("heading", { name: "确认登录这台电脑" }).waitFor();
  assert.equal(new URL(fixture.page.url()).searchParams.get("request"), ticket);
  assert.equal(fixture.calls.filter((call) => call.path.endsWith("/register")).length, 1);
  assert.equal(fixture.calls.filter((call) => call.path.endsWith("/approve")).length, 0);
  results.push("registration returns to the same computer request and never auto-approves it");

  fixture = await mount();
  await fixture.page.goto(`${origin}/desktop-login?request=${ticket}`);
  await fixture.page.getByRole("button", { name: "取消电脑登录", exact: true }).click();
  await fixture.page.getByRole("heading", { name: "已取消电脑登录" }).waitFor();
  assert.equal(fixture.state.signedIn, true);
  assert.equal(
    fixture.calls.some((call) => call.path.endsWith("/approve")),
    false,
  );
  results.push("an existing website account may deny the computer without logging out");

  fixture = await mount({ expiresAt: Date.now() - 1 });
  await fixture.page.goto(`${origin}/desktop-login?request=${ticket}`);
  await fixture.page
    .getByText("此电脑登录请求已过期，请返回 CodeShell 重新发起登录。", { exact: true })
    .waitFor();
  assert.equal(
    await fixture.page.getByRole("button", { name: "登录这台电脑", exact: true }).count(),
    0,
  );
  results.push("expired requests cannot be approved");

  fixture = await mount();
  await fixture.page.goto(
    `${origin}/desktop-login?request=${ticket}&redirect=https://untrusted.invalid`,
  );
  await fixture.page.getByRole("heading", { name: "电脑登录链接无效" }).waitFor();
  assert.equal(
    fixture.calls.some((call) => call.path.includes("/browser/")),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  results.push("untrusted navigation input is rejected without leaving the account origin");
  console.log(JSON.stringify({ results, errors, blocked, screenshots }, null, 2));
} finally {
  await context?.close();
  await browser.close();
}
