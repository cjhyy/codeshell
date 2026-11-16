/** Real Desktop controller and Workbench against owned, delayed catalog/history fixtures.
 * Run with scripts/run-isolated-node-smoke.mjs. No user profile or real remote is accessed.
 * Optional: --source-repo <checkout> --output-dir <screenshots-and-report-directory>.
 * The paired protocol's response fences are tested separately in useRemoteApp tests;
 * this browser test verifies the catalog, active workspace and visible navigation together.
 */
/* global window, document, requestAnimationFrame */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownWeb = fileURLToPath(new URL("..", import.meta.url));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  return path.resolve(process.argv[index + 1]);
};
const sourceRepo = argument("--source-repo") ?? path.resolve(ownWeb, "../..");
const sourceWeb = path.join(sourceRepo, "packages/web");
const require = createRequire(path.join(sourceRepo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output =
  argument("--output-dir") ?? (await mkdtemp(path.join(tmpdir(), "codeshell-remote-navigation-")));
await mkdir(output, { recursive: true });

const projects = Array.from({ length: 12 }, (_, index) => {
  const letter = String.fromCharCode(65 + index);
  return {
    id: `project-${letter}`,
    path: `/owned/${letter}`,
    name: index === 0 ? "项目甲 · 远程目录与较长项目名称的显示检查" : `项目 ${letter}`,
    pathCaseSensitive: true,
    primaryRootId: `${letter}-root`,
    roots: [
      { id: `${letter}-root`, name: "主目录", path: `/owned/${letter}`, role: "primary" },
      ...(index === 0
        ? [{ id: "A-extra", name: "附加目录", path: "/owned/A-extra", role: "attached" }]
        : []),
    ],
  };
});
const rows = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `a-${index + 1}`,
    title: `甲会话 ${index + 1} · 已有内容`,
    cwd: index === 11 ? "/owned/A-extra" : "/owned/A",
    updatedAt: 1000 - index,
  })),
  ...projects.slice(1).map((project, index) => ({
    id: `${String.fromCharCode(98 + index)}-1`,
    title: `${project.name} 已有会话`,
    cwd: project.path,
    updatedAt: 800 - index,
  })),
  { id: "unbound-existing", title: "已有无项目对话", cwd: "", updatedAt: 100 },
];
const extraRows = [{ id: "b-older", title: "项目 B 更早的会话", cwd: "/owned/B", updatedAt: 50 }];

