/** Production /app picker with owned Account/Cloud responses; no production identity or credentials. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-destinations-"));
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
const origin = "https://codeshell.site";
const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const rootId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const installationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const csrf = "C".repeat(43),
  ticket = "T".repeat(43);
const features = {
  "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin: origin } },
  "devices.directory": { version: 1, enabled: true },
  "relay.phone": { version: 1, enabled: true },
};
const hosts = [
  ["11111111-1111-4111-8111-111111111111", "我的 MacBook", true, false],
  ["22222222-2222-4222-8222-222222222222", "家里的电脑", false, false],
  ["33333333-3333-4333-8333-333333333333", "已撤销电脑", true, true],
].map(([hostId, name, online, revoked]) => ({
  hostId,
  name,
  online,
  revoked,
  environmentId: hostId,
  publicOrigin: `https://${hostId}.devices.codeshell.site`,
  protocolVersion: 1,
}));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const screenshots = [],
  errors = [],
  blocked = [];
let context;
async function mount(width = 1440, initial = "/app") {
  await context?.close();
  context = await browser.newContext({ viewport: { width, height: 980 }, serviceWorkers: "block" });
  const state = {
    hosts: globalThis.structuredClone(hosts),
    signedIn: true,
    failList: false,
    foreignClaim: false,
    holdClaim: false,
    releaseClaim: null,
    holdList: false,
    releaseList: null,
  };
  const calls = [];
  const account = {
    id: accountId,
    username: "fixture-user",
    displayName: "测试账号",
    role: "member",
  };
  const session = () => ({
    authenticated: state.signedIn,
    refreshRequired: false,
    cloudTarget: { enabled: true, cloudOrigin: origin, accountOrigin: origin, installationId },
    ...(state.signedIn
      ? {
          account,
          session: { id: rootId, expiresAt: Date.now() + 900000 },
          csrfToken: csrf,
          overview: {
            account,
            security: { hasPassword: true, githubLinked: false },
            capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
            stats: { activeSessions: 1, loginMethods: 1 },
            features,
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
    if (url.origin === hosts[0].publicOrigin && url.pathname === "/__relay/claim")
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Owned relay claim destination</h1>",
      });
    if (url.origin !== origin) {
      blocked.push(url.href);
      return route.abort();
    }
    const entry = {
      path: url.pathname,
      method: request.method(),
      body: request.postDataJSON(),
      headers: request.headers(),
    };
    calls.push(entry);
    assert.equal(
      entry.headers.authorization,
      undefined,
      "Website cookies never become a root bearer",
    );
    assert.ok(!url.search.includes(ticket), "Claim ticket must never enter a query");
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (["/app", "/login", "/settings/account/profile"].includes(url.pathname))
      return route.fulfill({
        contentType: "text/html",
        body: '<html><head><title>CodeShell</title></head><body><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script></body></html>',
      });
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (url.pathname === "/fixture.css")
      return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/v1/account/status")
      return json({ registrationAllowed: true, githubEnabled: false, features });
    if (url.pathname === "/api/v1/account/web/session") return json(session());
    if (url.pathname === "/api/v1/account/web/overview") return json(session().overview);
    if (url.pathname === "/api/v1/account/web/logout") {
      state.signedIn = false;
      return json({ ok: true });
    }
    if (url.pathname === "/api/v1/account/web/remote-hosts") {
      const listed = globalThis.structuredClone(state.hosts);
      if (state.holdList)
        await new Promise((done) => {
          state.releaseList = done;
        });
      return state.failList ? json({ error: "unavailable" }, 503) : json({ hosts: listed });
    }
    if (url.pathname === `/api/v1/account/web/remote-hosts/${hosts[0].hostId}/client-access`) {
      assert.equal(request.method(), "POST");
      assert.deepEqual(entry.body, { client: "browser" });
      assert.equal(entry.headers["x-codeshell-csrf"], csrf);
      if (state.holdClaim)
        await new Promise((done) => {
          state.releaseClaim = done;
        });
      return json({
        hostId: hosts[0].hostId,
        publicOrigin: hosts[0].publicOrigin,
        claimUrl: `${state.foreignClaim ? "https://foreign.example" : hosts[0].publicOrigin}/__relay/claim#${ticket}`,
        expiresAt: Date.now() + 60000,
      });
    }
    if (url.pathname === "/api/v1/cloud-browser/capabilities")
      return json({
        version: 1,
        mode: "cloud-browser",
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId,
      });
    if (url.pathname === "/api/v1/account/web/cloud-tickets")
      return json({
        ticket,
        expiresAt: Date.now() + 60000,
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId,
      });
    if (["/api/v1/cloud-browser/session", "/api/v1/cloud-browser/status"].includes(url.pathname))
      return json({
        authenticated: true,
        mode: "cloud-account",
        session: {
          id: rootId,
          kind: "cloud-management",
          audience: origin,
          installationId,
          accountOrigin: origin,
          accountId,
          managementEpoch: installationId,
          expiresAt: Date.now() + 600000,
        },
      });
    if (url.pathname === "/api/v1/cloud-browser/environment") return json({});
    if (url.pathname === "/api/v1/projects")
      return json({ runtime: "docker", available: true, projects: [] });
    blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + initial);
  return { page, calls, state };
}
async function shot(page, name) {
  assert.ok(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
  );
  const file = path.join(output, name + ".png");
  await page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}
try {
  for (const width of [1440, 390]) {
    const { page, calls, state } = await mount(width);
    await page.getByRole("heading", { name: "选择云端或电脑" }).waitFor();
    await page.getByRole("button", { name: "连接 我的 MacBook", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "连接 家里的电脑", exact: true }).isDisabled(),
      true,
    );
    assert.equal(await page.getByText("已撤销电脑", { exact: true }).count(), 0);
    assert.ok(
      !calls.some((call) => call.path === "/api/v1/account/web/cloud-tickets"),
      "Landing must not silently select Cloud",
    );
    await shot(page, `destinations-${width}`);
    await page.getByRole("button", { name: "进入云端" }).click();
    await page.getByRole("heading", { name: "为第一个想法，建一个工作区" }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("target"), "cloud");
    await page.getByLabel("打开账号菜单").click();
    await page.getByRole("button", { name: "切换云端或电脑" }).click();
    await page.getByRole("heading", { name: "选择云端或电脑" }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("target"), "choose");
    state.hosts = [];
    await page.getByRole("button", { name: "刷新电脑列表" }).click();
    await page.getByRole("heading", { name: "还没有登录的电脑" }).waitFor();
    await shot(page, `destinations-empty-${width}`);
    state.hosts = globalThis.structuredClone(hosts);
    await page.getByRole("button", { name: "刷新电脑列表" }).click();
    await page.getByRole("button", { name: "连接 我的 MacBook", exact: true }).waitFor();
    state.foreignClaim = true;
    await page.getByRole("button", { name: "连接 我的 MacBook", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "无法打开这台电脑" }).waitFor();
    assert.equal(new URL(page.url()).origin, origin);
    state.foreignClaim = false;
    await page.getByRole("button", { name: "连接 我的 MacBook", exact: true }).click();
    await page.getByRole("heading", { name: "Owned relay claim destination" }).waitFor();
    assert.equal(page.url(), `${hosts[0].publicOrigin}/__relay/claim#${ticket}`);
    assert.equal(
      await page.evaluate(() => globalThis.localStorage.length + globalThis.sessionStorage.length),
      0,
    );
  }
  const deep = await mount(1440, "/app?target=cloud");
  await deep.page.getByRole("heading", { name: "为第一个想法，建一个工作区" }).waitFor();
  assert.ok(!deep.calls.some((call) => call.path === "/api/v1/account/web/remote-hosts"));
  const stale = await mount();
  await stale.page.getByRole("button", { name: "连接 我的 MacBook", exact: true }).waitFor();
  stale.state.holdClaim = true;
  await stale.page.getByRole("button", { name: "连接 我的 MacBook", exact: true }).click();
  await stale.page.getByLabel("打开账号菜单").click();
  await stale.page.getByRole("button", { name: "退出登录", exact: true }).click();
  await stale.page.getByRole("heading", { name: "继续你的工作", exact: true }).waitFor();
  stale.state.releaseClaim?.();
  await stale.page.waitForTimeout(100);
  assert.equal(
    new URL(stale.page.url()).origin,
    origin,
    "A late claim must not navigate after logout",
  );
  const lateList = await mount();
  await lateList.page.getByRole("button", { name: "连接 我的 MacBook", exact: true }).waitFor();
  lateList.state.holdList = true;
  await lateList.page.getByRole("button", { name: "刷新电脑列表" }).click();
  await lateList.page.getByLabel("打开账号菜单").click();
  await lateList.page.getByRole("button", { name: "退出登录", exact: true }).click();
  await lateList.page.getByRole("heading", { name: "继续你的工作", exact: true }).waitFor();
  lateList.state.releaseList?.();
  await lateList.page.waitForTimeout(100);
  assert.equal(
    await lateList.page.getByText("我的 MacBook", { exact: true }).count(),
    0,
    "A late directory reply must not restore the signed-out account's computers",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        verified: [
          "explicit Cloud selection",
          "ready/offline computers and revoked entries hidden",
          "same-cookie CSRF claim",
          "foreign claim rejected",
          "logout fences late claim",
          "logout fences late directory",
          "Cloud deep link",
          "back to chooser",
          "empty desktop onboarding",
        ],
        screenshots,
      },
      null,
      2,
    ),
  );
} finally {
  await context?.close();
  await browser.close();
}
