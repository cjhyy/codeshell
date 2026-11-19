/** Production Workbench/CSS with owned loopback navigation and account APIs.
 * External requests are blocked; no provider or operator credentials are used.
 * Run: bun run --cwd packages/web test:sidebar-browser
 */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceIndex = process.argv.indexOf("--source-repo");
const web =
  sourceIndex < 0
    ? fileURLToPath(new URL("..", import.meta.url))
    : path.resolve(process.argv[sourceIndex + 1], "packages/web");
const require = createRequire(path.join(web, "../desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output =
  process.env.CODESHELL_SIDEBAR_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-web-sidebar-")));
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {Workbench} from './Workbench';
  import {DesktopSidebar} from './DesktopControls';
  import {EnvironmentApiContext} from './EnvironmentMenu';
  function Fixture(){
    const [model,setModel]=React.useState(null);
    const read=async(url='/fixture/state')=>setModel(await (await fetch(url)).json());
    window.refreshFixture=()=>read();
    React.useEffect(()=>{void read()},[]);
    if(!model)return null;
    const noop=()=>{};
    const controller={panelSessionId:undefined,...model,host:model.host??'hub',workspaceApi:true,
      chat:{items:[],run:'idle',seq:1,liveByAgent:{}},configuration:null,
      configurationVersion:0,sessionsVersion:0,draft:model.draft??'',files:[],uploading:false,
      uploadBusy:false,hasUnsent:model.hasUnsent??false,uncertain:false,running:false,localDrafts:[],approvals:[],
      approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft:noop,
      removeFile:noop,selectSession:id=>read('/fixture/session?id='+encodeURIComponent(id)),
      newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,
      refreshConfiguration:noop,onAuthLost:noop,
      ...(model.host==='desktop'?{
        accountName:'桌面测试账号',logout:noop,
        renderSidebar:navigation=><DesktopSidebar navigation={navigation} app={{
          ...model.desktop,loading:{sessions:false,ccSessions:false},ccCliKind:'codex',
          ccProbe:{available:true},selectProject:noop,refreshSessions:noop,setCcCliKind:noop,
          newSession:request=>{window.createdRoot=request},
        }}/>,
      }:{}),
    };
    return <EnvironmentApiContext.Provider value={model.environmentApi??'/api/v1/environment'}>
      <Workbench controller={controller} projectName="导航审查项目"
        onBackToProjects={()=>{window.backCount=(window.backCount??0)+1}}/>
    </EnvironmentApiContext.Provider>;
  }
  createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(web, "app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: path.join(output, "bundle"),
  platform: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const sessions = Array.from({ length: 30 }, (_, index) => ({
  sessionId: `session-${index}`,
  title: `最近对话 ${index} · 较长项目与会话标题用于验证截断`,
  startedAt: index,
  status: "completed",
  turnCount: 3,
}));
const traceRecord = {
  version: 1,
  id: "fixture-request",
  traceId: "fixture-execution",
  sessionId: "session-1",
  source: "fixture",
  purpose: "main",
  provider: "fixture",
  model: "fixture-model",
  startedAt: 1800000000000,
  endedAt: 1800000000100,
  status: "completed",
  stream: false,
  inputState: "recorded",
  input: { systemPrompt: "Owned Workbench Prompt", messages: [], tools: [], parameters: {} },
  outputState: "recorded",
  output: { text: "Owned Workbench answer" },
  attempts: [],
};
let model = {
  sessions,
  activeId: "session-0",
  connection: "open",
  workspaceCwd: "/fixture",
  workspaceName: "导航审查项目",
  workspaceKey: "fixture",
  title: "最近对话 0",
  session: { username: "导航测试账号", deviceName: "Owned fixture" },
};
let environmentReply;
const requests = [],
  unexpected = [],
  external = [],
  errors = [],
  reports = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  requests.push(url.pathname + url.search);
  const reply = (body, status = 200, type = "application/json") => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  if (request.method !== "GET") {
    unexpected.push(`${request.method} ${request.url}`);
    return reply({}, 405);
  }
  if (url.pathname === "/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      200,
      "text/html",
    );
  if (url.pathname === "/fixture.js") return reply(js, 200, "text/javascript");
  if (url.pathname === "/fixture.css") return reply(css, 200, "text/css");
  if (url.pathname === "/fixture/state") return reply(model);
  if (
    url.pathname === "/fixture/session" &&
    sessions.some((item) => item.sessionId === url.searchParams.get("id"))
  ) {
    const activeId = url.searchParams.get("id");
    model = { ...model, activeId, title: `已打开 ${activeId}` };
    return reply(model);
  }
  if (["/api/v1/environment", "/api/v1/cloud-browser/environment"].includes(url.pathname))
    return environmentReply
      ? reply(environmentReply)
      : reply({ error: "环境信息暂时无法读取" }, 503);
  if (url.pathname === "/app" || url.pathname === "/mobile")
    return reply("<h1>Owned destination</h1>", 200, "text/html");
  if (url.pathname === "/api/v1/auth/sessions") return reply({ sessions: [] });
  if (url.pathname === "/api/v1/configuration")
    return reply({
      workspace: { path: "/fixture", skillDirectories: [] },
      defaults: {},
      connections: [],
      catalog: [],
      skills: [],
      mcpServers: [],
    });
  if (url.pathname === "/api/v1/model-traces/config")
    return reply({
      enabled: true,
      captureContent: false,
      includeEphemeral: false,
      retentionDays: 7,
    });
  if (url.pathname === "/api/v1/model-traces/sessions")
    return reply({
      items: [
        {
          key: `session:${traceRecord.sessionId}`,
          sessionId: traceRecord.sessionId,
          latestRequestId: traceRecord.id,
          latestTraceId: traceRecord.traceId,
          startedAt: traceRecord.startedAt,
          updatedAt: traceRecord.endedAt,
          callCount: 1,
          traceCount: 1,
          sources: [traceRecord.source],
          models: [traceRecord.model],
          runningCount: 0,
          failedCount: 0,
        },
      ],
      total: 1,
    });
  if (url.pathname === "/api/v1/model-traces") {
    const { input: _input, output: _output, attempts: _attempts, ...metadata } = traceRecord;
    return reply({ items: [{ ...metadata, attemptCount: 0 }], total: 1 });
  }
  if (url.pathname === "/api/v1/model-traces/fixture-request")
    return reply({ record: traceRecord, events: [] });
  unexpected.push(request.url);
  reply({}, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium
  .launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin" && existsSync(macChrome) ? macChrome : undefined),
  })
  .catch(async (cause) => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw cause;
  });
const context = await browser.newContext({ serviceWorkers: "block" });
await context.route("**/*", (route) => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
page.on("pageerror", (error) => errors.push(String(error)));
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const open = async () => {
  const toggle = page.getByRole("button", { name: "展开侧栏", exact: true });
  if (await toggle.count()) await toggle.click();
};
const focused = () =>
  page.evaluate(() => {
    const node = document.activeElement;
    const box = node.getBoundingClientRect();
    const clip = node.closest(".rail-content")?.getBoundingClientRect();
    const rail = document.querySelector(".rail").getBoundingClientRect();
    const top = clip?.top ?? rail.top,
      bottom = clip?.bottom ?? rail.bottom;
    const x = box.left + box.width / 2,
      y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      label: node.getAttribute("aria-label") || node.textContent.trim(),
      inside: Boolean(node.closest(".rail")),
      visible:
        box.width > 0 &&
        box.height > 0 &&
        box.top >= top - 1 &&
        box.bottom <= bottom + 1 &&
        box.left >= rail.left &&
        box.right <= rail.right &&
        Boolean(hit && node.contains(hit)),
      scroll: document.querySelector(".rail-content")?.scrollTop ?? 0,
    };
  });
const assertFocus = async () => {
  const result = await focused();
  assert.ok(result.inside && result.visible, JSON.stringify(result));
  return result;
};
// Execution traces are reached from the settings overview, not the sidebar.
const openTraces = async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".config-overview-row", { hasText: "执行观测" }).click();
};
const inspectTrace = async () => {
  const explorer = page.locator(".cs-trace-explorer");
  await explorer.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("view"), "activity");
  await explorer.locator(".cs-t-pane").nth(0).locator(".cs-t-item").first().click();
  await explorer.locator(".cs-t-pane").nth(1).locator(".cs-t-item").first().click();
  await explorer.getByText("Owned Workbench Prompt", { exact: true }).waitFor();
  await explorer.getByRole("button", { name: "打开原会话", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".topbar-title")?.textContent.includes("session-1"),
  );
  await page.locator(".messages").waitFor();
  assert.equal(new URL(page.url()).searchParams.has("view"), false);
};
try {
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const size of [
      { width: 320, height: 480 },
      { width: 390, height: 540 },
      { width: 760, height: 540 },
      { width: 1280, height: 540 },
      { width: 390, height: 780 },
      { width: 844, height: 390 },
    ]) {
      model = { ...model, sessions, activeId: "session-0", connection: "open" };
      await page.setViewportSize(size);
      await page.goto(origin);
      await page.locator(".messages").waitFor();
      await open();
      const footer = await page.locator(".rail-footer").boundingBox();
      assert.ok(
        footer.y >= 0 && footer.y + footer.height <= size.height + 1,
        `Account navigation outside ${JSON.stringify(size)}: ${JSON.stringify(footer)}`,
      );
      await page.locator(".sidebar-close").focus();
      const labels = [],
        count = await page.locator('.rail button, .rail input, .rail [tabindex="0"]').count();
      for (let index = 0; index < count; index++) {
        labels.push((await assertFocus()).label);
        await page.keyboard.press("Tab");
      }
      assert.equal(labels.filter((label) => label.startsWith("最近对话")).length, 30);
      assert.ok(labels.some((label) => label.includes("设备与退出")));
      if (size.width <= 760) {
        assert.equal((await assertFocus()).label, "收起侧栏");
        await page.keyboard.press("Shift+Tab");
        assert.ok((await assertFocus()).label.includes("设备与退出"));
        await page.keyboard.press("Tab");
      }
      const region = page.getByRole("region", { name: "功能与最近对话", exact: true });
      await region.focus();
      await page.keyboard.press("End");
      await page.waitForFunction(() => {
        const node = document.querySelector(".rail-content");
        return node.scrollHeight - node.clientHeight - node.scrollTop < 2;
      });
      await page.screenshot({
        path: path.join(output, `${theme}-${size.width}x${size.height}-sessions.png`),
      });
      await page.locator(".sessions button.session").last().click();
      await page.waitForFunction(() =>
        document.querySelector(".topbar-title")?.textContent.includes("session-29"),
      );
      if (size.width <= 760) {
        assert.equal(await page.locator(".rail").isVisible(), false);
        assert.equal(
          await page
            .getByRole("button", { name: "展开侧栏", exact: true })
            .evaluate((node) => document.activeElement === node),
          true,
        );
      }
      await open();
      await page.getByRole("button", { name: /导航测试账号.*设备与退出/ }).click();
      await page.getByRole("dialog", { name: "账号与设备", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page
        .getByRole("dialog", { name: "账号与设备", exact: true })
        .waitFor({ state: "detached" });
      await open();
      await page.getByRole("button", { name: "电脑与云端", exact: false }).click();
      const environment = page.getByRole("dialog", { name: "电脑与云端", exact: true });
      await environment.waitFor();
      assert.equal(await environment.locator("form, input, details").count(), 0);
      assert.doesNotMatch(
        await environment.textContent(),
        /高级|手动添加|选择项目|当前地址|https?:\/\//,
      );
      assert.match(await environment.getByRole("alert").textContent(), /环境信息暂时无法读取/);
      await page.keyboard.press("Escape");
      await environment.waitFor({ state: "detached" });
      assert.equal(await page.locator(".rail").isVisible(), true);
      await assertFocus();
      assert.equal(
        await page
          .locator(".environment-trigger")
          .evaluate((node) => document.activeElement === node),
        true,
      );
      await page.locator(".environment-trigger").click();
      await environment.getByRole("button", { name: "关闭", exact: true }).click();
      await assertFocus();
      assert.equal(
        await page
          .locator(".environment-trigger")
          .evaluate((node) => document.activeElement === node),
        true,
      );
      await openTraces();
      await inspectTrace();
      reports.push({ theme, size, keyboardStops: count, footer });
    }
  }
  for (const size of [
    { width: 390, height: 360 },
    { width: 1000, height: 360 },
  ]) {
    model = {
      ...model,
      host: "desktop",
      sessions,
      desktop: {
        activeProjectId: "multi-root",
        activeProjectCwd: "/fixture",
        activeCwd: "/fixture",
        projects: [
          {
            id: "multi-root",
            name: "多目录项目",
            path: "/fixture",
            roots: Array.from({ length: 8 }, (_, index) => ({
              id: `root-${index}`,
              name: `目录 ${index}`,
              path: `/fixture/root-${index}`,
              role: index === 0 ? "primary" : "additional",
            })),
          },
        ],
        ccSessions: Array.from({ length: 12 }, (_, index) => ({
          sessionId: `cli-${index}`,
          firstMessage: `CLI 对话 ${index}`,
          messageCount: index + 1,
          cwd: "/fixture",
        })),
      },
    };
    await page.setViewportSize(size);
    await page.goto(origin);
    await page.locator(".messages").waitFor();
    await open();
    await page.getByRole("button", { name: "在项目中新建", exact: true }).click();
    await page.locator(".desktop-cli-sessions summary").click();
    await page.locator(".sidebar-close").focus();
    const count = await page
      .locator(".rail")
      .evaluate(
        (node) =>
          [
            ...node.querySelectorAll(
              'button:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
            ),
          ].filter((element) => element.getClientRects().length > 0).length,
      );
    const labels = [];
    for (let index = 0; index < count; index++) {
      labels.push((await assertFocus()).label);
      await page.keyboard.press("Tab");
    }
    assert.equal(labels.filter((label) => /^目录 \d/.test(label)).length, 8);
    assert.equal(labels.filter((label) => /^CLI 对话 \d/.test(label)).length, 12);
    await page.locator(".desktop-root-picker .session").last().click();
    assert.deepEqual(await page.evaluate(() => window.createdRoot), {
      projectId: "multi-root",
      rootId: "root-7",
    });
    if (size.width <= 760) assert.equal(await page.locator(".rail").isVisible(), false);
    await open();
    await page.locator(".desktop-cli-sessions .session").last().focus();
    await assertFocus();
    await page.screenshot({
      path: path.join(output, `desktop-${size.width}x${size.height}-cli.png`),
    });
    await openTraces();
    await inspectTrace();
    await page.goto(`${origin}/?view=activity`);
    await inspectTrace();
    reports.push({ host: "desktop", size, keyboardStops: count });
  }
  // One click opens the account directory through the real workbench's existing
  // dirty-navigation guard. Previously saved addresses remain untouched.
  const savedAddress = origin + "/mobile";
  await page.evaluate((address) => {
    window.localStorage.setItem(
      "codeshell.environments.v1",
      JSON.stringify([{ name: "原来的电脑", address }]),
    );
  }, savedAddress);
  for (const cloud of [false, true]) {
    environmentReply = {
      version: 1,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: cloud ? "云端" : "我的电脑",
      kind: cloud ? "project-host" : "desktop",
      entryPath: cloud ? "/" : "/mobile",
      ...(cloud ? {} : { accountComputers: origin + "/ignored-path" }),
    };
    model = {
      ...model,
      host: "hub",
      sessions,
      connection: "open",
      environmentApi: cloud ? "/api/v1/cloud-browser/environment" : "/api/v1/environment",
      draft: "仍然保留的未发送草稿",
      hasUnsent: true,
    };
    await page.setViewportSize({ width: cloud ? 1280 : 390, height: 780 });
    await page.goto(origin);
    await page.locator(".messages").waitFor();
    await open();
    const trigger = page.locator(".environment-trigger");
    await trigger.filter({ hasText: environmentReply.name }).waitFor();
    const originalUrl = page.url();
    await trigger.click();
    const guard = page.getByRole("dialog", { name: "还有未保存的修改", exact: true });
    await guard.waitFor();
    assert.equal(await page.getByRole("dialog", { name: "电脑与云端", exact: true }).count(), 0);
    assert.equal(page.url(), originalUrl);
    await page.screenshot({
      path: path.join(output, `computer-cloud-direct-${cloud ? "cloud" : "computer"}.png`),
    });
    await guard.getByRole("button", { name: "留在此页", exact: true }).click();
    assert.equal(await page.locator(".composer textarea").inputValue(), model.draft);
    await trigger.click();
    await guard.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
    await page.waitForURL(origin + "/app?target=choose");
    reports.push({
      switcher: cloud ? "cloud" : "computer",
      directNavigation: true,
      draftGuard: true,
    });
  }
  environmentReply = {
    version: 1,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "我的电脑",
    kind: "desktop",
    entryPath: "/mobile",
  };
  model = { ...model, environmentApi: "/api/v1/environment", draft: "", hasUnsent: false };
  await page.goto(origin);
  await page.locator(".messages").waitFor();
  await open();
  await page.locator(".environment-trigger").click();
  const reconnect = page.getByRole("dialog", { name: "电脑与云端", exact: true });
  await reconnect
    .getByText("请在这台电脑的 CodeShell 中登录账号并开启远程访问", { exact: false })
    .waitFor();
  assert.equal(
    await reconnect.getByRole("button", { name: "选择电脑或云端", exact: true }).count(),
    0,
  );
  environmentReply = { ...environmentReply, accountComputers: origin + "/" };
  assert.equal(await reconnect.getByRole("list", { name: "已保存的连接", exact: true }).count(), 0);
  await reconnect.getByRole("button", { name: "重试连接", exact: true }).click();
  await page.waitForURL(origin + "/app?target=choose");
  assert.equal(
    JSON.parse(
      await page.evaluate(() => window.localStorage.getItem("codeshell.environments.v1")),
    )[0].address,
    savedAddress,
  );
  await page.evaluate(() => window.localStorage.removeItem("codeshell.environments.v1"));
  environmentReply = undefined;
  reports.push({ switcher: "unavailable", retryOpensDirectory: true, savedRecordPreserved: true });
  model = { ...model, host: "hub", sessions, connection: "open" };
  await page.goto(`${origin}/?view=activity`);
  await inspectTrace();
  model = { ...model, host: "hub", sessions: [], connection: "closed" };
  await page.setViewportSize({ width: 390, height: 360 });
  await page.goto(origin);
  await page.locator(".messages").waitFor();
  await open();
  const region = page.getByRole("region", { name: "功能与最近对话", exact: true });
  await region.focus();
  await page.keyboard.press("End");
  await frames();
  await page.locator(".sessions .empty").scrollIntoViewIfNeeded();
  assert.equal(
    await page.locator(".sessions .empty").evaluate((node) => {
      const box = node.getBoundingClientRect(),
        clip = node.closest(".rail-content").getBoundingClientRect();
      return box.top >= clip.top && box.bottom <= clip.bottom;
    }),
    true,
  );
  await page.screenshot({ path: path.join(output, "dark-390x360-empty-offline.png") });
  await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
  assert.equal(await page.evaluate(() => window.backCount), 1);
  await page.setViewportSize({ width: 1280, height: 540 });
  await frames();
  assert.equal(await page.locator(".rail").getAttribute("role"), null);
  await page.setViewportSize({ width: 390, height: 360 });
  await frames();
  assert.equal(await page.locator(".rail").isVisible(), false);
  assert.equal(
    await page
      .getByRole("button", { name: "展开侧栏", exact: true })
      .evaluate((node) => document.activeElement === node),
    true,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(external, []);
  console.log(
    JSON.stringify(
      { output, layouts: reports.length, requests: requests.length, reports },
      null,
      2,
    ),
  );
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ reports, requests, errors, unexpected, external }, null, 2),
  );
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
