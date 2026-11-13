/** Production account settings and Desktop authorization UI with a real virtual
 * authenticator. Account/GitHub responses are owned fixtures, never live accounts. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { passkeyBrowserFixture } from "./fixtures/passkey-browser.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated smoke runner");
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-passkeys-"));
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WebsiteEntry} from './WebsiteShell.js';import './app.css';createRoot(document.getElementById('root')).render(<WebsiteEntry setupToken=""/>);`,
    resolveDir: path.join(repo, "packages/web/app"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "";
const origin = "https://codeshell.site",
  accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  rootId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hostId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  requestId = "Q".repeat(43),
  bootstrap = "B".repeat(43),
  csrf = "C".repeat(43);
const features = {
  "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin: origin } },
};
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
  screenshots = [];
let context;
async function mount({
  github = false,
  initial = "/settings/account/security",
  width = 1280,
} = {}) {
  await context?.close();
  context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  const passkeys = passkeyBrowserFixture(origin, accountId);
  const calls = [],
    state = {
      passkeys: [],
      signedIn: true,
      bootstrapVerified: false,
      githubStarted: false,
      githubMode: "",
      linked: github,
    };
  const account = {
    id: accountId,
    username: "fixture-user",
    displayName: "测试账号",
    role: "member",
  };
  const overview = () => ({
    account,
    security: { hasPassword: !github, githubLinked: state.linked },
    capabilities: { sessions: true, passwordChange: !github, admin: false, links: false },
    stats: { activeSessions: 1, loginMethods: 1 },
    features,
  });
  await context.routeWebSocket("**/*", (socket) => {
    blocked.push(socket.url());
    socket.close();
  });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postDataJSON();
    const json = (value, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (
      url.origin === "https://github.com" &&
      url.pathname === "/login/oauth/authorize" &&
      state.githubStarted
    )
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Owned GitHub identity verification</h1>",
      });
    if (url.origin !== origin) {
      blocked.push(url.href);
      return route.abort();
    }
    calls.push({ path: url.pathname, method: request.method(), body });
    assert.equal(request.headers().authorization, undefined);
    if (
      url.pathname.startsWith("/api/v1/account/web/") &&
      url.pathname !== "/api/v1/account/web/session"
    )
      assert.equal(request.headers()["x-codeshell-csrf"], csrf);
    if (
      [
        "/settings/account/security",
        "/settings/account/connections",
        "/remote-access",
        "/login",
      ].includes(url.pathname)
    )
      return route.fulfill({
        contentType: "text/html",
        body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
      });
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (url.pathname === "/fixture.css")
      return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/v1/account/status")
      return json({ registrationAllowed: true, githubEnabled: true, features });
    if (url.pathname === "/api/v1/cloud-browser/capabilities")
      return json({
        version: 1,
        mode: "cloud-browser",
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId: hostId,
      });
    if (url.pathname === "/api/v1/account/web/session")
      return json({
        authenticated: state.signedIn,
        refreshRequired: false,
        cloudTarget: {
          enabled: true,
          cloudOrigin: origin,
          accountOrigin: origin,
          installationId: hostId,
        },
        ...(state.signedIn
          ? {
              account,
              session: { id: rootId, expiresAt: Date.now() + 900000 },
              csrfToken: csrf,
              overview: overview(),
            }
          : {}),
      });
    if (url.pathname === "/api/v1/account/web/overview") return json(overview());
    if (url.pathname === "/api/v1/account/web/logout") {
      state.signedIn = false;
      return json({ ok: true });
    }
    if (url.pathname === "/api/v1/account/web/passkeys")
      return json({ passkeys: state.passkeys, bootstrap: { password: !github, github } });
    if (url.pathname === "/api/v1/account/web/passkeys/bootstrap/password") {
      if (body.currentPassword !== "fixture-account-password")
        return json({ error: "incorrect_password" }, 400);
      state.bootstrapVerified = true;
      return json({ bootstrapProof: bootstrap, expiresAt: Date.now() + 60000 });
    }
    if (url.pathname === "/api/v1/account/web/github/start") {
      if (body.mode === "link") passkeys.consume(body.stepUpToken, "github-link", accountId);
      else {
        assert.equal(github, true);
        assert.equal(body.mode, "passkey-bootstrap");
      }
      state.githubStarted = true;
      state.githubMode = body.mode;
      return json({
        receipt: "G".repeat(43),
        expiresAt: Date.now() + 60000,
        pollIntervalMs: 1000,
        authorizationUrl: `https://github.com/login/oauth/authorize?scope=read:user&code_challenge_method=S256&code_challenge=${body.codeChallenge}`,
      });
    }
    if (url.pathname === "/api/v1/account/web/github/poll") {
      assert.equal(state.githubStarted, true);
      assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
      if (state.githubMode === "link") {
        state.linked = true;
        return json({ linked: true, account });
      }
      state.bootstrapVerified = true;
      return json({ bootstrapProof: bootstrap, expiresAt: Date.now() + 60000 });
    }
    if (url.pathname === "/api/v1/account/web/github/cancel") return json({ cancelled: true });
    if (url.pathname === "/api/v1/account/web/passkeys/authentication/options")
      return json(passkeys.options(body));
    if (url.pathname === "/api/v1/account/web/passkeys/authentication/verify")
      return json(passkeys.verify(body));
    if (url.pathname === "/api/v1/account/web/passkeys/registration/options") {
      if (state.passkeys.length) passkeys.consume(body.stepUpToken, "passkey-add", accountId);
      else {
        assert.equal(state.bootstrapVerified, true);
        assert.equal(body.bootstrapProof, bootstrap);
        state.bootstrapVerified = false;
      }
      return json(passkeys.registrationOptions(body.name));
    }
    if (url.pathname === "/api/v1/account/web/passkeys/registration/verify") {
      const result = await passkeys.register(body);
      state.passkeys.push(result.passkey);
      return json(result);
    }
    if (url.pathname.startsWith("/api/v1/account/web/passkeys/") && request.method() === "DELETE") {
      const id = url.pathname.split("/").at(-1);
      passkeys.consume(body.stepUpToken, "passkey-delete", id);
      assert.ok(state.passkeys.length > 1);
      state.passkeys = state.passkeys.filter((key) => key.id !== id);
      return json({ ok: true });
    }
    if (url.pathname === "/api/v1/account/web/remote-access/request") {
      assert.equal(url.searchParams.get("request"), requestId);
      return json({
        deviceName: "随身 MacBook",
        target: { hostId, environmentId: hostId, name: "家里的工作电脑" },
        expiresAt: Date.now() + 600000,
      });
    }
    if (url.pathname === "/api/v1/account/web/remote-access/approve") {
      passkeys.consume(body.stepUpToken, "desktop-remote-access", requestId);
      assert.equal(body.request, requestId);
      return json({ approved: true });
    }
    if (url.pathname === "/api/v1/account/web/remote-access/deny") {
      assert.deepEqual(body, { request: requestId });
      return json({ denied: true });
    }
    blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  const authenticator = await passkeys.install(page);
  page.setDefaultTimeout(10000);
  await page.goto(origin + initial);
  return { page, calls, state, authenticator };
}
async function screenshot(page, name) {
  assert.ok(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
  );
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}
try {
  let f = await mount();
  const settings = f.page.getByRole("region", { name: "Passkey", exact: true });
  await settings
    .getByText("尚未添加 Passkey。首次添加需要重新验证账号身份。", { exact: true })
    .waitFor();
  assert.equal(
    f.calls.some((call) => call.path.endsWith("/registration/options")),
    false,
  );
  await settings.getByLabel("验证账号密码", { exact: true }).fill("wrong-password-value");
  await settings.getByRole("button", { name: "添加 Passkey", exact: true }).click();
  await settings.getByRole("alert").filter({ hasText: "当前密码不正确" }).waitFor();
  assert.equal(await settings.getByLabel("验证账号密码", { exact: true }).inputValue(), "");
  assert.equal(
    f.calls.some((call) => call.path.endsWith("/registration/options")),
    false,
  );
  await settings.getByLabel("验证账号密码", { exact: true }).fill("fixture-account-password");
  await settings.getByRole("button", { name: "添加 Passkey", exact: true }).click();
  await settings.getByRole("button", { name: "移除", exact: true }).waitFor();
  assert.equal(
    await settings.getByRole("button", { name: "移除", exact: true }).isDisabled(),
    true,
  );
  await screenshot(f.page, "passkey-settings-desktop");
  await settings.getByLabel("Passkey 名称", { exact: true }).fill("备用 Passkey");
  await settings.getByRole("button", { name: "添加 Passkey", exact: true }).click();
  await settings.getByText("备用 Passkey", { exact: true }).waitFor();
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/bootstrap/password")).length,
    2,
    "Existing keys cannot use password bootstrap",
  );
  await settings.getByRole("button", { name: "移除", exact: true }).first().click();
  await settings.getByText("Passkey 已移除。", { exact: true }).waitFor();
  assert.equal(await settings.getByRole("button", { name: "移除", exact: true }).count(), 1);
  await f.page.setViewportSize({ width: 390, height: 900 });
  await screenshot(f.page, "passkey-settings-mobile");
  await f.authenticator.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: f.authenticator.authenticatorId,
    enabled: false,
  });
  const verifyCount = f.calls.filter((call) => call.path.endsWith("/authentication/verify")).length;
  await settings.getByRole("button", { name: "添加 Passkey", exact: true }).click();
  await settings.getByRole("button", { name: "取消", exact: true }).click();
  await settings.getByText("已取消，可重新发起。", { exact: true }).waitFor();
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/authentication/verify")).length,
    verifyCount,
  );
  await f.authenticator.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: f.authenticator.authenticatorId,
    enabled: true,
  });
  await f.page.goto(origin + "/settings/account/connections");
  await f.page.getByRole("button", { name: "关联 GitHub 登录身份", exact: true }).click();
  await f.page.getByText("已关联", { exact: true }).waitFor();

  f = await mount({ github: true });
  await f.page.getByRole("button", { name: "通过 GitHub 验证并添加", exact: true }).click();
  await f.page.getByRole("button", { name: "创建 Passkey", exact: true }).waitFor();
  await f.page.bringToFront();
  await f.page.getByRole("button", { name: "创建 Passkey", exact: true }).click();
  await f.page.getByRole("button", { name: "移除", exact: true }).waitFor();
  assert.equal(
    f.calls.some(
      (call) =>
        call.path.includes("/login") ||
        (call.path === "/api/v1/account/web/session" && call.method === "POST"),
    ),
    false,
  );

  f = await mount({ initial: `/remote-access?request=${requestId}`, width: 390 });
  await f.page.getByText("家里的工作电脑", { exact: true }).waitFor();
  assert.equal(
    f.calls.some((call) => call.method === "POST"),
    false,
  );
  await screenshot(f.page, "desktop-remote-access-mobile");
  await f.page.getByRole("button", { name: "用 Passkey 确认连接", exact: true }).click();
  await f.page.getByRole("heading", { name: "已确认远程访问", exact: true }).waitFor();
  assert.equal(f.page.url(), `${origin}/remote-access?request=${requestId}`);
  assert.equal(
    await f.page.evaluate(() => globalThis.localStorage.length + globalThis.sessionStorage.length),
    0,
  );
  f = await mount({ initial: `/remote-access?request=${requestId}` });
  await f.page.getByRole("button", { name: "取消连接", exact: true }).click();
  await f.page.getByRole("heading", { name: "已取消远程访问", exact: true }).waitFor();
  assert.equal(
    f.calls.some((call) => call.path.includes("/passkeys/")),
    false,
  );
  f = await mount({
    initial: `/remote-access?request=${requestId}&redirect=https://outside.invalid`,
  });
  await f.page.getByRole("heading", { name: "远程访问链接无效", exact: true }).waitFor();
  assert.equal(
    f.calls.some((call) => call.path.includes("/remote-access/")),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "password bootstrap required",
          "real registration",
          "existing-key UV add/delete",
          "last-key protection",
          "cancel ceremony",
          "independent GitHub bootstrap",
          "GitHub association requires existing Passkey UV",
          "native remote target + UV",
          "deny without UV",
          "invalid route refused",
        ],
        screenshots,
      },
      null,
      2,
    ),
  );
} catch (cause) {
  console.error(
    "Visible fixture errors:",
    await context?.pages()[0]?.getByRole("alert").allTextContents(),
  );
  throw cause;
} finally {
  await context?.close();
  await browser.close();
}
