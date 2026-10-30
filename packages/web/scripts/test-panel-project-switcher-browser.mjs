/** Actual Desktop controller/Workbench/PanelHost with isolated, owned project APIs. */
/* global window, document, requestAnimationFrame */
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
const output = await mkdtemp(path.join(tmpdir(), "codeshell-panel-projects-"));
const development = process.argv.includes("--development");
const sourceArg = process.argv.indexOf("--source-repo");
const resolveDir =
  sourceArg < 0
    ? path.join(web, "app")
    : path.join(process.argv[sourceArg + 1], "packages/web/app");
const projects = [
  { id: "project-a", path: "/owned/A", name: "甲项目已有下载与面板资料".repeat(6) },
  {
    id: "project-b",
    path: "/owned/B",
    name: "Project B with retained downloads and a deliberately long name ".repeat(4),
  },
  { id: "project-c", path: "/owned/C", name: "Project C" },
];
const source = `import React from 'react';import{createRoot}from'react-dom/client';
import{Workbench}from'./Workbench';import{useDesktopController}from'./DesktopApp';import{initialChatState}from'../src/lib/streamReducer';
const projects=${JSON.stringify(projects)},noop=()=>{},session={id:'owned-login',username:'Fixture',deviceName:'Owned'};
window.selected=[];window.created=[];window.sent=[];window.stopped=[];window.creationMode='auto';
function Fixture(){const[state,setState]=React.useState({status:'online',activeSessionId:'session-a',activeCwd:'/owned/A',activeProjectId:'project-a',activeProjectCwd:'/owned/A',sessionCreationFailures:0});
const generation=React.useRef(0);window.setConnection=status=>setState(s=>({...s,status}));
const app={...state,projects,chat:initialChatState(),sessions:[],approvals:[],conversationRevision:0,permissionMode:'default',unreadSessionIds:new Set(),loading:{sessions:false,sessionHistory:false,rooms:false,projects:false,roomHistory:false,ccSessions:false},ccSessions:[],ccProbe:null,ccCliKind:'claude-code',logout:noop,refreshSessions:noop,respondApproval:noop,setPermissionMode:noop,extendGoal:noop,clearGoal:noop,leaveRoom:noop,setCcCliKind:noop,openCcSession:noop,respondCcApproval:noop,selectSession:noop,
sendChat:async input=>{window.sent.push(input);return true},stopRun:()=>window.stopped.push('run.stop'),
selectProject:id=>{window.selected.push(id);const p=projects.find(p=>p.id===id);setState(s=>({...s,activeProjectId:id,activeProjectCwd:p.path}))},
newSession:target=>{window.created.push(target);const current=++generation.current,p=projects.find(p=>p.id===target.projectId);window.acceptCreation=()=>{if(current===generation.current)setState(s=>({...s,activeSessionId:'session-'+p.id+'-'+current,activeCwd:p.path}))};
if(window.creationMode==='fail')setState(s=>({...s,sessionCreationFailures:s.sessionCreationFailures+1}));else if(window.creationMode==='auto')queueMicrotask(window.acceptCreation)}};
const controller=useDesktopController(app,session,()=>{throw Error('Unexpected auth loss')});window.currentScope=()=>({workspace:controller.workspaceKey,panelSessionId:controller.panelSessionId,selected:controller.selectedProjectId});return <Workbench controller={controller}/>};
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir, loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const origin = "http://panel-projects-owned.test";
const requests = [],
  blocked = [],
  errors = [],
  reports = [],
  instances = new Map(),
  holds = new Map();
const bindings = Object.fromEntries(
  projects.map((project, index) => [
    project.path,
    {
      id: "owned-panel",
      title: { default: "Existing binding " + "ABC"[index] },
      version: String(index + 1),
      entry: "app/index.html",
      icon: "panel",
      singleton: true,
      permissions: ["context.workspace", "context.session", "storage", "process"],
      revision: "abc"[index].repeat(64),
      bound: true,
      enabled: true,
      globalDisabled: false,
      updatable: false,
      source: { kind: "local", label: "Existing package " + "ABC"[index] },
      compatibility: { supported: true, reasons: [] },
    },
  ]),
);
const initialBindings = JSON.stringify(bindings);
const backgroundTask = { id: "owned-background-A", status: "running" };
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
async function handleRoute(route) {
  const request = route.request(),
    url = new URL(request.url()),
    pathname = url.pathname,
    workspace =
      url.searchParams.get("workspace") ??
      (request.headers()["x-codeshell-workspace"]
        ? decodeURIComponent(request.headers()["x-codeshell-workspace"])
        : null);
  const body = request.method() === "POST" ? request.postDataJSON() : undefined;
  requests.push({ method: request.method(), pathname, workspace, body });
  const reply = (value, status = 200, contentType = "application/json") =>
    route.fulfill({
      status,
      contentType,
      body: contentType === "application/json" ? JSON.stringify(value) : value,
    });
  if (url.origin !== origin) {
    blocked.push(request.url());
    return route.abort();
  }
  if (pathname === "/mobile/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      200,
      "text/html",
    );
  if (pathname === "/fixture.js") return reply(js, 200, "text/javascript");
  if (pathname === "/fixture.css") return reply(css, 200, "text/css");
  if (pathname === "/api/v1/environment") return reply({}, 404);
  if (pathname === "/api/v1/configuration" || pathname === "/api/v1/panels") {
    assert.equal(request.method(), "GET");
    assert.ok(
      bindings[workspace],
      `Only advertised owned roots are readable: ${pathname} / ${workspace}`,
    );
    const hold = holds.get(workspace);
    if (hold) await hold.promise;
    if (pathname.endsWith("configuration"))
      return reply({
        workspace: { path: workspace, settingsScope: "local", skillDirectories: [] },
        defaults: {},
        connections: [],
        catalog: [],
        skills: [],
        mcpServers: [],
        restartRequired: false,
      });
    return reply({ workspace, hasProject: true, panels: [bindings[workspace]] });
  }
  if (pathname === "/api/v1/panels/runtime/prepare") {
    assert.equal(body.appId, bindings[workspace].id);
    assert.equal(
      body.revision,
      bindings[workspace].revision,
      "No Panel revision crosses project boundaries",
    );
    if (body.sessionId)
      assert.ok(
        (body.sessionId === "session-a" && workspace === "/owned/A") ||
          body.sessionId.startsWith("session-project-" + workspace.slice(-1).toLowerCase() + "-"),
        "No prior project's session is bound",
      );
    const id = "owned-instance-" + String(instances.size + 1).padStart(12, "0");
    instances.set(id, {
      workspace,
      sessionId: body.sessionId,
      closed: false,
      confirmation: false,
      pending: null,
    });
    return reply({
      instanceId: id,
      src: "/api/v1/panel-assets/" + id + "/index.html",
      expiresAt: Date.now() + 600000,
      context: { host: "desktop", sessionId: body.sessionId },
      limitations: [],
    });
  }
  if (pathname.startsWith("/api/v1/panel-assets/")) {
    const id = pathname.split("/")[4];
    assert.equal(instances.get(id).workspace, workspace);
    return reply(
      `<p id="records">Loading existing records</p><button id="confirm">Request confirmation</button><script>
      const id=${JSON.stringify(id)};let n=0;const call=(method,params)=>parent.postMessage({type:'codeshell-panel:call',instanceId:id,requestId:'owned-'+(++n),method,params},'*');
      addEventListener('message',e=>{if(e.data?.type==='codeshell-panel:response'&&e.data.result?.records)document.querySelector('#records').textContent=e.data.result.records.join(',')});
      document.querySelector('#confirm').onclick=()=>call('process.run',{command:'owned-fixture-no-execution'});
      parent.postMessage({type:'codeshell-panel:ready',instanceId:id},'*');call('storage.get',{key:'records'});
      </script>`,
      200,
      "text/html",
    );
  }
  const id = pathname.split("/")[5],
    instance = instances.get(id);
  if (instance) {
    assert.equal(
      workspace,
      instance.workspace,
      "Grant cleanup and calls retain their original scope",
    );
    if (request.method() === "DELETE") {
      instance.closed = true;
      if (instance.pending) {
        const finish = instance.pending;
        instance.pending = null;
        await finish();
      }
      return reply({ closed: true });
    }
    if (pathname.endsWith("/events")) {
      const after = Number(url.searchParams.get("after"));
      return reply({
        cursor: instance.confirmation ? 1 : after,
        events:
          instance.confirmation && after === 0
            ? [
                {
                  id: 1,
                  event: "host.confirm",
                  payload: {
                    requestId: "confirmation-" + id,
                    title: "Owned pending process confirmation",
                    body: "No command runs in this fixture",
                  },
                },
              ]
            : [],
      });
    }
    if (pathname.endsWith("/call") && body.method === "storage.get")
      return reply({
        records: ["Saved record " + workspace.slice(-1)],
        background: backgroundTask.status,
      });
    if (pathname.endsWith("/call") && body.method === "process.run") {
      instance.confirmation = true;
      return new Promise((resolve) => {
        instance.pending = async () => {
          await reply({ error: "Grant closed" }, 410).catch(() => {});
          resolve();
        };
      });
    }
  }
  blocked.push(request.method() + " " + pathname);
  return reply({ error: "Unexpected fixture request" }, 404);
}
await context.route("**/*", (route) =>
  handleRoute(route).catch(async (cause) => {
    errors.push(cause.message);
    await route
      .fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Owned fixture rejected the request" }),
      })
      .catch(() => {});
  }),
);
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on("pageerror", (error) => errors.push(error.message));
const picker = page.getByRole("combobox", { name: "切换面板项目", exact: true });
const frame = page.frameLocator("iframe.panel-host-frame");
const currentInstance = async () =>
  new URL(await page.locator("iframe.panel-host-frame").getAttribute("src"), origin).pathname.split(
    "/",
  )[4];
async function list(letter) {
  await page
    .locator(".panels-card")
    .getByRole("heading", { name: "Existing binding " + letter, exact: true })
    .waitFor();
  assert.equal(await picker.inputValue(), "project-" + letter.toLowerCase());
  assert.equal(await page.locator(".panel-host-frame").count(), 0);
}
async function open(letter) {
  await page.locator(".panels-card").getByRole("button", { name: "打开面板", exact: true }).tap();
  await frame
    .locator("#records")
    .getByText("Saved record " + letter, { exact: true })
    .waitFor();
  return currentInstance();
}
try {
  await page.goto(origin + "/mobile/?view=panels");
  await list("A");
  await picker.selectOption("project-a");
  assert.deepEqual(await page.evaluate(() => window.selected), []);
  await picker.selectOption("project-b");
  await list("B");
  const b = await open("B");
  await picker.selectOption("project-a");
  await list("A");
  assert.equal(instances.get(b).closed, true);
  reports.push(
    "A/B list and open-Panel switching reads each original binding and saved records; same selection is a no-op",
  );

  const a = await open("A");
  await frame.locator("#confirm").tap();
  await page.getByText("Owned pending process confirmation", { exact: true }).waitFor();
  const before = await page.evaluate(() => window.selected.length);
  await picker.selectOption("project-b");
  await page.getByRole("dialog", { name: "还有未保存的修改" }).waitFor();
  assert.equal(await page.evaluate(() => window.selected.length), before);
  assert.equal(instances.get(a).closed, false);
  await page.getByRole("button", { name: "留在此页", exact: true }).tap();
  assert.equal(await currentInstance(), a);
  assert.equal(await picker.inputValue(), "project-a");
  await page.getByText("Owned pending process confirmation", { exact: true }).waitFor();
  await picker.selectOption("project-b");
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).tap();
  await list("B");
  assert.equal(instances.get(a).closed, true);
  assert.equal(backgroundTask.status, "running");
  reports.push(
    "pending confirmation stays under Stay; approved navigation revokes only the original grant and sends no background cancellation",
  );

  await page
    .getByRole("textbox", { name: "GitHub 仓库地址" })
    .fill("https://github.com/owned/unsaved");
  await picker.selectOption("project-a");
  await page.getByRole("button", { name: "留在此页", exact: true }).tap();
  assert.equal(
    await page.getByRole("textbox", { name: "GitHub 仓库地址" }).inputValue(),
    "https://github.com/owned/unsaved",
  );
  await picker.selectOption("project-a");
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).tap();
  await list("A");
  assert.equal(await page.getByRole("textbox", { name: "GitHub 仓库地址" }).inputValue(), "");
  reports.push(
    "Panel-list dirty form uses the existing Stay/Leave guard without rebinding packages",
  );

  let release;
  const heldC = {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
  holds.set("/owned/C", heldC);
  const cRead = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/v1/panels" && url.searchParams.get("workspace") === "/owned/C";
  });
  await picker.selectOption("project-c");
  await page.waitForFunction(() => window.currentScope().workspace === "/owned/C");
  await cRead;
  await picker.selectOption("project-b");
  await list("B");
  holds.delete("/owned/C");
  release();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await list("B");
  assert.equal(await page.evaluate(() => window.currentScope().workspace), "/owned/B");
  reports.push("rapid C-to-B selection rejects late C configuration and binding responses");

  await page.evaluate(() => {
    window.creationMode = "hold";
  });
  await picker.selectOption("project-a");
  await list("A");
  const pending = await open("A");
  assert.equal(instances.get(pending).sessionId, undefined);
  await page.evaluate(() => window.acceptCreation());
  await page.waitForFunction(() => !!window.currentScope().panelSessionId);
  await frame.locator("#records").getByText("Saved record A", { exact: true }).waitFor();
  await page.waitForFunction(
    (old) => !document.querySelector("iframe.panel-host-frame")?.getAttribute("src")?.includes(old),
    pending,
  );
  assert.ok(instances.get(await currentInstance()).sessionId.startsWith("session-project-a-"));
  await page.evaluate(() => {
    window.creationMode = "fail";
  });
  await picker.selectOption("project-b");
  await list("B");
  const failed = await open("B");
  assert.equal(instances.get(failed).sessionId, undefined);
  assert.equal(await page.evaluate(() => window.currentScope().panelSessionId), undefined);
  reports.push(
    "new-session pending and failure omit the old project's SID; a correlated successful ID restores the current binding without a send",
  );

  await page.evaluate(() => {
    window.creationMode = "auto";
  });
  await picker.selectOption("project-a");
  await list("A");
  await open("A");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [390, 844],
      [320, 568],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      const metrics = await page.evaluate(() => {
        const bounds = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        return {
          body: document.documentElement.scrollWidth,
          select: bounds(".panel-project-switcher select"),
          label: bounds(".panel-project-switcher"),
          back: bounds(".workbench-back"),
          status: bounds(".connection-pill"),
        };
      });
      assert.ok(metrics.body <= width + 1);
      assert.ok(metrics.select.height >= 44 && metrics.select.width >= 44);
      assert.ok(
        metrics.label.height >= 44 && metrics.select.x >= 0 && metrics.select.right <= width,
      );
      for (const rect of [metrics.back, metrics.status])
        assert.ok(
          rect.width > 0 && rect.x >= 0 && rect.right <= width && rect.bottom <= metrics.label.y,
        );
      await page.screenshot({ path: path.join(output, `${theme}-${width}x${height}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.setConnection("offline"));
  assert.equal(await picker.isDisabled(), true);
  await page.evaluate(() => window.setConnection("online"));
  await page.getByRole("button", { name: "展开侧栏", exact: true }).tap();
  assert.equal(
    await page.getByRole("combobox", { name: "选择项目", exact: true }).inputValue(),
    "project-a",
  );
  await page.getByRole("combobox", { name: "选择项目", exact: true }).selectOption("project-b");
  await page
    .getByRole("dialog", { name: "工作台导航" })
    .getByRole("button", { name: "收起侧栏", exact: true })
    .tap();
  await list("B");
  reports.push(
    "44px native selector and long bilingual names retain Back/status at 320/390/landscape in both themes; original sidebar remains usable",
  );
  assert.deepEqual(await page.evaluate(() => window.sent), []);
  assert.deepEqual(await page.evaluate(() => window.stopped), []);
  assert.equal(JSON.stringify(bindings), initialBindings);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(
      {
        ok: true,
        development,
        transport: "owned HTTP fixtures; production Desktop controller, Workbench and PanelHost",
        physicalPhoneTested: false,
        reports,
        requests,
        modelSends: 0,
        cancellationRequests: 0,
        bindingsUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, development, output, reports }));
} catch (cause) {
  console.error(
    JSON.stringify({
      error: cause.message,
      errors,
      blocked,
      requests: requests.slice(-20),
      reports,
    }),
  );
  throw cause;
} finally {
  for (const hold of holds.values()) hold.release();
  for (const instance of instances.values()) if (instance.pending) await instance.pending();
  await context.close();
  await browser.close();
}
