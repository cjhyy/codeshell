/** Real website / project / workbench UI, with owned Account, runtime and model responses.
 * No production accounts, providers or credentials. Use run-isolated-node-smoke.mjs.
 */
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
const output = await mkdtemp(path.join(tmpdir(), "codeshell-website-onboarding-"));
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WebsiteEntry} from './WebsiteShell.js';
      window.fixtureRuns=[];
      class OwnedSocket {
        static OPEN=1;readyState=0;
        constructor(url){if(new URL(url).hostname!=='codeshell.site')throw Error('Unexpected socket origin');this.timer=setTimeout(()=>{if(this.readyState===3)return;this.readyState=1;this.onopen?.()},0)}
        close(){clearTimeout(this.timer);this.readyState=3}
        send(raw){const m=JSON.parse(raw);let result;
          if(m.method==='agent/query')result={type:'sessions',data:[]};
          else if(m.method==='serve/approval.snapshot')result={approvals:[],leases:[]};
          else if(m.method==='agent/run'){window.fixtureRuns.push(m.params);result={sessionId:m.params.sessionId};}
          else throw Error('Unexpected RPC '+m.method);
          queueMicrotask(()=>{this.onmessage?.({data:JSON.stringify({jsonrpc:'2.0',id:m.id,result})});
            if(m.method==='agent/run')for(const event of [{type:'text_delta',text:'这是隔离测试的回复。'},{type:'turn_complete',reason:'completed'}])this.onmessage?.({data:JSON.stringify({jsonrpc:'2.0',method:'agent/streamEvent',params:{sessionId:m.params.sessionId,event}})});
          });
        }
      }
      window.WebSocket=OwnedSocket;createRoot(document.getElementById('root')).render(<WebsiteEntry setupToken=""/>);`,
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
const installationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const account = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  username: "fixture-user",
  displayName: "测试账号",
  role: "member",
};
const features = {
  "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin: origin } },
};
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
async function mount(width, theme) {
  await context?.close();
  context = await browser.newContext({
    viewport: { width, height: width < 760 ? 844 : 960 },
    colorScheme: theme,
    serviceWorkers: "block",
  });
  const calls = [];
  const state = {
    accountOffline: false,
    confirmLeave: false,
    dialogs: [],
    signedIn: false,
    failStart: true,
    projects: [],
    configuration: {
      workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
      defaults: {},
      connections: [],
      catalog: [
        {
          id: "owned",
          displayName: "测试模型服务",
          adapterKind: "openai",
          defaultBaseUrl: "https://owned.invalid/v1",
          needsKey: true,
        },
      ],
      skills: [],
      mcpServers: [],
      restartRequired: false,
    },
  };
  const session = () => ({
    authenticated: state.signedIn,
    refreshRequired: false,
    cloudTarget: { enabled: true, cloudOrigin: origin, accountOrigin: origin, installationId },
    ...(state.signedIn
      ? {
          account,
          csrfToken: "C".repeat(43),
          session: { id: sessionId, expiresAt: Date.now() + 900000 },
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
    if (url.origin !== origin) {
      blocked.push(url.href);
      return route.abort();
    }
    const pathname = url.pathname;
    calls.push({ path: pathname, method: request.method() });
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (["/", "/login", "/signup", "/app"].includes(pathname))
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script></html>',
      });
    if (pathname === "/api/v1/cloud-browser/capabilities")
      return json({
        version: 1,
        mode: "cloud-browser",
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId,
      });
    if (pathname === "/api/v1/account/status")
      return json({ registrationAllowed: true, githubEnabled: false, features });
    if (pathname === "/api/v1/account/register")
      return json({
        account,
        sessionId,
        accessToken: "A".repeat(43),
        refreshToken: "R".repeat(43),
        accessTokenExpiresAt: Date.now() + 600000,
      });
    if (pathname === "/api/v1/account/web/session") {
      if (state.accountOffline) return json({ error: "owned account unavailable" }, 503);
      if (request.method() === "POST") {
        assert.equal(request.headers().authorization, "Bearer " + "A".repeat(43));
        state.signedIn = true;
      }
      return json(session());
    }
    assert.equal(request.headers().authorization, undefined);
    if (pathname === "/api/v1/account/web/logout") {
      state.signedIn = false;
      return json({ ok: true });
    }
    if (pathname === "/api/v1/cloud-browser/logout") return json({ ok: true });
    if (pathname === "/api/v1/account/web/overview") return json(session().overview);
    if (pathname === "/api/v1/account/web/cloud-tickets")
      return json({
        ticket: "T".repeat(43),
        expiresAt: Date.now() + 60000,
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId,
      });
    if (["/api/v1/cloud-browser/session", "/api/v1/cloud-browser/status"].includes(pathname))
      return json({
        authenticated: true,
        mode: "cloud-account",
        session: {
          id: sessionId,
          kind: "cloud-management",
          audience: origin,
          installationId,
          accountOrigin: origin,
          accountId: account.id,
          managementEpoch: installationId,
          expiresAt: Date.now() + 600000,
        },
      });
    if (pathname === "/api/v1/cloud-browser/environment") return json({});
    if (pathname === "/api/v1/projects") {
      if (request.method() === "POST") {
        assert.equal(state.projects.length, 0, "Startup retries must not create another project");
        state.projects.push({
          id: projectId,
          name: request.postDataJSON().name,
          status: "stopped",
          generation: 1,
          createdAt: Date.now(),
        });
        return json({ project: state.projects[0] });
      }
      return json({ runtime: "docker", available: true, projects: state.projects });
    }
    if (pathname === `/api/v1/projects/${projectId}/start`) {
      if (state.failStart) {
        state.failStart = false;
        return json({ error: "owned startup unavailable" }, 503);
      }
      state.projects[0].status = "running";
      return json({ project: state.projects[0] });
    }
    if (pathname === `/p/${projectId}/api/v1/sessions`) return json({ sessions: [] });
    if (pathname === `/p/${projectId}/api/v1/configuration`) return json(state.configuration);
    if (
      pathname === `/p/${projectId}/api/v1/configuration/connections` &&
      request.method() === "PUT"
    ) {
      const { apiKey, ...connection } = request.postDataJSON();
      assert.equal(apiKey, "owned-fixture-key");
      state.configuration.connections = [
        { ...connection, tag: "text", hasApiKey: true, needsKey: true, revision: "a".repeat(64) },
      ];
      return json(state.configuration);
    }
    if (
      pathname === `/p/${projectId}/api/v1/configuration/defaults` &&
      request.method() === "PUT"
    ) {
      state.configuration.defaults = { ...state.configuration.defaults, ...request.postDataJSON() };
      return json(state.configuration);
    }
    blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    state.dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (state.confirmLeave) await dialog.accept();
    else await dialog.dismiss();
  });
  return { page, calls, state };
}
async function shot(page, name) {
  assert.ok(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    "Page must fit the viewport",
  );
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}
try {
  for (const [width, theme] of [
    [1440, "light"],
    [390, "dark"],
  ]) {
    const { page, calls, state } = await mount(width, theme);
    const prefix = `${width}-${theme}`;
    state.accountOffline = true;
    await page.goto(origin);
    await page.getByRole("heading", { name: /从一个想法开始/ }).waitFor();
    assert.equal(await page.getByLabel("用户名", { exact: true }).count(), 0);
    assert.ok(
      !calls.some((call) => call.path.includes("cloud") || call.path.endsWith("/status")),
      "Homepage never probes Cloud or waits for Account",
    );
    await shot(page, `${prefix}-00-home`);
    await page.getByRole("button", { name: "产品与内容", exact: true }).click();
    await page
      .getByRole("heading", { name: "让讨论，有可以接着做的成果。", exact: true })
      .waitFor();
    state.accountOffline = false;
    await page
      .getByRole("navigation", { name: "官网导航" })
      .locator("..")
      .getByRole("link", { name: "登录", exact: true })
      .click();
    await page.getByRole("link", { name: "没有账号？创建账号" }).waitFor();
    await shot(page, `${prefix}-01-login`);
    await page.getByRole("link", { name: "没有账号？创建账号" }).click();
    await page.getByLabel("昵称", { exact: true }).fill("测试账号");
    await page.getByLabel("用户名", { exact: true }).fill("fixture-user");
    await page.getByLabel("密码", { exact: true }).fill("test-only-password");
    await page.getByLabel("确认密码", { exact: true }).fill("test-only-password");
    await shot(page, `${prefix}-02-register`);
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await page.getByRole("heading", { name: "为第一个想法，建一个工作区" }).waitFor();
    await page.getByLabel("工作区名称", { exact: true }).fill("我的第一个工作区");
    await shot(page, `${prefix}-03-workspace`);
    await page.getByRole("button", { name: "创建并打开", exact: true }).click();
    await page.getByText(/工作区已创建，启动尚未完成/).waitFor();
    await page.getByRole("button", { name: "启动并打开", exact: true }).click();
    await page.getByRole("heading", { name: "连接模型，开始对话" }).waitFor();
    await shot(page, `${prefix}-04-model`);
    await page.getByLabel("任务内容", { exact: true }).fill("帮我整理一个学习计划");
    if (width < 760) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.locator(".website-account-menu > summary:visible").click();
    await page.getByRole("button", { name: "返回官网", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, "/app");
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    assert.equal(calls.filter((call) => call.path.endsWith("/logout")).length, 0);
    assert.equal(
      await page.getByLabel("任务内容", { exact: true }).inputValue(),
      "帮我整理一个学习计划",
    );
    await page.getByRole("button", { name: "账号设置", exact: true }).click();
    await page.getByRole("heading", { name: "账号资料", exact: true }).waitFor();
    await page.locator(".website-account-menu > summary:visible").click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    assert.equal(calls.filter((call) => call.path.endsWith("/logout")).length, 0);
    assert.equal(
      state.dialogs.length,
      3,
      "Both visible and retained workbench drafts guard account exit",
    );
    await page.getByRole("button", { name: /返回工作台/ }).click();
    if (width < 760)
      await page.getByRole("button", { name: "收起侧栏", exact: true }).first().click();
    await page.getByRole("button", { name: "配置第一个模型" }).click();
    await page.getByRole("button", { name: "添加连接", exact: true }).click();
    await page.getByLabel("连接名称", { exact: true }).fill("owned-model");
    await page.getByLabel("模型名称", { exact: true }).fill("fixture-model");
    await page.getByLabel("API Key", { exact: true }).fill("owned-fixture-key");
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    await page.getByRole("button", { name: "默认对话模型", exact: true }).click();
    await page.getByRole("option", { name: "fixture-model · owned-model", exact: true }).click();
    await page.getByRole("button", { name: "保存默认模型", exact: true }).click();
    await page.getByText("设置已保存，下次运行任务时生效。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "返回对话", exact: true }).click();
    assert.equal(
      await page.getByLabel("任务内容", { exact: true }).inputValue(),
      "帮我整理一个学习计划",
    );
    await page.getByRole("heading", { name: "今天想完成什么？" }).waitFor();
    assert.equal(await page.locator(".website-model-setup").count(), 0);
    await shot(page, `${prefix}-05-ready`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("这是隔离测试的回复。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.fixtureRuns.length), 1);
    if (width < 760) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.getByLabel("打开账号菜单", { exact: true }).click();
    await page.getByRole("button", { name: "返回官网", exact: true }).click();
    await page.getByRole("heading", { name: /从一个想法开始/ }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/");
    const homepageCalls = calls.length;
    await page
      .getByRole("navigation", { name: "官网导航" })
      .locator("..")
      .getByRole("link", { name: "进入工作台", exact: true })
      .waitFor();
    assert.ok(
      !calls
        .slice(homepageCalls)
        .some((call) => call.path.includes("cloud") || call.path.endsWith("/projects")),
    );
    await page
      .getByRole("navigation", { name: "官网导航" })
      .locator("..")
      .getByRole("link", { name: "进入工作台", exact: true })
      .click();
    await page.getByLabel("任务内容", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/app");
    assert.equal(
      await page.locator(".website-model-setup").count(),
      0,
      "Returning user bypasses setup",
    );
    assert.equal(
      calls.filter((call) => call.path === "/api/v1/projects" && call.method === "POST").length,
      1,
    );
    assert.equal(await page.evaluate(() => globalThis.sessionStorage.length), 0);
    await page.getByLabel("任务内容", { exact: true }).fill("只在确认后丢弃的草稿");
    if (width < 760) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.locator(".website-account-menu > summary:visible").click();
    state.confirmLeave = true;
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("heading", { name: "继续你的工作", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/login");
    assert.equal(calls.filter((call) => call.path === "/api/v1/account/web/logout").length, 1);
    assert.equal(calls.filter((call) => call.path === "/api/v1/cloud-browser/logout").length, 1);
    assert.deepEqual(
      state.dialogs.map((dialog) => dialog.type),
      ["beforeunload", "confirm", "confirm", "confirm"],
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify(
      {
        results: [
          "register → create → startup retry → model connection → default → retained draft → owned reply → returning user",
          "desktop light and mobile dark fit the viewport",
        ],
        errors,
        blocked,
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
