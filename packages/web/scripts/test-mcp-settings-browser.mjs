/* Production Workbench MCP settings, owned HTTP, native keyboard/focus and exact request contracts. */
/* global window, document, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, Event */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownRepo = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-repo");
const repo = sourceIndex < 0 ? ownRepo : path.resolve(process.argv[sourceIndex + 1]);
const require = createRequire(path.join(ownRepo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const out = await mkdtemp(path.join(tmpdir(), "codeshell-web-mcp-"));
const source = `import React from 'react';import {createRoot} from 'react-dom/client';import {Workbench} from './Workbench';
const noop=()=>{};const root=createRoot(document.getElementById('root'));
function Fixture(){const [version,setVersion]=React.useState(0);window.refreshConfigurationFixture=()=>setVersion(n=>n+1);
const controller={host:'desktop',workspaceApi:true,connection:'open',activeId:'owned',chat:{items:[],run:'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:'New conversation',configuration:null,configurationVersion:version,sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:noop,newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:()=>window.authLost++};return <Workbench controller={controller}/>;}
window.authLost=0;window.unmountFixture=()=>root.render(null);root.render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: out,
  platform: "browser",
  format: "iife",
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.argv.includes("--development") ? "development" : "production",
    ),
  },
});
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
  reports = [];
const origin = "http://web-mcp-owned.test";
const startUrl = origin + "/?view=settings&section=mcp";
const snapshot = () => ({
  workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
  defaults: { text: "owned-0" },
  connections: Array.from({ length: 12 }, (_, i) => ({
    id: "owned-" + i,
    revision: String(i).padStart(64, "0"),
    catalogId: "openai",
    tag: "text",
    model: "owned-model-" + i,
    baseUrl: "https://owned.invalid/v1",
    hasApiKey: true,
    needsKey: true,
  })),
  catalog: [
    {
      id: "openai",
      displayName: "Owned provider",
      adapterKind: "openai",
      defaultBaseUrl: "https://owned.invalid/v1",
      needsKey: true,
    },
  ],
  skills: [],
  mcpServers: [],
  restartRequired: false,
});
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function visibleFocus(locator) {
  const value = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect(),
      hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const hidden = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/hidden|clip/.test(s.overflowY) && p.scrollTop !== 0)
        hidden.push({ tag: p.tagName, scroll: p.scrollTop });
    }
    return {
      focused: el === document.activeElement,
      hit: !!hit && el.contains(hit),
      box: box.toJSON(),
      width: innerWidth,
      height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      hidden,
    };
  });
  assert.equal(value.focused, true, JSON.stringify(value));
  assert.equal(value.hit, true, JSON.stringify(value));
  assert.ok(
    value.box.top >= 0 &&
      value.box.bottom <= value.height + 1 &&
      value.box.left >= 0 &&
      value.box.right <= value.width + 1,
    JSON.stringify(value),
  );
  assert.deepEqual(value.hidden, []);
  assert.ok(
    value.documentWidth <= value.width + 1 && value.documentHeight <= value.height + 1,
    JSON.stringify(value),
  );
}

const mcpSnapshot = () => ({
  workspacePath: "/owned",
  removed: [],
  servers: Array.from({ length: 12 }, (_, i) => ({
    name: "owned-mcp-" + i,
    source: "settings",
    scope: "local",
    editable: true,
    deletable: true,
    hasLocalOverride: false,
    pluginDisabled: false,
    enabled: true,
    transport: "stdio",
    command: "/owned/server-" + i,
    argsCount: 1,
    envKeys: ["OWNED_TOKEN"],
    headerKeys: [],
    envVars: [],
    envHeaders: {},
    disabledTools: [],
  })),
});
const longError = "Owned operation rejected: " + "Diagnostic_".repeat(120) + "\nFull final line";
const card = (page) => page.locator(".hub-mcp-card").last();
const editor = (page) => page.locator(".hub-mcp-editor");
const command = (page) => editor(page).getByRole("textbox", { name: "启动命令", exact: true });
const edit = (page) => card(page).getByRole("button", { name: "编辑", exact: true });
const add = (page) => page.getByRole("button", { name: "＋ 添加服务", exact: true });
const remove = (page) => card(page).getByRole("button", { name: "移除", exact: true });
const confirm = (page) => card(page).getByRole("button", { name: "确认移除", exact: true });
const error = (page) => page.locator(".hub-mcp-operation-error");
async function mount(config = { width: 390, height: 360, theme: "light" }) {
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    colorScheme: config.theme,
    serviceWorkers: "block",
  });
  const host = {
    mcp: mcpSnapshot(),
    mode: "reject",
    calls: [],
    pending: [],
    reads: 0,
    allowProbe: false,
    probes: [],
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    if (request.url() === startUrl)
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><input id="outside-field" aria-label="Outside field" style="position:fixed;bottom:0;right:0;width:60px;z-index:999"><div id="outside-blank" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:999"></div>',
      });
    if (url.origin !== origin) {
      blocked.push(request.url());
      return route.abort();
    }
    if (url.pathname === "/api/v1/environment" && method === "GET")
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    if (url.pathname === "/api/v1/configuration" && method === "GET")
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot()) });
    if (url.pathname === "/api/v1/mcp" && method === "GET") {
      host.reads++;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(host.mcp) });
    }
    if (
      url.pathname === "/api/v1/mcp/servers/owned-mcp-11/probe" &&
      method === "POST" &&
      host.allowProbe
    ) {
      host.probes.push(request.postDataJSON());
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          name: "owned-mcp-11",
          status: "ok",
          checkedAt: new Date().toISOString(),
          durationMs: 1,
          toolCount: 0,
          tools: [],
        }),
      });
    }
    if (url.pathname === "/api/v1/mcp/servers/owned-mcp-11" && ["PUT", "DELETE"].includes(method)) {
      const call = { method, path: url.pathname, body: request.postDataJSON() ?? null };
      host.calls.push(call);
      if (host.mode === "hold") {
        host.pending.push({ route, call });
        return;
      }
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: longError }),
      });
    }
    blocked.push(request.url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(startUrl);
  for (const file of bundle.outputFiles.filter((f) => f.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((f) => f.path.endsWith(".js")).text });
  await edit(page).waitFor();
  await frames(page);
  return { page, context, host };
}
async function openExisting(page) {
  await edit(page).focus();
  await page.keyboard.press("Enter");
  await editor(page).waitFor();
  await frames(page);
  await visibleFocus(command(page));
}
async function prepareWrite(page) {
  await command(page).fill("/owned/new-server");
  await editor(page)
    .getByRole("checkbox", {
      name: "允许新的启动方式或服务地址使用已保存的参数、环境变量和认证配置。",
      exact: true,
    })
    .check();
}
async function settleWrite(page) {
  await page.waitForFunction(() => !document.querySelector(".hub-mcp-editor fieldset")?.disabled);
  await frames(page);
}
async function waitHeld(page, host) {
  const deadline = Date.now() + 5000;
  while (!host.pending.length) {
    assert.ok(Date.now() < deadline, "Owned write must arrive");
    await frames(page);
  }
  assert.equal(host.calls.length, 1);
}
async function finish(host, status = 500) {
  const pending = host.pending.shift();
  assert.ok(pending);
  if (status === 200) {
    host.mcp.servers =
      pending.call.method === "DELETE"
        ? host.mcp.servers.filter((s) => s.name !== "owned-mcp-11")
        : host.mcp.servers.map((s) =>
            s.name === "owned-mcp-11" ? { ...s, command: "/owned/new-server" } : s,
          );
  }
  await pending.route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status === 200 ? host.mcp : { error: longError }),
  });
}
function exactWrite(host, method) {
  assert.deepEqual(host.calls, [
    {
      method,
      path: "/api/v1/mcp/servers/owned-mcp-11",
      body:
        method === "DELETE"
          ? null
          : { name: "owned-mcp-11", command: "/owned/new-server", reuseStoredSecrets: true },
    },
  ]);
}
let currentPage;
try {
  for (const [width, height] of [
    [320, 240],
    [320, 360],
    [390, 700],
    [1280, 820],
  ])
    for (const theme of ["light", "dark"]) {
      const { page, context, host } = await mount({ width, height, theme });
      currentPage = page;
      await openExisting(page);
      assert.equal(await command(page).inputValue(), "/owned/server-11");
      assert.equal(await editor(page).locator("input[type=password]").inputValue(), "");
      await editor(page).getByRole("button", { name: "取消", exact: true }).click();
      await editor(page).waitFor({ state: "hidden" });
      await frames(page);
      await visibleFocus(edit(page));
      await add(page).click();
      await editor(page).waitFor();
      await frames(page);
      await visibleFocus(editor(page).getByRole("textbox", { name: "服务名称", exact: true }));
      await editor(page).getByRole("button", { name: "取消", exact: true }).click();
      await editor(page).waitFor({ state: "hidden" });
      await frames(page);
      await visibleFocus(add(page));
      await openExisting(page);
      await prepareWrite(page);
      await editor(page).getByRole("button", { name: "保存配置", exact: true }).click();
      await error(page).waitFor();
      await settleWrite(page);
      await visibleFocus(error(page));
      assert.equal(await error(page).textContent(), longError);
      assert.equal(await page.getByRole("alert").count(), 1);
      assert.equal(await command(page).inputValue(), "/owned/new-server");
      exactWrite(host, "PUT");
      await page.keyboard.press("End");
      if (await error(page).evaluate((n) => n.scrollHeight > n.clientHeight))
        await page.waitForFunction((n) => n.scrollTop > 0, await error(page).elementHandle());
      await page.keyboard.press("Tab");
      await visibleFocus(editor(page).getByRole("button", { name: "取消", exact: true }));
      await page.keyboard.press("Enter");
      await editor(page).waitFor({ state: "hidden" });
      await frames(page);
      await visibleFocus(edit(page));
      host.calls = [];
      await remove(page).focus();
      await page.keyboard.press("Enter");
      await card(page).locator(".hub-mcp-delete").waitFor();
      await frames(page);
      await visibleFocus(card(page).getByRole("button", { name: "取消", exact: true }));
      await confirm(page).click();
      await error(page).waitFor();
      await frames(page);
      await visibleFocus(error(page));
      assert.equal(await error(page).textContent(), longError);
      assert.equal(await page.getByRole("alert").count(), 1);
      assert.equal(await page.locator(".hub-mcp-card").count(), 12);
      exactWrite(host, "DELETE");
      await page.keyboard.press("Tab");
      await visibleFocus(card(page).getByRole("button", { name: "取消", exact: true }));
      await page.keyboard.press("Tab");
      await visibleFocus(confirm(page));
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await card(page).locator(".hub-mcp-delete").waitFor({ state: "hidden" });
      await frames(page);
      await visibleFocus(remove(page));
      await page.screenshot({ path: path.join(out, `mcp-${width}-${height}-${theme}.png`) });
      reports.push({ kind: "layout", width, height, theme });
      await context.close();
    }
  for (const operation of ["edit", "remove"])
    for (const outcome of [500, 200])
      for (const interruption of ["field", "blank", "svg", "blur"]) {
        const { page, context, host } = await mount();
        currentPage = page;
        host.mode = "hold";
        if (operation === "edit") {
          await openExisting(page);
          await prepareWrite(page);
          await editor(page).getByRole("button", { name: "保存配置", exact: true }).click();
        } else {
          await remove(page).click();
          await confirm(page).click();
        }
        await waitHeld(page, host);
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll(".hub-mcp fieldset, .hub-mcp-delete button")).some(
            (n) => n.disabled,
          ),
        );
        await frames(page);
        if (interruption === "field")
          await page
            .getByRole("searchbox", { name: "搜索 MCP 服务", exact: true })
            .fill("owned-mcp");
        if (interruption === "blank") await page.mouse.click(5, 355);
        if (interruption === "svg") {
          await page.locator("#outside-blank").evaluate((node) => {
            node.innerHTML =
              '<svg width="24" height="24"><rect width="24" height="24" fill="currentColor" /></svg>';
          });
          await page.mouse.click(5, 355);
        }
        if (interruption === "blur")
          await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        const token = await page.evaluate(() =>
          document.activeElement === document.body
            ? "BODY"
            : document.activeElement.id ||
              document.activeElement.getAttribute("aria-label") ||
              document.activeElement.textContent,
        );
        await finish(host, outcome);
        if (outcome === 500) await error(page).waitFor();
        else if (operation === "edit") await editor(page).waitFor({ state: "hidden" });
        else
          await page.waitForFunction(
            () => document.querySelectorAll(".hub-mcp-card").length === 11,
          );
        await frames(page);
        assert.equal(
          await page.evaluate(() =>
            document.activeElement === document.body
              ? "BODY"
              : document.activeElement.id ||
                document.activeElement.getAttribute("aria-label") ||
                document.activeElement.textContent,
          ),
          token,
          `${operation}/${outcome}/${interruption} cannot reclaim focus`,
        );
        exactWrite(host, operation === "edit" ? "PUT" : "DELETE");
        reports.push({ kind: "owner", operation, outcome, interruption });
        await context.close();
      }
  for (const operation of ["edit", "remove"]) {
    const { page, context, host } = await mount();
    currentPage = page;
    host.mode = "hold";
    if (operation === "edit") {
      await openExisting(page);
      await prepareWrite(page);
      await editor(page).getByRole("button", { name: "保存配置", exact: true }).click();
      await editor(page).dispatchEvent("submit");
    } else {
      await remove(page).click();
      await confirm(page).click();
      await confirm(page).evaluate((n) => {
        n.click();
        n.click();
      });
    }
    await waitHeld(page, host);
    await finish(host, 200);
    await frames(page);
    if (operation === "edit") {
      await editor(page).waitFor({ state: "hidden" });
      await visibleFocus(edit(page));
    } else {
      await page.waitForFunction(() => document.querySelectorAll(".hub-mcp-card").length === 11);
      await visibleFocus(page.getByRole("searchbox", { name: "搜索 MCP 服务", exact: true }));
    }
    exactWrite(host, operation === "edit" ? "PUT" : "DELETE");
    reports.push({ kind: "duplicate-owned-success", operation });
    await context.close();
  }
  for (const operation of ["edit", "remove"]) {
    const { page, context, host } = await mount();
    currentPage = page;
    host.mode = "hold";
    if (operation === "edit") {
      await openExisting(page);
      await prepareWrite(page);
      await editor(page).getByRole("button", { name: "保存配置", exact: true }).click();
    } else {
      await remove(page).click();
      await confirm(page).click();
    }
    await waitHeld(page, host);
    await page.evaluate(() => window.unmountFixture());
    const outside = page.getByRole("textbox", { name: "Outside field", exact: true });
    await outside.focus();
    await finish(host, 500);
    await frames(page);
    await visibleFocus(outside);
    assert.equal(await editor(page).count(), 0);
    assert.equal(await error(page).count(), 0);
    reports.push({ kind: "unmounted-operation", operation });
    await context.close();
  }
  {
    const { page, context, host } = await mount();
    currentPage = page;
    host.mode = "hold";
    host.allowProbe = true;
    await openExisting(page);
    await prepareWrite(page);
    await editor(page).getByRole("button", { name: "保存并测试", exact: true }).click();
    await waitHeld(page, host);
    await finish(host, 200);
    await page.locator(".hub-mcp-probe-result").waitFor();
    await editor(page).waitFor({ state: "hidden" });
    await frames(page);
    await visibleFocus(edit(page));
    exactWrite(host, "PUT");
    assert.deepEqual(host.probes, [{}]);
    reports.push({ kind: "explicit-save-and-test" });
    await context.close();
  }
  // An auth rejection follows the original auth-lost callback; no local alert is fabricated.
  {
    const { page, context, host } = await mount();
    currentPage = page;
    await openExisting(page);
    await prepareWrite(page);
    host.mode = "hold";
    await editor(page).getByRole("button", { name: "保存配置", exact: true }).click();
    await waitHeld(page, host);
    await finish(host, 401);
    await page.waitForFunction(() => window.authLost === 1);
    assert.equal(await error(page).count(), 0);
    reports.push({ kind: "auth-lost" });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} catch (cause) {
  if (currentPage)
    await currentPage.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  throw cause;
} finally {
  await browser.close();
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ repo, reports, errors, blocked }, null, 2),
  );
  console.log(JSON.stringify({ out, observations: reports.length, errors, blocked }));
}
