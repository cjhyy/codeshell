/** Real Workbench/PanelHost navigation in an isolated browser. Owned HTTP fixtures only. */
/* global document, window, history, location, requestAnimationFrame */
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
const output = await mkdtemp(path.join(tmpdir(), "codeshell-project-back-"));
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{ProjectsGate}from'./ProjectsGate';import{App}from'./App';
window.sends=[];window.selections=[];window.rpc=[];
class OwnedSocket {static OPEN=1;readyState=0;constructor(url){this.url=url;this.timer=setTimeout(()=>{if(this.readyState===3)return;this.readyState=1;this.onopen?.()},0)}close(){clearTimeout(this.timer);this.readyState=3;this.onclose?.({code:1000})}send(raw){const m=JSON.parse(raw);window.rpc.push({url:this.url,method:m.method});if(m.method!=='agent/query'&&m.method!=='serve/approval.snapshot')throw Error('Unexpected non-read RPC '+m.method);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='serve/approval.snapshot'?{approvals:[],leases:[]}:{type:'sessions',data:[]}})}))}};
window.WebSocket=OwnedSocket;const lost=()=>{throw Error('Unexpected auth loss')};
createRoot(document.getElementById('root')).render(<React.StrictMode><ProjectsGate allowLegacy={false} onAuthLost={lost}>{(project,onBack)=><App hub onAuthLost={lost} projectName={project?.name} onBackToProjects={onBack}/>}</ProjectsGate></React.StrictMode>);`;

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
const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scopedRequests = [];
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
await context.addInitScript(() => {
  Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
});
await context.route("**/*", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    scope = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname),
    pathname = scope ? scope[2] : url.pathname;
  if (scope) scopedRequests.push({ project: scope[1], path: pathname });
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
  if (pathname === "/mobile/" || pathname === "/hub/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      "text/html",
    );
  if (pathname === "/fixture.js") return reply(js, "text/javascript");
  if (pathname === "/fixture.css") return reply(css, "text/css");
  if (pathname === "/api/v1/environment")
    return reply({ error: "Unavailable owned environment" }, "application/json", 503);
  if (pathname === "/api/v1/projects")
    return reply({
      runtime: "docker",
      available: true,
      projects: [projectA, projectB].map((id, index) => ({
        id,
        name: index ? "Owned project B" : "Owned project A",
        status: "running",
        generation: 1,
        createdAt: 1,
      })),
    });
  if (pathname === "/api/v1/sessions") return reply({ sessions: [] });
  if (pathname === "/api/v1/configuration")
    return reply({
      ...config,
      workspace: { ...config.workspace, path: scope?.[1] === projectB ? "/owned/B" : "/owned/A" },
    });
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
      `<button id="preview">Open owned resource</button><button id="confirm">Request confirmation</button><a id="anchor-a" href="#a">Owned child A</a><a id="anchor-b" href="#b">Owned child B</a><script>
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