const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Workbench} from './Workbench';
import {useDesktopController} from './DesktopApp';
import {getApiWorkspace} from './api-context';
import {initialChatState,reduceStream} from '../src/lib/streamReducer';
const projects=${JSON.stringify(projects)},initialRows=${JSON.stringify(rows)},extraRows=${JSON.stringify(extraRows)};
const noop=()=>{},login={id:'owned-session',username:'Owned fixture',deviceName:'Owned browser'};
window.fixture={creates:[],selections:[],projectSelections:[],refreshes:[],loadMoreCalls:0,sends:[]};
window.WebSocket=class {constructor(){throw Error('No socket is permitted in the controlled adapter fixture')}};
function Fixture(){
  const [state,setState]=React.useState({status:'online',sessions:initialRows,sessionsHasMore:true,
    activeSessionId:undefined,activeCwd:null,activeProjectId:null,activeProjectCwd:null,
    historyLoading:false,catalogLoading:false,sessionCreationFailures:0,chat:initialChatState()});
  const historyGeneration=React.useRef(0),current=React.useRef(state);current.current=state;
  window.fixture.releaseHistory=()=>setState(s=>({...s,historyLoading:false,
    chat:reduceStream(initialChatState(),{type:'session_user_message',text:'已读取 '+s.activeSessionId+' 的原有内容',clientMessageId:'owned-history-'+s.activeSessionId})}));
  window.fixture.releaseAppend=()=>setState(s=>({...s,catalogLoading:false,sessionsHasMore:false,
    sessions:[...s.sessions,...extraRows.filter(row=>!s.sessions.some(old=>old.id===row.id))]}));
  window.fixture.refreshCatalog=()=>setState(s=>({...s,catalogLoading:true}));
  window.fixture.finishRefresh=()=>setState(s=>({...s,catalogLoading:false}));
  const app={...state,projects,conversationRevision:historyGeneration.current,permissionMode:'default',
    approvals:[],unreadSessionIds:new Set(),loading:{sessions:state.catalogLoading,sessionHistory:state.historyLoading,
      rooms:false,projects:false,roomHistory:false,ccSessions:false},ccSessions:[],ccProbe:null,ccCliKind:'claude-code',
    logout:noop,respondApproval:noop,setPermissionMode:noop,extendGoal:noop,clearGoal:noop,leaveRoom:noop,
    setCcCliKind:noop,openCcSession:noop,respondCcApproval:noop,stopRun:noop,outputHistoryFailed:false,
    refreshSessions:cwds=>window.fixture.refreshes.push(cwds??null),
    loadMoreSessions:()=>{window.fixture.loadMoreCalls++;setState(s=>({...s,catalogLoading:true}))},
    selectProject:id=>{window.fixture.projectSelections.push(id);const p=projects.find(p=>p.id===id||p.path===id);
      setState(s=>({...s,activeProjectId:p?.id??null,activeProjectCwd:p?.path??id}))},
    selectSession:id=>{window.fixture.selections.push(id);const row=current.current.sessions.find(row=>row.id===id);
      if(!row)throw Error('Unknown owned session');historyGeneration.current++;
      setState(s=>({...s,activeSessionId:id,activeCwd:row.cwd||null,historyLoading:true,chat:initialChatState()}))},
    newSession:target=>{window.fixture.creates.push(target);historyGeneration.current++;
      const p=typeof target==='object'&&target?.projectId?projects.find(p=>p.id===target.projectId):undefined;
      const cwd=target===null||target?.projectId===null?null:p?.path??target??null;
      setState(s=>({...s,activeSessionId:'owned-new-'+historyGeneration.current,activeCwd:cwd,
        activeProjectId:p?.id??null,activeProjectCwd:p?.path??null,historyLoading:false,chat:initialChatState()}))},
    sendChat:async message=>{window.fixture.sends.push(message);throw Error('This read-only fixture must never send a chat')},
  };
  const controller=useDesktopController(app,login,()=>{throw Error('Unexpected fixture auth loss')});
  window.fixture.current=()=>({activeId:controller.activeId,workspaceCwd:controller.workspaceCwd,
    apiWorkspace:getApiWorkspace()??null,configurationPath:controller.configuration?.workspace.path??null,
    scopedIds:controller.sessions.map(row=>row.sessionId),
    navigationIds:controller.navigationSessions?.map(row=>row.sessionId),loading:controller.loading});
  window.fixture.associate=async id=>{try{await controller.selectPanelSession(id);return 'accepted'}catch(error){return error.message}};
  return <Workbench controller={controller}/>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(sourceWeb, "app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: path.join(output, "bundle"),
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const report = {
  scope: "Owned Desktop controller/Workbench browser fixture",
  checks: [],
  requests: [],
  errors: [],
  blocked: [],
};
const configHolds = [];
let holdProjectA = false;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const workspace = request.headers["x-codeshell-workspace"]
    ? decodeURIComponent(request.headers["x-codeshell-workspace"])
    : (url.searchParams.get("workspace") ?? null);
  report.requests.push({ method: request.method, path: url.pathname, workspace });
  const reply = (body, status = 200, contentType = "application/json") => {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
    response.end(contentType === "application/json" ? JSON.stringify(body) : body);
  };
  if (request.method !== "GET") {
    report.blocked.push(`${request.method} ${url.pathname}`);
    return reply({}, 405);
  }
  if (url.pathname === "/mobile/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      200,
      "text/html",
    );
  if (url.pathname === "/fixture.js") return reply(js, 200, "text/javascript");
  if (url.pathname === "/fixture.css") return reply(css, 200, "text/css");
  if (url.pathname === "/favicon.ico") return reply("", 204, "text/plain");
  if (url.pathname === "/api/v1/environment")
    return reply({ error: "Owned environment unavailable" }, 404);
  if (url.pathname === "/api/v1/configuration") {
    const value = {
      workspace: {
        path: workspace ?? "/owned/no-project-runtime",
        settingsScope: "local",
        skillDirectories: [],
      },
      defaults: {},
      connections: [],
      catalog: [],
      skills: [],
      mcpServers: [],
      restartRequired: false,
    };
    if (workspace === "/owned/A" && holdProjectA) configHolds.push(() => reply(value));
    else reply(value);
    return;
  }
  report.blocked.push(`${request.method} ${url.pathname}`);
  reply({ error: "Unlisted owned route" }, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
let context;
const check = (name, evidence = {}) => report.checks.push({ name, passed: true, ...evidence });
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function mount(width, height) {
  await context?.close();
  holdProjectA = false;
  for (const release of configHolds.splice(0)) release();
  context = await browser.newContext({
    viewport: { width, height },
    colorScheme: "light",
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(`${origin}/mobile/`);
  if (width <= 760) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("region", { name: "项目会话", exact: true }).waitFor();
  await frames(page);
  return page;
}
const catalog = (page) => page.getByRole("region", { name: "项目会话", exact: true });
const groupButton = (page, project, action = "折叠") =>
  catalog(page).getByRole("button", { name: `${action} ${project.name}`, exact: true });
const rowButton = (page, id) =>
  catalog(page).getByRole("button", {
    name: new RegExp(
      rows.find((row) => row.id === id)?.title ?? extraRows.find((row) => row.id === id)?.title,
    ),
  });
async function openSidebar(page) {
  const toggle = page.getByRole("button", { name: "展开侧栏", exact: true });
  if (await toggle.isVisible()) await toggle.click();
}
async function current(page) {
  return page.evaluate(() => window.fixture.current());
}
async function noHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(metrics.scroll <= metrics.width + 1, JSON.stringify(metrics));
}

try {
  const page = await mount(1440, 1000);
  assert.equal(
    await catalog(page)
      .getByRole("button", { name: /^折叠 / })
      .count(),
    8,
  );
  assert.equal(
    await catalog(page)
      .getByRole("button", { name: /^甲会话 / })
      .count(),
    5,
  );
  assert.equal(await page.getByRole("combobox", { name: "选择项目", exact: true }).count(), 0);
  assert.equal((await current(page)).workspaceCwd, null);
  assert.deepEqual(await page.evaluate(() => window.fixture.creates), []);
  assert.equal(await page.evaluate(() => window.fixture.loadMoreCalls), 0);
  check("initial catalog has eight groups and five rows without selecting or creating a project");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(output, "desktop-initial.png"), fullPage: true });

  // The first group owns the only row-expansion button in this initial fixture.
  await catalog(page)
    .getByRole("button", { name: /^展开显示/ })
    .first()
    .click();
  assert.equal(
    await catalog(page)
      .getByRole("button", { name: /^甲会话 / })
      .count(),
    10,
  );
  await catalog(page)
    .getByRole("button", { name: /^展开显示/ })
    .first()
    .click();
  assert.equal(
    await catalog(page)
      .getByRole("button", { name: /^甲会话 / })
      .count(),
    12,
  );
  await groupButton(page, projects[0]).click();
  assert.equal(
    await catalog(page)
      .getByRole("button", { name: /^甲会话 / })
      .count(),
    0,
  );
  await groupButton(page, projects[0], "展开").click();
  await catalog(page)
    .getByRole("button", { name: /^显示更多项目/ })
    .click();
  await rowButton(page, "unbound-existing").waitFor();
  assert.equal(
    await catalog(page)
      .getByRole("button", { name: /^折叠 / })
      .count(),
    13,
  );
  assert.equal(await page.evaluate(() => window.fixture.loadMoreCalls), 0);
  check("project and row expansion is explicit and does not fetch the whole catalog");

  holdProjectA = true;
  await rowButton(page, "a-1").click();
  await page.waitForFunction(
    () => window.fixture.current().activeId === "a-1" && window.fixture.current().loading,
  );
  await rowButton(page, "b-1").waitFor();
  await rowButton(page, "b-1").click();
  await page.waitForFunction(
    () =>
      window.fixture.current().activeId === "b-1" &&
      window.fixture.current().configurationPath === "/owned/B",
  );
  for (const release of configHolds.splice(0)) release();
  holdProjectA = false;
  await frames(page);
  const selectedB = await current(page);
  assert.equal(selectedB.workspaceCwd, "/owned/B");
  assert.equal(selectedB.apiWorkspace, "/owned/B");
  assert.equal(selectedB.configurationPath, "/owned/B");
  assert.deepEqual(selectedB.scopedIds, ["b-1"]);
  assert.ok(
    selectedB.navigationIds.includes("a-1") && selectedB.navigationIds.includes("unbound-existing"),
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.creates), []);
  const rejected = await page.evaluate(() => window.fixture.associate("a-1"));
  assert.match(rejected, /当前项目|另一个项目/);
  await rowButton(page, "a-1").waitFor();
  await page.screenshot({ path: path.join(output, "desktop-history-pending.png"), fullPage: true });
  check(
    "slow history keeps the complete directory clickable while selected workspace and Panel authority follow B",
  );
  check("a late configuration response from A cannot replace B");

  const oldIds = (await current(page)).navigationIds;
  await page.getByRole("button", { name: "加载更多会话", exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.loadMoreCalls), 1);
  assert.deepEqual((await current(page)).navigationIds, oldIds);
  await rowButton(page, "a-1").click();
  await page.waitForFunction(() => window.fixture.current().activeId === "a-1");
  await rowButton(page, "b-1").waitFor();
  await page.evaluate(() => window.fixture.releaseAppend());
  await rowButton(page, "b-older").waitFor();
  const appended = (await current(page)).navigationIds;
  assert.ok(oldIds.every((id) => appended.includes(id)));
  assert.equal(await page.evaluate(() => window.fixture.loadMoreCalls), 1);
  check(
    "explicit cursor append retains old navigation and permits a session selection during its wait",
  );

  await page.evaluate(() => window.fixture.releaseHistory());
  await page.getByRole("button", { name: "无项目对话", exact: true }).click();
  await page.waitForFunction(
    () => window.fixture.current().workspaceCwd === null && !window.fixture.current().loading,
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.creates), [{ projectId: null }]);
  assert.equal((await current(page)).apiWorkspace, null);
  await rowButton(page, "a-1").waitFor();
  await rowButton(page, "b-1").waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.sends), []);
  check(
    "the direct no-project conversation explicitly uses null without hiding existing project groups",
  );

  const phone = await mount(390, 844);
  await rowButton(phone, "a-1").waitFor();
  await noHorizontalOverflow(phone);
  await phone.screenshot({ path: path.join(output, "phone-directory.png"), fullPage: true });
  await rowButton(phone, "b-1").click();
  await phone.waitForFunction(
    () => window.fixture.current().activeId === "b-1" && window.fixture.current().loading,
  );
  await openSidebar(phone);
  await rowButton(phone, "a-1").waitFor();
  await rowButton(phone, "b-1").waitFor();
  await noHorizontalOverflow(phone);
  await phone.screenshot({ path: path.join(output, "phone-history-pending.png"), fullPage: true });
  check("phone drawer retains project navigation while the selected conversation loads");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blocked, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  for (const page of context?.pages() ?? []) {
    if (!page.isClosed())
      await page
        .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
        .catch(() => {});
  }
  throw error;
} finally {
  for (const release of configHolds.splice(0)) release();
  await context?.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks.length }));
}
