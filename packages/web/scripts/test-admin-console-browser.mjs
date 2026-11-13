/** Real admin UI against owned Account responses. Never contacts a live service.
 * Run through scripts/run-isolated-node-smoke.mjs.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-admin-console-"));
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import {WebsiteEntry} from './WebsiteShell.js';import './app.css';
      createRoot(document.getElementById('root')).render(<WebsiteEntry setupToken=""/>);`,
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
const prefix = "/api/v1/account/web";
const administratorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const installationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const errors = [],
  blocked = [],
  screenshots = [];
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
let context;

async function mount({ width = 1440, theme = "light", role = "admin" } = {}) {
  await context?.close();
  context = await browser.newContext({
    viewport: { width, height: width < 760 ? 844 : 960 },
    colorScheme: theme,
    serviceWorkers: "block",
  });
  const calls = [];
  const account = { id: administratorId, username: "site-admin", displayName: "站点管理员", role };
  const features = {
    "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin: origin } },
  };
  const state = {
    confirm: false,
    dialogs: [],
    usersError: false,
    holdUsers: null,
    users: Array.from({ length: 31 }, (_, index) => ({
      id: id(index + 1),
      username: `member-${String(index + 1).padStart(2, "0")}`,
      displayName: index === 0 ? "测试 用户" : `成员 ${index + 1}`,
      role: "member",
      disabled: index === 1,
      createdAt: 1770000000000 + index * 1000,
      sessionCount: index === 1 ? 0 : 2,
    })),
    events: [],
  };
  state.users.push({ ...account, disabled: false, createdAt: 1760000000000, sessionCount: 1 });
  const overview = () => ({
    account,
    security: { hasPassword: true, githubLinked: false },
    capabilities: { sessions: true, passwordChange: true, admin: role === "admin", links: false },
    stats: { activeSessions: 1, loginMethods: 1 },
    features,
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
      query: url.search,
      method: request.method(),
      body: request.postData(),
    });
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (pathname === "/" || /^\/(?:admin|settings|login)(?:\/|$)/.test(pathname))
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script></html>',
      });
    if (pathname === "/api/v1/cloud-browser/capabilities")
      return json({ error: "owned_cloud_unavailable" }, 503);
    if (pathname === "/api/v1/account/status")
      return json({ registrationAllowed: true, githubEnabled: false, features });
    assert.equal(request.headers().authorization, undefined);
    if (pathname === `${prefix}/session`)
      return json({
        authenticated: true,
        refreshRequired: false,
        csrfToken: "C".repeat(43),
        account,
        session: { id: sessionId, expiresAt: Date.now() + 900000 },
        cloudTarget: { enabled: true, cloudOrigin: origin, accountOrigin: origin, installationId },
        overview: overview(),
      });
    if (pathname === `${prefix}/overview`) return json(overview());
    if (pathname.startsWith(`${prefix}/admin/`)) {
      assert.equal(role, "admin", "A member page must not request any admin endpoint");
      if (request.method() !== "GET")
        assert.equal(request.headers()["x-codeshell-csrf"], "C".repeat(43));
      if (pathname === `${prefix}/admin/summary`)
        return json({
          users: {
            total: state.users.length,
            active: state.users.filter((user) => !user.disabled).length,
            disabled: state.users.filter((user) => user.disabled).length,
            administrators: 1,
          },
          sessions: { active: state.users.reduce((sum, user) => sum + user.sessionCount, 0) },
          auditEvents: state.events.length,
        });
      if (pathname === `${prefix}/admin/users`) {
        if (state.holdUsers) await state.holdUsers;
        if (state.usersError) return json({ error: "fixture_unavailable" }, 503);
        const q = (url.searchParams.get("q") || "").toLowerCase();
        const status = url.searchParams.get("status"),
          selectedRole = url.searchParams.get("role");
        const matching = state.users.filter(
          (user) =>
            (!q ||
              [user.username, user.displayName, user.id].some((value) =>
                value.toLowerCase().includes(q),
              )) &&
            (!status || user.disabled === (status === "disabled")) &&
            (!selectedRole || user.role === selectedRole) &&
            user.id > (url.searchParams.get("cursor") || ""),
        );
        const limit = Number(url.searchParams.get("limit"));
        assert.equal(limit, 30);
        const users = matching.slice(0, limit);
        return json({ users, nextCursor: matching.length > limit ? users.at(-1).id : null });
      }
      if (pathname === `${prefix}/admin/audit`)
        return json({ events: state.events, nextCursor: null });
      const match = /\/admin\/users\/([a-f0-9-]+)(\/revoke-sessions)?$/.exec(pathname);
      if (match) {
        const user = state.users.find((candidate) => candidate.id === match[1]);
        assert.ok(user, "Mutation target must belong to the fixture");
        const body = request.postDataJSON();
        if (match[2]) {
          assert.equal(request.method(), "POST");
          assert.deepEqual(body, {});
          const revoked = user.sessionCount;
          user.sessionCount = 0;
          state.events.unshift({
            id: id(100 + state.events.length),
            actorId: account.id,
            targetId: user.id,
            action: "admin.sessions.revoked",
            createdAt: Date.now(),
          });
          return json({ ok: true, revoked });
        }
        assert.equal(request.method(), "PATCH");
        assert.deepEqual(Object.keys(body), ["disabled"]);
        assert.equal(typeof body.disabled, "boolean");
        assert.equal(user.role, "member");
        user.disabled = body.disabled;
        if (body.disabled) user.sessionCount = 0;
        state.events.unshift({
          id: id(100 + state.events.length),
          actorId: account.id,
          targetId: user.id,
          action: body.disabled ? "admin.account.disabled" : "admin.account.enabled",
          createdAt: Date.now(),
        });
        return json({ user });
      }
    }
    blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    state.dialogs.push(dialog.message());
    if (state.confirm) await dialog.accept();
    else await dialog.dismiss();
  });
  return { page, calls, state };
}

async function shot(page, name) {
  assert.ok(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    "Page must fit viewport",
  );
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}
const adminRequests = (calls) => calls.filter((call) => call.path.startsWith(`${prefix}/admin/`));
const userQueries = (calls) => calls.filter((call) => call.path === `${prefix}/admin/users`);
const mutations = (calls) => adminRequests(calls).filter((call) => call.method !== "GET");

try {
  for (const [width, theme] of [
    [1440, "light"],
    [390, "dark"],
  ]) {
    const { page, calls, state } = await mount({ width, theme });
    await page.goto(`${origin}/admin`);
    await page.getByText("账号总数", { exact: true }).waitFor();
    await shot(page, `${width}-${theme}-overview`);
    await page
      .getByRole("navigation", { name: "管理后台", exact: true })
      .getByRole("button", { name: "账号管理", exact: true })
      .click();
    await page.getByRole("row").filter({ hasText: "member-01" }).waitFor();
    await shot(page, `${width}-${theme}-accounts`);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByRole("row").filter({ hasText: "member-31" }).waitFor();
    assert.equal(new URLSearchParams(userQueries(calls).at(-1).query).get("cursor"), id(30));
    const adminRow = page.getByRole("row").filter({ hasText: "site-admin" });
    assert.equal(await adminRow.getByRole("button", { name: "停用", exact: true }).count(), 0);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await page.getByRole("row").filter({ hasText: "member-01" }).waitFor();
    assert.equal(new URLSearchParams(userQueries(calls).at(-1).query).has("cursor"), false);

    await page.getByLabel("搜索账号", { exact: true }).fill("测试 用户");
    await page.getByLabel("账号状态").selectOption("active");
    await page.getByLabel("账号角色").selectOption("member");
    await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).searchParams.get("q") === "测试 用户",
      ),
      page.getByRole("button", { name: "搜索", exact: true }).click(),
    ]);
    const query = new URLSearchParams(userQueries(calls).at(-1).query);
    assert.equal(query.get("q"), "测试 用户");
    assert.equal(query.get("status"), "active");
    assert.equal(query.get("role"), "member");
    const target = page.getByRole("row").filter({ hasText: "member-01" });
    await target.waitFor();
    assert.equal(await page.getByRole("row").filter({ hasText: "member-03" }).count(), 0);
    await target.getByRole("button", { name: "停用", exact: true }).click();
    assert.equal(mutations(calls).length, 0, "Cancelling a mutation must not send a request");
    state.confirm = true;
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PATCH"),
      target.getByRole("button", { name: "停用", exact: true }).click(),
    ]);
    await page.getByLabel("账号状态").selectOption("disabled");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await target.getByRole("button", { name: "恢复", exact: true }).waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PATCH"),
      target.getByRole("button", { name: "恢复", exact: true }).click(),
    ]);
    assert.equal(state.users[0].disabled, false);

    await page.getByLabel("搜索账号", { exact: true }).fill("member-03");
    await page.getByLabel("账号状态").selectOption("active");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const third = page.getByRole("row").filter({ hasText: "member-03" });
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/revoke-sessions")),
      third.getByRole("button", { name: "退出会话", exact: true }).click(),
    ]);
    assert.equal(state.users[2].sessionCount, 0);
    assert.equal(mutations(calls).length, 3);

    await page.getByLabel("搜索账号", { exact: true }).fill("no-matching-account");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByText(/没有.*账号|暂无.*账号/).waitFor();
    await shot(page, `${width}-${theme}-empty`);
    await page
      .getByRole("navigation", { name: "管理后台", exact: true })
      .getByRole("button", { name: "操作记录", exact: true })
      .click();
    await page.getByText("停用账号", { exact: true }).waitFor();
    await page.getByText("恢复账号", { exact: true }).waitFor();
    await shot(page, `${width}-${theme}-audit`);
    assert.equal(
      calls.some(
        (call) =>
          call.path.endsWith("/cloud-tickets") ||
          call.path.startsWith("/api/v1/cloud-browser/") ||
          call.path === "/api/v1/projects",
      ),
      false,
      "Admin pages must not connect to cloud runtimes",
    );
  }

  const recovering = await mount();
  let releaseUsers;
  recovering.state.holdUsers = new Promise((resolve) => {
    releaseUsers = resolve;
  });
  recovering.state.usersError = true;
  await recovering.page.goto(`${origin}/admin/users`);
  await recovering.page.getByText("正在读取账号…", { exact: true }).waitFor();
  assert.equal(
    await recovering.page.getByRole("row").count(),
    0,
    "Pending data cannot expose stale account actions",
  );
  releaseUsers();
  await recovering.page.getByRole("alert").waitFor();
  await recovering.page.getByRole("button", { name: "重试读取", exact: true }).waitFor();
  recovering.state.usersError = false;
  recovering.state.holdUsers = null;
  await recovering.page.getByRole("button", { name: "重试读取", exact: true }).click();
  await recovering.page.getByRole("row").filter({ hasText: "member-01" }).waitFor();
  await recovering.page.getByLabel("打开账号菜单", { exact: true }).click();
  await recovering.page.getByRole("button", { name: "管理后台", exact: true }).click();
  await recovering.page.getByText("账号总数", { exact: true }).waitFor();

  const member = await mount({ role: "member" });
  await member.page.goto(`${origin}/admin/users`);
  await member.page.getByText(/没有管理员权限/).waitFor();
  assert.equal(adminRequests(member.calls).length, 0);
  await member.page.getByLabel("打开账号菜单", { exact: true }).click();
  assert.equal(await member.page.getByRole("button", { name: "管理后台", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify(
      {
        results: [
          "admin overview, paginated accounts, Unicode search and status/role filters",
          "cancel, disable, restore and session revocation with CSRF",
          "loading and failure recovery, plus account menu entry",
          "audit records, member denial and no cloud runtime requests",
          "desktop light and mobile dark fit the viewport",
        ],
        screenshots,
        errors,
        blocked,
      },
      null,
      2,
    ),
  );
} finally {
  await context?.close();
  await browser.close();
}