try {
  await page.goto(origin + "/outside");
  await page.goto(origin + "/hub/");
  const card = (name) =>
    page.locator(".project-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await card("Owned project A").getByRole("button", { name: "打开项目", exact: true }).tap();
  await page.locator(".chat:not([hidden])").waitFor();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
  const sessionA = new URL(page.url()).searchParams.get("session");
  const initialLength = await page.evaluate(() => history.length);
  await nav("设置");
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  await nav("文件");
  await page.locator(".hub-files").waitFor();
  const oldEntries = (await page.evaluate(() => history.length)) - initialLength;
  await nav("返回项目列表");
  await card("Owned project B").waitFor();
  await card("Owned project B").getByRole("button", { name: "打开项目", exact: true }).tap();
  await page.locator(".hub-files").waitFor();
  await page.waitForFunction(
    (a) => new URL(location.href).searchParams.get("session") !== a,
    sessionA,
  );
  const sessionB = new URL(page.url()).searchParams.get("session");
  assert.equal(new URL(page.url()).searchParams.get("project"), projectB);
  assert.ok(scopedRequests.some((r) => r.project === projectB && r.path === "/api/v1/files"));
  if (sourceArg < 0)
    assert.equal(oldEntries, 2, "Current source must exercise real app history in CI");
  if (oldEntries === 0) {
    reports.push(
      "Baseline creates no inner-page history, so this cross-project Back path did not exist",
    );
  } else {
    await nav("面板");
    await page.locator(".panels-card").getByRole("button", { name: "打开面板", exact: true }).tap();
    await page.frameLocator("iframe").locator("#confirm").tap();
    await page.locator(".panel-host-confirm").waitFor();
    const before = revoked.length,
      requestStart = scopedRequests.length;
    // These three real app entries lead to A's Settings, across ProjectsGate's unmount/remount.
    await page.evaluate(() => history.go(-3));
    await frames();
    await frames();
    assert.equal(
      new URL(page.url()).searchParams.get("project"),
      projectB,
      "Old history must not overwrite the active ProjectsGate project URL",
    );
    assert.equal(
      new URL(page.url()).searchParams.get("session"),
      sessionB,
      "Old history must not overwrite the current controller session",
    );
    assert.equal(
      await page.locator(".panel-host-confirm").count(),
      1,
      "Old-owner Back cannot silently cancel B's pending confirmation",
    );
    await page.locator(".navigation-prompt").waitFor();
    await page.getByRole("button", { name: "留在此页", exact: true }).tap();
    assert.equal(revoked.length, before);
    assert.equal(await page.locator(".panel-host-confirm").count(), 1);
    assert.ok(
      scopedRequests.slice(requestStart).every((r) => r.project === projectB),
      "No retired-project API reads or writes",
    );
    await back().tap();
    await page.locator(".navigation-prompt").waitFor();
    await page.getByRole("button", { name: "放弃修改并离开", exact: true }).tap();
    await page.locator(".panels-grid").waitFor();
    await page.reload();
    await page.locator(".panels-grid").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), projectB);
    assert.equal(new URL(page.url()).searchParams.get("session"), sessionB);
    assert.equal(await page.locator(".topbar-project").innerText(), "Owned project B");
    reports.push(
      "real ProjectsGate A→list→B: old owner Back keeps B URL, session, APIs and pending Panel; reload stays B",
    );
    // Same workspace: New conversation changes the real useHubController activeId.
    await nav("设置");
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
    await nav("新对话");
    await page.locator(".chat:not([hidden])").waitFor();
    const sessionC = new URL(page.url()).searchParams.get("session");
    assert.notEqual(sessionC, sessionB);
    await page.evaluate(() => history.back());
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get("session"),
      sessionC,
      "View Back must not restore the previous conversation URL",
    );
    reports.push("same-project view Back retains the latest actual controller session");
    // The real remount normalization creates two native entries with the same
    // opaque marker. New conversation on Chat uses replaceState, not a new view.
    await page.goto(origin + "/hub/");
    await card("Owned project A").getByRole("button", { name: "打开项目", exact: true }).tap();
    await page.locator(".chat:not([hidden])").waitFor();
    await nav("设置");
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
    await nav("文件");
    await page.locator(".hub-files").waitFor();
    await nav("返回项目列表");
    await card("Owned project B").getByRole("button", { name: "打开项目", exact: true }).tap();
    await page.locator(".hub-files").waitFor();
    await page.waitForFunction(
      () => document.querySelector(".workspace-button")?.getAttribute("title") === "/owned/B",
    );
    const aliasMarker = await page.evaluate(() => history.state.codeshellWorkbench);
    await page.evaluate(() => history.back());
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => history.state.codeshellWorkbench), aliasMarker);
    await back().tap();
    await page.locator(".chat:not([hidden])").waitFor();
    const oldSession = new URL(page.url()).searchParams.get("session"),
      aliasLength = await page.evaluate(() => history.length);
    await nav("新对话");
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get("session") !== id,
      oldSession,
    );
    const newestSession = new URL(page.url()).searchParams.get("session");
    assert.equal(await page.evaluate(() => history.length), aliasLength);
    await page.evaluate(() => history.forward());
    await frames();
    await frames();
    assert.deepEqual(await page.evaluate(() => history.state.codeshellWorkbench), aliasMarker);
    assert.equal(
      new URL(page.url()).searchParams.get("session"),
      newestSession,
      "Same-index traversal also normalizes the real active session",
    );
    assert.equal(new URL(page.url()).searchParams.get("project"), projectB);
    assert.equal(
      await page.locator(".chat:not([hidden])").count(),
      1,
      "Same-index child history cannot navigate the parent view",
    );
    reports.push(
      "real remount alias plus New conversation keeps the current session on same-index Forward",
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify({ development, oldEntries, reports, errors, blocked, unexpected }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, output, reports, oldEntries }));
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
  console.error("Project navigation evidence:", output);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
