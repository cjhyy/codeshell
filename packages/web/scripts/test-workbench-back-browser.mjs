/** Real Workbench/PanelHost navigation in an isolated browser. Owned HTTP fixtures only. */
/* global document, window, history, location, Event, innerWidth, requestAnimationFrame */
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
const development = process.argv.includes("--development");
const sourceArg = process.argv.indexOf("--source-repo");
const resolveDir =
  sourceArg < 0
    ? path.join(web, "app")
    : path.join(process.argv[sourceArg + 1], "packages/web/app");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-workbench-back-"));
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';
const noop=()=>{};window.sends=[];window.selections=[];
function Fixture(){const[draft,setDraft]=React.useState('Owned retained draft'),[workspace,setWorkspace]=React.useState('owned');window.changeWorkspace=()=>setWorkspace('other-owned');
const controller={host:'desktop',workspaceApi:true,connection:'open',activeId:'owned-session',chat:{items:Array.from({length:70},(_,i)=>({kind:'assistant',id:'row-'+i,text:'Owned conversation '+i+' '.repeat(1)+'retained reading position '.repeat(12),done:true})),run:'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:workspace,title:'Owned conversation',configuration:null,configurationVersion:0,sessionsVersion:0,draft,files:[],uploading:false,uploadBusy:false,hasUnsent:Boolean(draft),uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft,removeFile:noop,selectSession:id=>window.selections.push(id),newSession:noop,send:()=>{window.sends.push(draft);return false},stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:()=>{throw Error('Unexpected auth loss')}};return <Workbench controller={controller}/>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
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
const origin = "http://localhost:41735";
const panel = {
  id: "owned-panel",
  version: "1.0.0",
  title: { default: "Owned Panel" },
  entry: "app/index.html",
  icon: "panel",
  singleton: true,
  permissions: ["resources", "external.open"],
  revision: "a".repeat(64),
  bound: true,
  enabled: true,
  globalDisabled: false,
  updatable: false,
  source: { kind: "local", label: "Owned fixture" },
  compatibility: { supported: true, reasons: [] },
};
const assetId = "asset-" + "b".repeat(64);
const config = {
  workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
  defaults: {},
  connections: [],
  catalog: [],
  skills: [],
  mcpServers: [],
  restartRequired: false,
};
const errors = [],
  blocked = [],
  unexpected = [],
  reports = [],
  revoked = [];
let sequence = 0;
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
await context.route("**/*", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    pathname = url.pathname;
  const reply = (body, type = "application/json", status = 200) =>
    route.fulfill({
      status,
      contentType: type,
      body: type === "application/json" ? JSON.stringify(body) : body,
    });
  if (url.origin !== origin) {
    blocked.push(request.url());
    return route.abort();
  }
  if (pathname === "/outside") return reply("<h1>Outside owned application</h1>", "text/html");
  if (pathname === "/mobile/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      "text/html",
    );
  if (pathname === "/fixture.js") return reply(js, "text/javascript");
  if (pathname === "/fixture.css") return reply(css, "text/css");
  if (pathname === "/api/v1/environment")
    return reply({ error: "Unavailable owned environment" }, "application/json", 503);
  if (pathname === "/api/v1/configuration") return reply(config);
  if (pathname === "/api/v1/panels")
    return reply({ workspace: "/owned", hasProject: true, panels: [panel] });
  if (pathname === "/api/v1/files") {
    const folder = url.searchParams.get("path") ?? "";
    return reply({
      path: folder,
      files: folder
        ? [
            {
              name: "owned.txt",
              path: folder + "/owned.txt",
              kind: "file",
              size: 20,
              modifiedAt: 0,
            },
          ]
        : [{ name: "reports", path: "reports", kind: "directory", size: 0, modifiedAt: 0 }],
      truncated: false,
    });
  }
  if (pathname === "/api/v1/files/content")
    return reply({
      path: "reports/owned.txt",
      name: "owned.txt",
      kind: "text",
      size: 20,
      content: "Owned preview content",
    });
  if (pathname === "/api/v1/panels/runtime/prepare") {
    const instanceId = "owned-instance-" + String(++sequence).padStart(12, "0");
    return reply({
      instanceId,
      src: "/api/v1/panel-assets/" + instanceId + "/index.html",
      expiresAt: Date.now() + 600000,
      context: { host: "desktop", sessionId: "owned-session" },
      limitations: [],
    });
  }
  if (pathname.startsWith("/api/v1/panel-assets/")) {
    const id = pathname.split("/")[4];
    return reply(
      `<button id="preview">Open owned resource</button><button id="confirm">Request confirmation</button><script>
   const id=${JSON.stringify(id)};let n=0;const call=(method,params)=>parent.postMessage({type:'codeshell-panel:call',instanceId:id,requestId:'owned-'+(++n),method,params},'*');
   document.querySelector('#preview').onclick=()=>call('resources.open',{assetId:${JSON.stringify(assetId)}});
   document.querySelector('#confirm').onclick=()=>call('external.open',{url:'https://owned-external.invalid/'});
   parent.postMessage({type:'codeshell-panel:ready',instanceId:id},'*');
   </script>`,
      "text/html",
    );
  }
  if (pathname.endsWith("/events")) return reply({ cursor: 0, events: [] });
  if (pathname.endsWith("/call")) {
    const call = request.postDataJSON(),
      id = pathname.split("/")[5];
    if (call.method === "resources.open")
      return reply({
        effect: "resources.open",
        asset: { id: assetId, name: "Owned resource.txt", mimeType: "text/plain", bytes: 20 },
        url: "/api/v1/panels/runtime/" + id + "/resources/" + assetId,
      });
    if (call.method === "external.open")
      return reply({ effect: "external.open", url: "https://owned-external.invalid/" });
  }
  if (pathname.startsWith("/api/v1/panels/runtime/") && request.method() === "DELETE") {
    revoked.push(pathname);
    return reply({ closed: true });
  }
  unexpected.push(request.method() + " " + pathname);
  return reply({ error: "Unexpected owned request" }, "application/json", 404);
});
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (dialog) => dialog.accept());
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const nav = async (label) => {
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).count())
    await page.getByRole("button", { name: "展开侧栏", exact: true }).tap();
  await page.locator(".workbench-nav").getByRole("button", { name: label, exact: true }).tap();
};
const back = () => page.locator(".workbench-back");
const checkBack = async (label) => {
  await page
    .getByRole("button", { name: label, exact: true })
    .filter({ has: page.locator("span") })
    .first()
    .waitFor();
  const bounds = await back().evaluate((node) => {
    const b = node.getBoundingClientRect(),
      hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      hit: node === hit || node.contains(hit),
      right: b.right,
    };
  });
  assert.ok(
    bounds.width >= 44 && bounds.height >= 44 && bounds.x >= 0 && bounds.right <= 390 && bounds.hit,
    JSON.stringify(bounds),
  );
};
try {
  await page.goto(origin + "/outside");
  await page.goto(origin + "/mobile/");
  await page.locator(".composer textarea").waitFor();
  await page.locator(".messages").evaluate((node) => {
    node.scrollTop = 300;
    node.dispatchEvent(new Event("scroll"));
  });
  await frames();
  const scroll = await page.locator(".messages").evaluate((n) => n.scrollTop);
  await nav("设置");
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  await checkBack("返回对话");
  await page
    .locator(".hub-settings")
    .getByRole("button", { name: /模型与连接/ })
    .tap();
  await page.getByRole("heading", { name: "模型与连接", exact: true }).waitFor();
  await checkBack("返回设置");
  await page.evaluate(() => history.back());
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  await back().tap();
  await page.locator(".chat:not([hidden])").waitFor();
  assert.equal(await page.locator(".composer textarea").inputValue(), "Owned retained draft");
  assert.equal(await page.locator(".messages").evaluate((n) => n.scrollTop), scroll);
  await nav("文件");
  await page.getByRole("button", { name: /reports.*文件夹/ }).tap();
  await page.getByRole("button", { name: /owned.txt/ }).tap();
  await page.locator(".file-preview pre").waitFor();
  await checkBack("返回文件列表");
  assert.ok(
    !(await page.evaluate(() => JSON.stringify(history.state) + location.href)).includes(
      "owned.txt",
    ),
  );
  await page.evaluate(() => history.back());
  await page.locator(".file-preview").waitFor({ state: "hidden" });
  await checkBack("返回上级文件夹");
  await page.evaluate(() => history.forward());
  await page.locator(".file-preview pre").waitFor();
  await back().tap();
  await page.locator(".file-preview").waitFor({ state: "hidden" });
  await back().tap();
  await page.getByRole("button", { name: /reports.*文件夹/ }).waitFor();
  await back().tap();
  await page.locator(".chat:not([hidden])").waitFor();
  reports.push("settings and file layers; real Back/Forward; draft and reading position retained");
  await nav("面板");
  await page.locator(".panels-card").getByRole("button", { name: "打开面板", exact: true }).tap();
  await page.frameLocator("iframe").locator("#preview").tap();
  await page.locator(".panel-host-preview").waitFor();
  const persisted = await page.evaluate(() => JSON.stringify(history.state) + location.href);
  assert.ok(
    !persisted.includes("owned-instance") &&
      !persisted.includes("asset-") &&
      !persisted.includes("/resources/"),
    "History contains no Panel grant or resource URL",
  );
  await checkBack("返回面板");
  await page.frameLocator("iframe").locator("#confirm").tap();
  await page.locator(".panel-host-confirm").waitFor();
  await page.evaluate(() => history.back());
  await page.locator(".panel-host-preview").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".panel-host-confirm").count(), 1);
  assert.equal(await page.locator(".navigation-prompt").count(), 0);
  await page.evaluate(() => history.back());
  await page.locator(".navigation-prompt").waitFor();
  await page.getByRole("button", { name: "留在此页", exact: true }).tap();
  await frames();
  assert.equal(await page.locator(".panel-host-confirm").count(), 1);
  const before = revoked.length;
  await back().tap();
  await page.locator(".navigation-prompt").waitFor();
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).tap();
  await page.locator(".panels-grid").waitFor();
  await frames();
  assert.ok(revoked.length > before);
  await page.evaluate(() => history.forward());
  await page.frameLocator("iframe").locator("#preview").waitFor();
  assert.equal(await page.locator(".panel-host-preview").count(), 0);
  await back().tap();
  await page.locator(".panels-grid").waitFor();
  reports.push(
    "Panel preview preserves pending confirmation; guarded exit revokes instance; Forward creates fresh instance",
  );
  await page.getByRole("textbox", { name: "GitHub 仓库地址" }).fill("https://owned.invalid/source");
  await frames();
  await page.evaluate(() => history.back());
  await page.locator(".navigation-prompt").waitFor();
  await page.getByRole("button", { name: "留在此页", exact: true }).tap();
  await frames();
  assert.equal(
    await page.getByRole("textbox", { name: "GitHub 仓库地址" }).inputValue(),
    "https://owned.invalid/source",
  );
  await page.evaluate(() => history.back());
  await page.locator(".navigation-prompt").waitFor();
  await page.evaluate(() => window.changeWorkspace());
  await page.locator(".navigation-prompt").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("textbox", { name: "GitHub 仓库地址" }).inputValue(), "");
  await page.evaluate(() => history.back());
  await frames();
  assert.equal(await page.locator(".panels-grid").count(), 1);
  assert.equal(await page.locator(".navigation-prompt").count(), 0);
  reports.push(
    "dirty Back restores known entry; Stay preserves form; workspace retires pending intent and old scope",
  );
  // Fresh direct links get a visible parent but no artificial Back loop.
  await page.goto(origin + "/outside");
  await page.goto(origin + "/mobile/?view=panels");
  await page.locator(".panels-grid").waitFor();
  const length = await page.evaluate(() => history.length);
  await checkBack("返回对话");
  await back().tap();
  await page.locator(".chat:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => history.length), length);
  await page.goBack();
  assert.equal(new URL(page.url()).pathname, "/outside");
  reports.push("direct link parent replaces once; next browser Back leaves application");
  await page.goto(origin + "/mobile/?view=settings&section=models");
  await page.getByRole("heading", { name: "模型与连接", exact: true }).waitFor();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const b = await back().boundingBox();
    assert.ok(b.height >= 44 && b.x >= 0 && b.x + b.width <= width);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, `back-${width}.png`) });
  }
  assert.deepEqual(await page.evaluate(() => window.sends), []);
  assert.deepEqual(await page.evaluate(() => window.selections), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(
      { development, reports, revoked: revoked.length, errors, blocked, unexpected },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, output, reports, revoked: revoked.length }));
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  await writeFile(
    path.join(output, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        url: page.url(),
        errors,
        blocked,
        unexpected,
        body: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  console.error("Back navigation evidence:", output);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
