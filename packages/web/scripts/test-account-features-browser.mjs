/** Production website UI with owned Account responses in an isolated browser.
 * No Host, provider, native account, persistent credentials or real service is used.
 * Run: node scripts/run-isolated-node-smoke.mjs packages/web/scripts/test-account-features-browser.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WebsiteEntry} from './WebsiteShell.js';createRoot(document.getElementById('root')).render(<WebsiteEntry setupToken=""/>);`,
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
const origin = "https://account-feature.fixture.invalid";
const account = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  username: "fixture-user",
  displayName: "测试账号",
  role: "member",
};
const installationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const available = {
  "links.remote": { version: 1, enabled: true },
  "relay.phone": { version: 1, enabled: true },
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
  results = [];
let context;
async function mount({
  signedIn = true,
  registrationAllowed = true,
  features = {},
  statusFeatures = available,
} = {}) {
  await context?.close();
  context = await browser.newContext({ serviceWorkers: "block" });
  const calls = [];
  const state = { signedIn, registrationAllowed, features, statusFeatures, offline: false };
  const session = () => ({
    authenticated: state.signedIn,
    refreshRequired: false,
    cloudTarget: { enabled: true, cloudOrigin: origin, accountOrigin: origin, installationId },
    ...(state.signedIn
      ? {
          account,
          session: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: Date.now() + 900000 },
          csrfToken: "C".repeat(43),
          overview: {
            account,
            security: { hasPassword: true, githubLinked: false },
            capabilities: { sessions: true, passwordChange: true, admin: false, links: true },
            stats: { activeSessions: 1, loginMethods: 1 },
            features: state.features,
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
    const pathname = url.pathname;
    calls.push({
      path: pathname,
      method: request.method(),
      query: url.search,
      authorization: request.headers().authorization,
    });
    assert.equal(request.headers().authorization, undefined, "Never expose native bearer grants");
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (pathname === "/devices")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<h1>独立设备目录</h1>",
      });
    if (pathname === "/" || pathname === "/register")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
      });
    if (pathname === "/api/v1/cloud-browser/capabilities")
      return json({
        version: 1,
        mode: "cloud-browser",
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId,
      });
    if (pathname === "/api/v1/account/status") {
      if (state.offline) return route.abort();
      return json({
        registrationAllowed: state.registrationAllowed,
        githubEnabled: false,
        features: state.statusFeatures,
      });
    }
    if (pathname === "/api/v1/account/web/session") {
      if (state.offline) return route.abort();
      return json(session());
    }
    if (pathname === "/api/v1/account/web/overview") return json(session().overview);
    if (pathname === "/api/v1/account/web/cloud-tickets")
      return json({ error: "owned_cloud_unavailable" }, 503);
    if (pathname === "/api/v1/account/web/links") return json({ links: [] });
    blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, state, calls };
}
try {
  let fixture = await mount({ signedIn: false });
  await fixture.page.goto(origin + "/register?next=https://untrusted.invalid#token=ignored");
  await fixture.page.getByRole("heading", { name: "创建你的账号" }).waitFor();
  await fixture.page.getByLabel("昵称", { exact: true }).waitFor();
  assert.equal(
    fixture.calls.some((call) => call.path === "/api/v1/cloud-browser/capabilities"),
    false,
  );
  assert.equal(new URL(fixture.page.url()).origin, origin);
  results.push("fixed registration route bypasses Cloud detection and ignores return destinations");

  fixture = await mount({ signedIn: false, registrationAllowed: false });
  await fixture.page.goto(origin + "/register");
  await fixture.page
    .getByText("当前服务未开放注册，可使用已有账号登录。", { exact: true })
    .waitFor();
  assert.equal(await fixture.page.getByLabel("昵称", { exact: true }).count(), 0);
  await fixture.page.getByRole("button", { name: "登录", exact: true }).waitFor();
  results.push("closed registration leaves an explicit explanation and existing-account login");

  fixture = await mount({ features: {} });
  await fixture.page.goto(origin);
  await fixture.page.getByRole("heading", { name: "你的账号", exact: true }).waitFor();
  assert.equal(
    await fixture.page.getByRole("button", { name: "我的电脑", exact: true }).count(),
    0,
  );
  assert.equal(
    fixture.calls.some((call) => call.path.endsWith("/cloud-tickets")),
    false,
  );
  await fixture.page.getByRole("button", { name: "账号设置", exact: true }).last().click();
  await fixture.page.getByRole("button", { name: "连接", exact: true }).click();
  assert.equal(
    fixture.calls.some((call) => call.path.endsWith("/links")),
    false,
  );
  results.push("explicit empty account features hide cloud, phone and remote Link requests");

  fixture = await mount({ features: { "relay.phone": available["relay.phone"] } });
  await fixture.page.goto(origin);
  await fixture.page.getByRole("button", { name: "我的电脑", exact: true }).last().click();
  await fixture.page.getByRole("heading", { name: "独立设备目录" }).waitFor();
  assert.equal(fixture.page.url(), origin + "/devices");
  assert.equal(fixture.calls.find((call) => call.path === "/devices")?.query, "");
  results.push("ready phone entry opens only the fixed credential-free device portal");

  fixture = await mount({ features: available });
  await fixture.page.goto(origin);
  await fixture.page.getByRole("button", { name: "重新连接", exact: true }).waitFor();
  assert.equal(fixture.calls.filter((call) => call.path.endsWith("/cloud-tickets")).length, 1);
  fixture.state.offline = true;
  await fixture.page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event("focus")));
  await fixture.page.getByRole("button", { name: "重试连接账号服务" }).waitFor();
  assert.equal(
    await fixture.page
      .getByRole("button", { name: /我的电脑/ })
      .last()
      .isDisabled(),
    true,
  );
  assert.equal(fixture.calls.filter((call) => call.path.endsWith("/cloud-tickets")).length, 1);
  results.push("known features become pending on service loss and do not start cloud requests");
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ passed: results, errors, blocked }, null, 2));
} finally {
  await context?.close();
  await browser.close();
}
