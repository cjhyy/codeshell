/** Real Workbench + sandboxed Panel iframe. Only owned, intercepted HTTP fixtures. */
/* global window, document, history, location, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const web = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(web, "../desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-directory-picker-"));
const development = process.argv.includes("--development");
const sourceArg = process.argv.indexOf("--source-repo");
const resolveDir =
  sourceArg < 0
    ? path.join(web, "app")
    : path.join(process.argv[sourceArg + 1], "packages/web/app");
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';
const noop=()=>{};window.sends=[];window.hostEvents=[];
function Fixture(){const[workspace,setWorkspace]=React.useState('/owned/A'),[draft,setDraft]=React.useState('Retained unsent draft');window.changeWorkspace=()=>setWorkspace('/owned/B');
const controller={panelSessionId:'owned-session',host:'desktop',workspaceApi:true,connection:'open',activeId:'owned-session',chat:{items:[],run:'idle'},sessions:[],workspaceCwd:workspace,workspaceName:'Owned project',workspaceKey:workspace,title:'Owned conversation',configuration:null,configurationVersion:0,sessionsVersion:0,draft,files:[],uploading:false,uploadBusy:false,hasUnsent:!!draft,uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft,removeFile:noop,selectSession:noop,newSession:noop,send:()=>{window.sends.push(draft);return false},stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:()=>{throw Error('Unexpected auth loss')}};
return <Workbench controller={controller}/>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir, loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
});
const js = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((f) => f.path.endsWith(".css"))
  .map((f) => f.text)
  .join("\n");
const origin = "http://directory-picker-owned.test";
const rootToken = "r".repeat(24),
  downloadsToken = "d".repeat(24),
  childToken = "c".repeat(24);
const tokens = Array.from({ length: 70 }, (_, i) => "directory" + String(i).padStart(15, "0"));
const panel = {
  id: "owned-panel",
  version: "1.0.0",
  title: { default: "Owned Panel" },
  entry: "index.html",
  icon: "panel",
  singleton: true,
  permissions: ["filesystem"],
  revision: "a".repeat(64),
  bound: true,
  enabled: true,
  globalDisabled: false,
  updatable: false,
  source: { kind: "local", label: "Owned fixture" },
  compatibility: { supported: true, reasons: [] },
};
const errors = [],
  blocked = [],
  reports = [],
  requests = [],
  instances = new Map();
let sequence = 0,
  scenario = "normal",
  releaseList;
const heldLists = [];
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: "block",
});
await context.addInitScript(() => {
  Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
  window.touchEvidence = [];
  for (const name of ["touchstart", "touchmove", "touchend"])
    document.addEventListener(
      name,
      (event) => window.touchEvidence.push({ type: event.type, trusted: event.isTrusted }),
      { passive: true },
    );
});
await context.route("**/*", async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    pathname = url.pathname;
  if (url.origin !== origin) {
    blocked.push(req.url());
    return route.abort();
  }
  const body = req.method() === "POST" ? req.postDataJSON() : undefined;
  requests.push({ pathname, method: req.method(), body });
  const reply = (value, status = 200, type = "application/json") =>
    route
      .fulfill({
        status,
        contentType: type,
        body: type === "application/json" ? JSON.stringify(value) : value,
      })
      .catch(() => {});
  if (pathname === "/mobile/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      200,
      "text/html",
    );
  if (pathname === "/fixture.js") return reply(js, 200, "text/javascript");
  if (pathname === "/fixture.css") return reply(css, 200, "text/css");
  if (pathname === "/api/v1/environment") return reply({}, 404);
  if (pathname === "/api/v1/configuration")
    return reply({
      workspace: { path: "/owned/A", settingsScope: "local", skillDirectories: [] },
      defaults: {},
      connections: [],
      catalog: [],
      skills: [],
      mcpServers: [],
      restartRequired: false,
    });
  if (pathname === "/api/v1/panels")
    return reply({ workspace: "/owned/A", hasProject: true, panels: [panel] });
  if (pathname === "/api/v1/panels/runtime/prepare") {
    const id = "owned-instance-" + String(++sequence).padStart(12, "0");
    instances.set(id, { events: [], closed: false, pending: null, selected: "original-directory" });
    return reply({
      instanceId: id,
      src: "/api/v1/panel-assets/" + id + "/index.html",
      expiresAt: Date.now() + 600000,
      context: { host: "desktop" },
      limitations: [],
    });
  }
  if (pathname.startsWith("/api/v1/panel-assets/")) {
    const id = pathname.split("/")[4];
    return reply(
      `<button id="pick" style="min-height:44px">更改目录</button><p id="result">original-directory</p><script>
      const id=${JSON.stringify(id)};let counter=0;window.hostConfirmCount=0;
      addEventListener('message',e=>{if(e.data?.event==='host.confirm')hostConfirmCount++;if(e.data?.type==='codeshell-panel:response'){document.querySelector('#result').textContent=JSON.stringify(e.data.result??e.data.error)}});
      document.querySelector('#pick').onclick=()=>parent.postMessage({type:'codeshell-panel:call',instanceId:id,requestId:'call-'+(++counter),method:'filesystem.pickDirectory',params:{}},'*');
      parent.postMessage({type:'codeshell-panel:ready',instanceId:id},'*');</script>`,
      200,
      "text/html",
    );
  }
  const match = /^\/api\/v1\/panels\/runtime\/([^/]+)(.*)$/.exec(pathname);
  if (match) {
    const instance = instances.get(match[1]),
      suffix = match[2];
    assert.ok(instance);
    if (req.method() === "DELETE") {
      instance.closed = true;
      instance.pending?.({ cancelled: true });
      instance.pending = null;
      return reply({ closed: true });
    }
    if (suffix === "/events")
      return reply({
        cursor: instance.events.length,
        events: instance.events.filter((e) => e.id > Number(url.searchParams.get("after"))),
      });
    if (suffix === "/renew") return reply({ expiresAt: Date.now() + 600000 });
    if (suffix === "/call") {
      assert.equal(body.method, "filesystem.pickDirectory");
      const requestId = "request-" + String(instance.events.length + 1);
      instance.requestId = requestId;
      instance.events.push({
        id: instance.events.length + 1,
        event: "host.confirm",
        payload: {
          requestId,
          title: "选择电脑上的目录",
          body: "Owned project",
          expiresAt: Date.now() + 300000,
          directoryPicker: {
            kind: "workspace-directory",
            rootPath: "/owned/A",
            rootToken,
            initialToken: scenario === "root-default" ? rootToken : downloadsToken,
          },
        },
      });
      const result = await new Promise((resolve) => {
        instance.pending = resolve;
      });
      return reply(result);
    }
    if (suffix === "/directory-picker") {
      assert.equal(body.requestId, instance.requestId);
      assert.deepEqual(Object.keys(body).sort(), ["directoryToken", "requestId"]);
      if (scenario === "retry") {
        return reply({ error: "Owned transient error" }, 503);
      }
      if (scenario === "expired") return reply({ error: "Owned expired" }, 409);
      if (scenario === "revoked") return reply({ error: "Owned revoked" }, 410);
      if (scenario === "held")
        await new Promise((resolve) => {
          heldLists.push(resolve);
          releaseList = () => heldLists.splice(0).forEach((done) => done());
        });
      const token = body.directoryToken;
      assert.ok([rootToken, downloadsToken, childToken, ...tokens].includes(token));
      const result = {
        requestId: body.requestId,
        directoryToken: token,
        rootToken,
        name: token === rootToken ? "A" : token === downloadsToken ? "downloads" : "nested",
        relativePath:
          token === rootToken ? "" : token === downloadsToken ? "downloads" : "downloads/nested",
        ...(token !== rootToken
          ? { parentToken: token === downloadsToken ? rootToken : downloadsToken }
          : {}),
        directories:
          token === downloadsToken
            ? tokens.map((token, i) => ({
                name: i === 69 ? "最后一个电脑文件夹" : "项目子目录 " + String(i).padStart(2, "0"),
                token,
              }))
            : token === rootToken
              ? [{ name: "downloads", token: downloadsToken }]
              : [{ name: "nested", token: childToken }],
        truncated: scenario === "truncated",
      };
      if (scenario === "wrong-request") result.requestId = "wrong-request";
      return reply(result);
    }
    if (suffix === "/confirm") {
      assert.equal(body.requestId, instance.requestId);
      assert.deepEqual(
        Object.keys(body).sort(),
        body.allowed ? ["allowed", "directoryToken", "requestId"] : ["allowed", "requestId"],
      );
      if (body.allowed) {
        assert.ok([rootToken, downloadsToken, childToken, ...tokens].includes(body.directoryToken));
        instance.selected = body.directoryToken;
      }
      instance.pending?.(
        body.allowed
          ? {
              handle: "owned-handle",
              path: "/owned/A/chosen",
              name: "chosen",
              bookmark: "owned-bookmark",
            }
          : { cancelled: true },
      );
      instance.pending = null;
      return reply({ accepted: true, allowed: body.allowed });
    }
  }
  throw Error("Unexpected owned request " + req.method() + " " + pathname);
});
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on("pageerror", (e) => errors.push(e.message));
const picker = () => page.getByRole("region", { name: "选择电脑上的目录" });
async function open(mode = "normal") {
  scenario = mode;
  await page.goto(origin + "/mobile/?view=panels");
  await page.getByRole("button", { name: "打开面板", exact: true }).click();
  await page.locator(".panel-host-loading").waitFor({ state: "hidden" });
  await page.frameLocator("iframe").locator("#pick").tap();
  if (mode === "revoked") return;
  await picker().waitFor();
  assert.equal(
    await page
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => window.hostConfirmCount),
    0,
  );
}
async function swipe(target) {
  const bounds = await target.boundingBox();
  assert.ok(bounds && bounds.height >= 60);
  const session = await context.newCDPSession(page),
    x = bounds.x + bounds.width / 2,
    start = bounds.y + bounds.height - 12,
    end = bounds.y + 12;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: start }],
  });
  for (let i = 1; i <= 12; i++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: start + ((end - start) * i) / 12 }],
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await open();
    const list = page.locator(".panel-directory-scroll");
    await list.getByRole("button").first().waitFor();
    await page.screenshot({
      path: path.join(output, `picker-${viewport.width}x${viewport.height}.png`),
    });
    console.log(JSON.stringify({ phase: "touch", viewport }));
    const before = await page.evaluate(() => ({
      body: document.documentElement.scrollTop,
      shell: document.querySelector(".shell").scrollTop,
      header: document.querySelector(".workbench-topbar").getBoundingClientRect().top,
    }));
    await swipe(list);
    const touchEvents = await page.evaluate(() => window.touchEvidence);
    assert.ok(
      ["touchstart", "touchmove", "touchend"].every((type) =>
        touchEvents.some((event) => event.type === type && event.trusted),
      ),
    );
    await page.waitForFunction(
      () => document.querySelector(".panel-directory-scroll").scrollTop > 20,
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        body: document.documentElement.scrollTop,
        shell: document.querySelector(".shell").scrollTop,
        header: document.querySelector(".workbench-topbar").getBoundingClientRect().top,
      })),
      before,
    );
    const minTouch = await picker()
      .locator("button")
      .evaluateAll((nodes) => Math.min(...nodes.map((n) => n.getBoundingClientRect().height)));
    assert.ok(minTouch >= 44);
    for (let i = 0; i < 55; i++) {
      if (await list.evaluate((n) => n.scrollTop + n.clientHeight >= n.scrollHeight - 2)) break;
      await swipe(list);
    }
    assert.ok(
      await list.evaluate((n) => n.scrollTop + n.clientHeight >= n.scrollHeight - 2),
      "finger scrolling reaches last directory",
    );
    await list.getByRole("button", { name: "最后一个电脑文件夹" }).tap();
    await picker().getByText("当前位置：downloads/nested", { exact: true }).waitFor();
    await picker().getByRole("button", { name: "返回上级", exact: true }).tap();
    await picker().getByText("当前位置：downloads", { exact: true }).waitFor();
    await picker().getByRole("button", { name: "项目根目录", exact: true }).tap();
    await picker().getByText("当前位置：项目根目录", { exact: true }).waitFor();
    await picker().getByRole("button", { name: "使用此目录", exact: true }).tap();
    await picker().waitFor({ state: "hidden" });
    assert.equal([...instances.values()].at(-1).selected, rootToken);
    reports.push({
      viewport,
      touchScroll: true,
      bodyAndShellStable: true,
      touchTargetMinimum: minTouch,
      selectedRoot: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open("root-default");
  await picker().getByText("当前位置：项目根目录", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await picker().waitFor({ state: "hidden" });
  assert.equal([...instances.values()].at(-1).selected, "original-directory");
  reports.push({ missingDownloadsDefaultsToExistingRoot: true, escapeCancelled: true });
  await open("retry");
  await picker().getByRole("button", { name: "重试读取" }).waitFor();
  scenario = "normal";
  await picker().getByRole("button", { name: "重试读取" }).click();
  await picker().getByText("当前位置：downloads", { exact: true }).waitFor();
  await picker().getByRole("button", { name: "取消", exact: true }).click();
  await picker().waitFor({ state: "hidden" });
  await open("truncated");
  await picker()
    .getByText(/仅显示前 200/)
    .waitFor();
  await picker().getByRole("button", { name: "取消", exact: true }).click();
  for (const mode of ["expired", "wrong-request"]) {
    await open(mode);
    await picker().getByRole("alert").waitFor();
    assert.equal(await picker().getByRole("button", { name: "使用此目录" }).isDisabled(), true);
    await picker().getByRole("button", { name: "取消", exact: true }).click();
    await picker().waitFor({ state: "hidden" });
  }
  reports.push({
    retry: true,
    truncationDisclosed: true,
    expiredAndWrongRequestCannotSelect: true,
  });
  await open();
  await picker().getByText("当前位置：downloads", { exact: true }).waitFor();
  await page.evaluate(() => history.back());
  await page.getByRole("dialog", { name: "还有未保存的修改" }).waitFor();
  await page.getByRole("button", { name: "留在此页", exact: true }).click();
  assert.equal(await picker().count(), 1);
  await page.getByRole("button", { name: "返回面板列表", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await picker().waitFor({ state: "hidden" });
  assert.equal([...instances.values()].at(-1).selected, "original-directory");
  assert.equal([...instances.values()].at(-1).closed, true);
  reports.push({
    browserBackStayPreservesChoice: true,
    explicitBackLeaveRevokesWithoutChoice: true,
  });
  await open("held");
  await page.waitForFunction(
    () => document.querySelector(".panel-directory-list")?.getAttribute("aria-busy") === "true",
  );
  assert.equal(
    typeof releaseList,
    "function",
    "owned list response is actually held before leaving",
  );
  const previous = [...instances.values()].at(-1);
  await page.evaluate(() => window.changeWorkspace());
  await picker().waitFor({ state: "hidden" });
  releaseList?.();
  assert.equal(previous.selected, "original-directory");
  await page.waitForFunction(() => !document.querySelector("iframe"));
  reports.push({ scopeChangeRetiresLateList: true });
  await open("revoked");
  await picker().waitFor({ state: "hidden" });
  await page.getByRole("alert").filter({ hasText: "Owned revoked" }).waitFor();
  assert.equal([...instances.values()].at(-1).selected, "original-directory");
  assert.deepEqual(await page.evaluate(() => window.sends), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.ok(
    !JSON.stringify(
      await page.evaluate(() => ({ url: location.href, state: history.state })),
    ).includes("/owned/"),
  );
  await page.screenshot({ path: path.join(output, "final.png"), fullPage: true });
  const receipt = {
    status: "passed",
    development,
    reports,
    errors,
    blocked,
    modelRequests: 0,
    output,
  };
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} catch (error) {
  const diagnostic = {
    error: String(error),
    development,
    scenario,
    errors,
    blocked,
    requests: requests.slice(-20),
    text: (await page.locator("body").innerText()).slice(-4000),
    output,
  };
  await writeFile(path.join(output, "failure.json"), JSON.stringify(diagnostic, null, 2));
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify(diagnostic));
  throw error;
} finally {
  releaseList?.();
  await context.close();
  await browser.close();
}
