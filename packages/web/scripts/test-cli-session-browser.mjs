/** Real Desktop controller/Workbench with an owned CLI adapter, delayed acknowledgements,
 * and an isolated browser. No real CLI, user session, credentials or remote are accessed.
 * Run through scripts/run-isolated-node-smoke.mjs; --source-repo checks another checkout.
 */
/* global window, document, requestAnimationFrame, getComputedStyle */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  return path.resolve(process.argv[index + 1]);
}
const repo = argument("--source-repo") ?? fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output =
  argument("--output-dir") ?? (await mkdtemp(path.join(tmpdir(), "codeshell-cli-session-")));
await mkdir(output, { recursive: true });
console.log(`CLI session browser evidence: ${output}`);
const origin = "http://cli-session-owned.test";
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Workbench} from './Workbench';
import {useDesktopController} from './DesktopApp';
import {initialChatState} from '../src/lib/streamReducer';
const noop=()=>{},long='CLI长标题与很长的标识符ownedidentifier'.repeat(30);
const models=[
  {key:'codex/owned-a',kind:'codex',provider:'codex',label:'Codex Owned A'},
  {key:'codex/owned-b',kind:'codex',provider:'codex',label:'Codex Owned B '+long},
  {key:'claude-code/owned-c',kind:'claude-code',provider:'claude-code',label:'Claude Owned C'},
];
window.fixture={modelRequests:[],permissionRequests:[],opens:[],sends:[]};
window.WebSocket=class {constructor(){throw Error('No socket is permitted in this controlled CLI adapter fixture')}};
function Fixture(){
  const [state,setState]=React.useState({status:'online',kind:'codex',modelKey:'codex/owned-a',permissionMode:'default',
    observing:false,running:false,queued:false,approving:false,historyLoading:false,modelSupport:true,notice:'',pending:null});
  window.fixture.patch=patch=>setState(s=>({...s,...patch}));
  window.fixture.accept=()=>setState(s=>({...s,
    modelKey:s.pending&&Object.hasOwn(s.pending,'modelKey')?s.pending.modelKey:s.modelKey,
    permissionMode:s.pending?.mode??s.permissionMode,pending:null,notice:''}));
  window.fixture.reject=()=>setState(s=>({...s,pending:null,notice:'模型未更改：测试中的电脑拒绝了这次切换。'}));
  const room={id:'owned-room',sessionId:'owned-cli',kind:state.kind,name:long,cwd:'/owned/repo',
    modelKey:state.modelKey??undefined,permissionMode:state.permissionMode,observing:state.observing,
    open:true,createdAt:1,lastActiveAt:1};
  const app={status:state.status,projects:[{id:'owned-project',name:'Owned project',path:'/owned/repo'}],
    activeCwd:'/owned/repo',activeProjectId:'owned-project',activeProjectCwd:'/owned/repo',
    activeSessionId:undefined,activeRoomId:room.id,activeRoom:room,sessions:[],conversationRevision:1,
    chat:{...initialChatState(),items:[{kind:'assistant',id:'owned-message',text:'Owned CLI transcript',done:true}],run:state.running?'running':'idle'},
    approvals:state.approving?[{requestId:'owned-approval',roomId:room.id,toolName:'Bash',summary:'Owned command',description:'Owned command',risk:'low'}]:[],
    permissionMode:'default',unreadSessionIds:new Set(),notice:state.notice,
    loading:{sessions:false,sessionHistory:false,rooms:false,projects:false,roomHistory:state.historyLoading,ccSessions:false},
    ccCliKind:state.kind,ccProbe:{available:true},ccSessions:[
      {sessionId:'owned-cli',firstMessage:long,cwd:'/owned/repo',messageCount:12},
      {sessionId:'unknown-count',firstMessage:'Unknown message count',cwd:'/owned/repo',lastModified:Date.now()-60000},
      {sessionId:'empty-count',firstMessage:'Empty conversation',cwd:'/owned/repo',messageCount:0}],
    runtimeModels:models,runtimeModelsLoading:false,refreshRuntimeModels:noop,
    ccRoomModelSelection:state.modelSupport,ccModeRequest:state.pending??undefined,
    setCcRoomModel:modelKey=>{window.fixture.modelRequests.push(modelKey);setState(s=>({...s,notice:'',pending:{mode:s.permissionMode,switching:true,modelKey}}))},
    setCcRoomPermissionMode:mode=>{window.fixture.permissionRequests.push(mode);setState(s=>({...s,notice:'',pending:{mode,switching:true}}))},
    turnQueueSupported:true,turnQueue:{target:{kind:'room',roomId:room.id},epoch:'owned-epoch',revision:1,
      entries:state.queued?[{id:'owned-queued',clientMessageId:'owned-client',text:'Owned queued task',attachments:[],status:'queued',createdAt:1,ownDevice:true}]:[]},
    cancelQueuedTurn:noop,retryQueuedTurn:noop,resumeTurnQueue:noop,clearTurnQueue:noop,
    logout:noop,respondApproval:noop,respondCcApproval:noop,setPermissionMode:noop,extendGoal:noop,clearGoal:noop,
    leaveRoom:noop,setCcCliKind:kind=>setState(s=>({...s,kind,modelKey:undefined})),
    openCcSession:(...args)=>window.fixture.opens.push(args),stopRun:noop,outputHistoryFailed:false,
    refreshSessions:noop,selectProject:noop,selectSession:noop,newSession:noop,
    sendChat:message=>{window.fixture.sends.push({text:message.text,attachments:message.attachments.length});
      return new Promise(resolve=>{window.fixture.finishSend=resolve})},
  };
  const controller=useDesktopController(app,{id:'owned-login',username:'Owned fixture',deviceName:'Owned browser'},
    ()=>{throw Error('Unexpected fixture auth loss')});
  return <Workbench controller={controller}/>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const report = { checks: [], errors: [], blocked: [], requests: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const patch = async (page, value) => {
  await page.evaluate((next) => window.fixture.patch(next), value);
  await frames(page);
};
const modelButton = (page) => page.getByRole("button", { name: "选择 CLI 模型", exact: true });
const modelDialog = (page) => page.getByRole("dialog", { name: "选择 CLI 模型", exact: true });
const permission = (page) => page.getByRole("button", { name: "权限模式", exact: true });
const input = (page) => page.getByRole("textbox", { name: "任务内容", exact: true });
const check = (name, evidence = {}) => report.checks.push({ name, passed: true, ...evidence });
async function dimensions(page, label, width) {
  await frames(page);
  const result = await page.evaluate(() => {
    const overflow = (selector) => {
      const node = document.querySelector(selector);
      return node ? node.scrollWidth - node.clientWidth : 0;
    };
    const targets = [
      ...document.querySelectorAll(
        ".composer-toolbar button,.composer-toolbar select,.desktop-cli-session-actions button",
      ),
    ]
      .filter((node) => node.getBoundingClientRect().width)
      .map((node) => {
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        // The leave action lives in the transcript and remains reachable by scrolling.
        const list = node.closest(".messages")?.getBoundingClientRect();
        const clipped =
          !!list && (r.y + r.height / 2 < list.top || r.y + r.height / 2 > list.bottom);
        return {
          label: node.getAttribute("aria-label") || node.textContent.trim(),
          width: r.width,
          height: r.height,
          left: r.left,
          right: r.right,
          hit: clipped || node.contains(hit),
        };
      });
    return {
      page: document.scrollingElement.scrollWidth - window.innerWidth,
      toolbar: overflow(".composer-toolbar"),
      transcript: overflow(".messages"),
      composerHeight: document.querySelector(".composer-wrap")?.getBoundingClientRect().height,
      targets,
    };
  });
  assert.ok(result.page <= 1, `${label}: page overflow ${result.page}`);
  assert.ok(result.toolbar <= 1, `${label}: toolbar overflow ${result.toolbar}`);
  assert.ok(result.transcript <= 1, `${label}: transcript overflow ${result.transcript}`);
  for (const target of result.targets) {
    assert.ok(
      target.left >= -1 && target.right <= width + 1,
      `${label}: ${JSON.stringify(target)}`,
    );
    assert.ok(target.hit, `${label}: covered ${JSON.stringify(target)}`);
    if (width <= 760)
      assert.ok(target.width >= 44 && target.height >= 44, `${label}: ${JSON.stringify(target)}`);
  }
  check(label, result);
}
try {
  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [1280, 900],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: width <= 760,
      hasTouch: width <= 760,
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      report.requests.push(`${route.request().method()} ${url.pathname}`);
      if (route.request().method() !== "GET" || url.origin !== origin) {
        report.blocked.push(route.request().url());
        return route.abort();
      }
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
        });
      if (url.pathname === "/api/v1/environment")
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      if (url.pathname === "/api/v1/configuration")
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            workspace: { path: "/owned/repo", settingsScope: "local", skillDirectories: [] },
            defaults: {},
            connections: [],
            catalog: [],
            skills: [],
            mcpServers: [],
            restartRequired: false,
          }),
        });
      report.blocked.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto(`${origin}/`);
    for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css")))
      await page.addStyleTag({ content: file.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
    });
    await input(page).waitFor();
    await input(page).fill("保留这条尚未发送的草稿");
    await dimensions(page, `idle-${width}`, width);
    assert.equal(await page.locator(".composer .desktop-room-label").count(), 0);
    assert.equal(await page.getByRole("button", { name: "模型设置", exact: true }).count(), 0);
    assert.match(await modelButton(page).textContent(), /Codex Owned A/);

    // The real catalog keeps known, unknown and zero counts distinct and identifies the active CLI.
    if (width <= 760) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.locator(".desktop-cli-sessions summary").click();
    const rows = page.locator(".desktop-cli-sessions .session");
    assert.equal(await rows.count(), 3);
    assert.match(await rows.nth(0).textContent(), /12 条消息/);
    assert.equal(await rows.nth(0).getAttribute("aria-current"), "page");
    assert.ok(await rows.nth(0).getAttribute("title"));
    const countAlignment = await rows
      .nth(0)
      .evaluate((row) =>
        Math.abs(
          row.querySelector(".session-title").getBoundingClientRect().left -
            row.querySelector(".session-meta").getBoundingClientRect().left,
        ),
      );
    assert.ok(countAlignment <= 1, `catalog-${width}: count aligns with title`);
    assert.doesNotMatch(await rows.nth(1).textContent(), /(?:undefined|NaN|0) 条消息/);
    assert.match(await rows.nth(2).textContent(), /0 条消息/);
    const railOverflow = await page
      .locator(".rail")
      .evaluate((node) => node.scrollWidth - node.clientWidth);
    assert.ok(railOverflow <= 1, `catalog-${width}: horizontal overflow ${railOverflow}`);
    await page.screenshot({ path: path.join(output, `catalog-${width}.png`) });
    if (width <= 760)
      await page
        .getByRole("dialog", { name: "工作台导航", exact: true })
        .getByRole("button", { name: "收起侧栏", exact: true })
        .click();
    check(`catalog-counts-and-active-${width}`);

    await modelButton(page).click();
    await modelDialog(page).waitFor();
    assert.equal(
      await modelDialog(page)
        .getByRole("option", { name: /Claude Owned C/ })
        .count(),
      0,
    );
    await modelDialog(page)
      .getByRole("option", { name: /Codex Owned B/ })
      .click();
    assert.deepEqual(await page.evaluate(() => window.fixture.modelRequests), ["codex/owned-b"]);
    assert.match(await modelButton(page).textContent(), /Codex Owned A/);
    assert.equal(await modelButton(page).isDisabled(), true);
    assert.equal(await permission(page).isDisabled(), true);
    assert.equal(await input(page).inputValue(), "保留这条尚未发送的草稿");
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
    assert.equal(await input(page).isDisabled(), false);
    await input(page).fill("切换确认期间仍可编辑");
    if (width > 760) await input(page).press("Enter");
    assert.deepEqual(await page.evaluate(() => window.fixture.sends), []);
    await patch(page, { queued: true });
    assert.equal(await page.locator('button[aria-label="加入队列"]:enabled').count(), 0);
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
    await patch(page, { queued: false });
    await input(page).fill("保留这条尚未发送的草稿");
    await page.evaluate(() => window.fixture.reject());
    await frames(page);
    assert.equal(await modelButton(page).isDisabled(), false);
    assert.match(await modelButton(page).textContent(), /Codex Owned A/);
    assert.equal(await input(page).inputValue(), "保留这条尚未发送的草稿");
    assert.match(await page.locator("body").textContent(), /模型未更改/);
    await modelButton(page).click();
    await modelDialog(page)
      .getByRole("option", { name: /Codex Owned B/ })
      .click();
    await page.evaluate(() => window.fixture.accept());
    await frames(page);
    assert.match(await modelButton(page).textContent(), /Codex Owned B/);
    assert.equal(await input(page).inputValue(), "保留这条尚未发送的草稿");
    await dimensions(page, `long-model-${width}`, width);
    await page.screenshot({ path: path.join(output, `composer-${width}.png`) });
    check(`delayed-model-ack-and-rejection-preserve-draft-${width}`);

    await modelButton(page).click();
    await modelDialog(page)
      .getByRole("option", { name: /CLI 默认模型/ })
      .click();
    assert.equal(await page.evaluate(() => window.fixture.modelRequests.at(-1)), null);
    await page.evaluate(() => window.fixture.accept());
    await frames(page);
    assert.match(await modelButton(page).textContent(), /CLI 默认模型/);
    await patch(page, { kind: "claude-code", modelKey: "claude-code/owned-c" });
    await modelButton(page).click();
    assert.equal(
      await modelDialog(page)
        .getByRole("option", { name: /Codex Owned/ })
        .count(),
      0,
    );
    assert.equal(
      await modelDialog(page)
        .getByRole("option", { name: /Claude Owned C/ })
        .count(),
      1,
    );
    await page.getByRole("button", { name: "关闭模型选择", exact: true }).click();
    await patch(page, { kind: "codex", modelKey: "codex/owned-a" });
    check(`default-and-kind-filter-${width}`);

    // A normal permission change needs no disruptive confirmation; risky escalation still does.
    const dialogs = [];
    const dismiss = async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    };
    page.on("dialog", dismiss);
    await permission(page).click();
    const permissions = page.getByRole("dialog", { name: "权限模式", exact: true });
    await permissions.waitFor();
    assert.equal(await permissions.getByRole("searchbox").count(), 0);
    assert.equal(await permissions.getByRole("option").count(), 3);
    assert.equal(
      await permissions.getByRole("option", { selected: true }).getAttribute("value"),
      "default",
    );
    const permissionBounds = await permissions.boundingBox();
    assert.ok(
      permissionBounds.x >= 10 && permissionBounds.x + permissionBounds.width <= width - 10,
    );
    assert.ok(
      permissionBounds.y >= 10 && permissionBounds.y + permissionBounds.height <= height - 10,
    );
    assert.ok(permissionBounds.height < 500, "three permission choices use a compact dialog");
    for (const option of await permissions.getByRole("option").all()) {
      const bounds = await option.boundingBox();
      assert.ok(bounds.height >= 44, "permission choices remain touchable");
      assert.equal(
        await option
          .locator("span")
          .first()
          .evaluate((node) => getComputedStyle(node).webkitLineClamp),
        "none",
      );
    }
    await page.screenshot({ path: path.join(output, `permissions-${width}.png`) });
    await page.keyboard.press("End");
    assert.equal(
      await permissions
        .getByRole("option")
        .last()
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await permissions
        .getByRole("option")
        .nth(1)
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Escape");
    await permissions.waitFor({ state: "detached" });
    assert.equal(await permission(page).evaluate((node) => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => window.fixture.permissionRequests), []);
    await permission(page).click();
    await permissions.getByRole("option", { name: /^工作区读写/ }).click();
    assert.deepEqual(dialogs, []);
    assert.equal(await permission(page).getAttribute("value"), "default");
    await page.evaluate(() => window.fixture.accept());
    await frames(page);
    assert.equal(await permission(page).getAttribute("value"), "acceptEdits");
    await permission(page).click();
    await permissions.getByRole("option", { name: /^完全访问/ }).click();
    assert.equal(dialogs.length, 1);
    assert.deepEqual(await page.evaluate(() => window.fixture.permissionRequests), ["acceptEdits"]);
    assert.equal(await permission(page).getAttribute("value"), "acceptEdits");
    page.off("dialog", dismiss);
    page.once("dialog", (dialog) => dialog.accept());
    await permission(page).click();
    await permissions.getByRole("option", { name: /^完全访问/ }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.permissionRequests), [
      "acceptEdits",
      "bypassPermissions",
    ]);
    assert.equal(await permission(page).getAttribute("value"), "acceptEdits");
    assert.equal(await permission(page).isDisabled(), true);
    await page.evaluate(() => window.fixture.accept());
    await frames(page);
    assert.equal(await permission(page).getAttribute("value"), "bypassPermissions");
    assert.equal(await input(page).inputValue(), "保留这条尚未发送的草稿");
    check(`permission-keyboard-confirmation-and-host-ack-${width}`);

    for (const [name, blocked] of [
      ["offline", { status: "offline" }],
      ["running", { running: true }],
      ["queued", { queued: true }],
      ["approval", { approving: true }],
      ["readonly", { observing: true }],
      ["history", { historyLoading: true }],
    ]) {
      await patch(page, {
        status: "online",
        running: false,
        queued: false,
        approving: false,
        observing: false,
        historyLoading: false,
        ...blocked,
      });
      assert.equal(await modelButton(page).isDisabled(), true, `${name}: model disabled`);
      assert.equal(await permission(page).isDisabled(), true, `${name}: permission disabled`);
      if (name === "queued") {
        const requested = await page.evaluate(() => window.fixture.permissionRequests);
        await permission(page).evaluate((button) => button.click());
        await frames(page);
        assert.equal(await permissions.count(), 0, "queued turns prevent opening the picker");
        assert.deepEqual(await page.evaluate(() => window.fixture.permissionRequests), requested);
      }
      assert.equal(await input(page).inputValue(), "保留这条尚未发送的草稿");
      if (name === "readonly") assert.equal(await input(page).isDisabled(), true);
      await dimensions(page, `${name}-${width}`, width);
    }
    await patch(page, {
      status: "online",
      running: false,
      queued: false,
      approving: false,
      observing: false,
      historyLoading: false,
      modelSupport: false,
    });
    assert.equal(
      await modelButton(page).isDisabled(),
      true,
      "old Host must not advertise switching",
    );
    assert.equal(
      await permission(page).isDisabled(),
      false,
      "old Host still supports permission changes",
    );
    assert.deepEqual(await page.evaluate(() => window.fixture.sends), []);
    check(`gates-and-old-host-${width}`);

    // The reverse race is also blocked while an owned attachment submission is in flight.
    // sendChat is a manually settled local Promise; neither upload nor CLI work is started.
    await patch(page, { modelSupport: true });
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "owned.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1kAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await frames(page);
    assert.deepEqual(await page.evaluate(() => window.fixture.sends), [
      { text: "保留这条尚未发送的草稿", attachments: 1 },
    ]);
    assert.equal(
      await modelButton(page).isDisabled(),
      true,
      "attachment submission blocks model changes",
    );
    assert.equal(
      await permission(page).isDisabled(),
      true,
      "attachment submission blocks permission changes",
    );
    await page.evaluate(() => window.fixture.finishSend(false));
    await frames(page);
    assert.equal(await input(page).inputValue(), "保留这条尚未发送的草稿");
    assert.equal(await modelButton(page).isDisabled(), false);
    assert.equal(await permission(page).isDisabled(), false);
    assert.match(await page.locator(".composer").textContent(), /owned.png/);
    check(`attachment-submission-blocks-setting-race-${width}`);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blocked, []);
  console.log(`CLI session browser fixture passed: ${report.checks.length} checks; ${output}`);
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
