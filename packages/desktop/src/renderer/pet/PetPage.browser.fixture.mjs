/* Offline production-workbench QA. Every Host operation is fixture-owned. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output = process.env.CODESHELL_MIMI_QA_DIR || "/tmp/codeshell-mimi-workbench-qa";
const fixtureOrigin = "http://mimi-workbench-fixture.test/";
await mkdir(output, { recursive: true });

const source = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PetPage} from './pet/PetPage';
import {PetWorldPane} from './pet/PetWorldPane';
import {PetChatHost} from './pet/PetChatHost';
import {PET_CHAT_BUCKET,PetStateProvider,usePetState} from './pet/PetStateProvider';
import {INITIAL_STATE} from './types';
import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';
import {DialogProvider} from './ui/DialogProvider';
import {ToastProvider} from './ui/ToastProvider';
import {applyTheme} from './theme';
const stamp=1792513800000;
let options={lang:'zh',mode:'light',scenario:'populated'},latest;
const calls={sent:[],opened:[],archived:[],settings:0,memory:0};
let inbox={revision:0,dismissedIds:[]},inboxListener=()=>{},followupListener=()=>{};
const labels=()=>options.lang==='zh'?{
 pending:'确认新版本的发布范围',running:'整理工作台的交互体验',completed:'完成项目调研与对比',other:'优化本地开发环境',
 detail:'先完成核心体验，保留后续扩展空间。',workspace:'Mimi 工作空间',followup:'体验新版后，整理下一轮优先改进的三个问题。',
 user:'帮我把工作台整理得更清楚一些，先把需要我处理的事情列出来。',
 reply:'已经梳理好了。\n\n- **1 项待你决定**：确认新版本的发布范围。\n- **1 项正在进行**：整理工作台交互体验。\n- **1 项后续跟进**：体验后收集反馈。\n\n你可以在右侧直接查看进展，或在这里告诉我下一步。',
 }:{pending:'Confirm the scope of the next release',running:'Improve the workspace experience',completed:'Complete the project comparison',other:'Improve the local development setup',
 detail:'Start with the essential experience and leave room to extend it.',workspace:'Mimi workspace',followup:'After trying the new version, collect three priorities for the next iteration.',
 user:'Help me organize my workspace. First, show what needs my attention.',
 reply:'Everything is organized.\n\n- **1 decision for you**: confirm the release scope.\n- **1 task in progress**: improve the workspace experience.\n- **1 follow-up**: collect feedback after trying it.\n\nCheck progress in the work rail, or tell me the next step here.'};
function projection(){
 const text=labels();
 const row=(id,runState,title,extra={})=>({agentSessionId:id,runState,title,summary:text.detail,workspaceDisplayName:text.workspace,queueDepth:0,lastActivityAt:stamp,pendingDecisionCount:0,...extra});
 return {version:1,generation:7,workerState:'active',observedAt:stamp,
 sessions:options.scenario==='empty'?[]:[
 row('fixture-pending','idle',text.pending,{pendingDecisionCount:1}),
 row('fixture-running','running',text.running),
 row('fixture-completed','idle',text.completed,{terminal:{status:'completed',at:stamp-60000}}),
 row('fixture-other','idle',text.other,{terminal:{status:'failed',at:stamp-120000}})],
 pending:options.scenario==='empty'?[]:[{agentSessionId:'fixture-pending',requestId:'fixture-decision',routeGeneration:3,kind:'ask_user',status:'pending',title:text.pending,createdAt:stamp,riskLevel:'low'}]};
}
const api={
 getSnapshot:async()=>projection(),onProjectionEvent:()=>()=>{},
 getAttentionSnapshot:async()=>({surfaceablePendingCount:options.scenario==='empty'?0:1}),onAttentionEvent:()=>()=>{},
 onChatEvent:()=>()=>{},setActiveSession:async()=>({ok:true}),markAttentionReceipt:async()=>({ok:true}),setWidgetSurface:async()=>({ok:true}),
 getDismissedWorkItemIds:async()=>structuredClone(inbox),
 onDismissedWorkItemIdsChanged:listener=>{inboxListener=listener;return()=>{inboxListener=()=>{}}},
 updateDismissedWorkItemIds:async(update)=>{
  inbox={revision:inbox.revision+1,dismissedIds:update.action==='clear'?[]:[...new Set([...inbox.dismissedIds,...update.ids])]};
  inboxListener(structuredClone(inbox));return structuredClone(inbox);
 },
 getSummaries:async()=>options.scenario==='empty'?[]:[{followUpId:'fixture-followup',sessionId:'fixture-completed',title:labels().completed,workspaceDisplayName:labels().workspace,terminalAt:stamp-60000,text:labels().followup}],
 onFollowUpsChanged:listener=>{followupListener=listener;return()=>{followupListener=()=>{}}},
 archiveSession:async id=>{calls.archived.push(id)},
 getLatestSessionResult:async()=>({text:labels().detail,truncated:false}),
 getLongTasks:async()=>({revision:1,observedAt:stamp,tasks:[]}),onLongTasksChanged:()=>()=>{},
 dispatch:async command=>{
  if(command.type==='get_global_status')return {ok:true,type:'global_status',version:1,generation:7,observedAt:stamp,workerState:'active',petSessionId:'fixture-mimi-chat',runningCount:projection().sessions.filter(s=>s.runState==='running').length,queuedCount:0,pendingCount:projection().pending.length,sessions:projection().sessions};
  if(command.type==='chat'){calls.sent.push(structuredClone(command));return {ok:true,type:'chat',petSessionId:'fixture-mimi-chat',result:{reason:'completed'}}}
  if(command.type==='stop_chat')return {ok:true,type:'stop_chat',stopped:true};
  throw new Error('Unexpected fixture command: '+command.type);
 },
};
window.codeshell={pet:api,log:()=>{},openExternal:async()=>{},revealInFinder:async()=>{}};
function Surface(){
 latest=usePetState();
 const seeded=React.useRef(false);
 React.useEffect(()=>{
  if(!latest.petSessionId||seeded.current)return;
  seeded.current=true;
  if(options.scenario==='empty')return;
  const text=labels();
  latest.chatDispatch({type:'hydrate',bucket:PET_CHAT_BUCKET,state:{...INITIAL_STATE,messages:[
   {kind:'user',id:'fixture-user',text:text.user,clientMessageId:'fixture-user'},
   {kind:'assistant',id:'fixture-reply',text:text.reply,done:true},
  ]}});
 },[latest.petSessionId]);
 return <PetPage overview={latest.state}>
  <PetWorldPane projection={latest.state.projection} status={latest.state.status} focusPending={latest.state.overviewFocus==='pending'} now={stamp+30000} onNavigate={request=>calls.opened.push(request)}/>
  <PetChatHost defaultProjectPath={null} defaultModelKey='fixture-balanced' modelOptions={[{key:'fixture-balanced',label:'Balanced',provider:'Demo'},{key:'fixture-deep',label:'Deep thinking',provider:'Demo'}]} onOpenSession={request=>calls.opened.push(request)} onOpenSettings={()=>calls.settings++} onOpenMemory={()=>calls.memory++}/>
 </PetPage>;
}
const root=createRoot(document.getElementById('root'));
window.fixture={calls,get latest(){return latest},get options(){return options},setBusy:busy=>latest.setChatBusy(busy),setDraft:draft=>latest.dispatch({type:'set-chat-draft',draft}),resetCalls:()=>{for(const key of ['sent','opened','archived'])calls[key].length=0}};
window.renderFixture=next=>{
 options={...options,...next};inbox={revision:0,dismissedIds:[]};
 saveUILanguage(options.lang);applyTheme(options.mode);
 root.render(<I18nProvider key={JSON.stringify(options)}><ToastProvider><DialogProvider><PetStateProvider api={api}><Surface/></PetStateProvider></DialogProvider></ToastProvider></I18nProvider>);
};
window.renderFixture(options);
`;

const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "dataurl", ".webp": "dataurl", ".wav": "empty", ".css": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
});
const cssPath = path.join(renderer, "styles/tailwind.css");
const compiled = await compile(await readFile(cssPath, "utf8"), {
  base: path.dirname(cssPath),
  from: cssPath,
  onDependency() {},
});
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx,html}", negated: false }],
});
const css = compiled.build([
  ...scanner.scan(),
  ...scanner.scanFiles([{ content: source, extension: "tsx" }]),
]);
const javascript = bundle.outputFiles[0].text;
const chrome = `<style>html,body{margin:0;height:100%;overflow:hidden}#root{display:flex;min-width:0;min-height:0;height:100%}*{box-sizing:border-box}</style>`;
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimi workbench preview</title>${chrome}<style>${css}</style></head><body><div id="root"></div><script>${javascript.replaceAll("</script", "<\\/script")}</script></body></html>`;
const previewControls = `<aside class="preview-controls"><span>交互预览 · 示例数据</span><select aria-label="Preview scenario" onchange="renderFixture({scenario:this.value})"><option value="populated">Demo work</option><option value="empty">Empty workspace</option></select><select aria-label="Preview language" onchange="renderFixture({lang:this.value})"><option value="zh">中文</option><option value="en">English</option></select><select aria-label="Preview theme" onchange="renderFixture({mode:this.value})"><option value="light">Light</option><option value="dark">Dark</option></select></aside>`;
const previewStyle = `<style>body{display:flex;flex-direction:column}.preview-controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex-shrink:0;min-height:38px;padding:6px 12px;background:rgb(128 128 128 / .12);font:11px system-ui;color:inherit}.preview-controls span{margin-right:auto}.preview-controls select{background:transparent;color:inherit;border:1px solid rgb(128 128 128 / .35);border-radius:5px;padding:2px 4px}#root{flex:1;height:0}</style>`;
await writeFile(
  path.join(output, "preview.html"),
  pageHtml
    .replace("</head>", `${previewStyle}</head>`)
    .replace('<div id="root">', `${previewControls}<div id="root">`),
);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const errors = [],
  blocked = [],
  reports = [];
async function mount(width, lang, mode, scenario) {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
    colorScheme: mode,
  });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === fixtureOrigin)
      return route.fulfill({ contentType: "text/html", body: pageHtml });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto(fixtureOrigin);
  await page.evaluate((next) => window.renderFixture(next), { lang, mode, scenario });
  await page.waitForFunction(() => window.fixture.latest?.petSessionId === "fixture-mimi-chat");
  await page.locator("[data-pet-manager-chat] textarea").waitFor();
  if (scenario === "populated")
    await page.locator('[data-pet-follow-up="needs-follow-up"]').waitFor({ state: "attached" });
  return page;
}
async function geometry(page, phase) {
  const snapshot = await page.evaluate(() => {
    const shape = (selector) => {
      const node = typeof selector === "string" ? document.querySelector(selector) : selector;
      const r = node.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        client: node.clientWidth,
        scroll: node.scrollWidth,
      };
    };
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      document: document.documentElement.scrollWidth,
      page: shape("[data-pet-page]"),
      chat: shape("[data-pet-manager-chat]"),
      composer: shape("[data-pet-manager-chat] textarea"),
      composerFrame: shape("[data-pet-manager-chat] .mimi-composer"),
      composerWrap: shape("[data-pet-manager-chat] .mimi-composer-wrap"),
      send: shape(Array.from(document.querySelectorAll("[data-pet-manager-chat] button")).at(-1)),
    };
  });
  reports.push({ phase, ...snapshot });
  assert(snapshot.document <= snapshot.width + 1, `${phase}: no horizontal document overflow`);
  for (const [name, rect] of Object.entries(snapshot).filter(
    ([, value]) => value && typeof value === "object",
  )) {
    assert(
      rect.x >= -1 && rect.right <= snapshot.width + 1,
      `${phase}: ${name} remains within viewport`,
    );
    assert(rect.scroll <= rect.client + 1, `${phase}: ${name} content wraps`);
  }
  assert(
    snapshot.composer.y >= 0 && snapshot.composer.bottom <= snapshot.height + 1,
    `${phase}: composer remains reachable`,
  );
  assert(
    snapshot.send.y >= 0 && snapshot.send.bottom <= snapshot.height + 1,
    `${phase}: send action remains reachable`,
  );
  for (const name of ["composerFrame", "composerWrap"]) {
    const rect = snapshot[name];
    assert(
      rect.x >= snapshot.chat.x - 1 && rect.right <= snapshot.chat.right + 1,
      `${phase}: ${name} remains within chat width`,
    );
    assert(
      rect.y >= snapshot.chat.y - 1 && rect.bottom <= snapshot.chat.bottom + 1,
      `${phase}: ${name} remains fully within chat height`,
    );
  }
  assert(snapshot.composer.height >= 35, `${phase}: composer retains usable height`);
}
async function openWork(page, width) {
  const toggle = page.locator("[data-pet-work-toggle]");
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${width}: work expands`);
  }
}
try {
  for (const width of [1600, 1280, 820, 390]) {
    for (const lang of ["zh", "en"]) {
      const mode = lang === "zh" ? "light" : "dark";
      for (const scenario of ["populated", "empty"]) {
        const page = await mount(width, lang, mode, scenario);
        const phase = `${width}-${lang}-${mode}-${scenario}`;
        await geometry(page, phase);
        await page.screenshot({ path: path.join(output, `${phase}.png`) });
        const input = page.locator("[data-pet-manager-chat] textarea");
        const focus = page.locator("[data-pet-focus-mode]");
        if (await focus.isVisible()) {
          await input.fill("Draft survives focus mode");
          await focus.click();
          assert.equal(
            await focus.getAttribute("aria-pressed"),
            "true",
            `${phase}: focus mode announced`,
          );
          assert.equal(
            await page.locator("[data-pet-world-pane]").isVisible(),
            false,
            `${phase}: focus mode hides work rail`,
          );
          assert.equal(
            await input.inputValue(),
            "Draft survives focus mode",
            `${phase}: focus mode preserves draft`,
          );
          await geometry(page, `${phase}-focused`);
          await focus.click();
          assert.equal(
            await page.locator("[data-pet-world-pane]").isVisible(),
            true,
            `${phase}: work rail restores`,
          );
          await input.fill("");
        }
        await page.locator("[data-pet-open-memory]").click();
        assert.equal(
          await page.evaluate(() => window.fixture.calls.memory),
          1,
          `${phase}: direct memory entry`,
        );
        if (scenario === "empty") {
          const suggestions = page.locator("[data-pet-chat-suggestion]");
          assert((await suggestions.count()) >= 2, `${phase}: discoverable starting prompts`);
          await suggestions.first().click();
          assert((await input.inputValue()).length > 0, `${phase}: suggestion fills draft`);
          assert.equal(
            await page.evaluate(() => window.fixture.calls.sent.length),
            0,
            `${phase}: suggestion waits for review`,
          );
          await input.fill("First line");
          await input.press("Shift+Enter");
          await input.type("Second line");
          assert((await input.inputValue()).includes("\n"), `${phase}: multiline draft`);
          assert.equal(await page.evaluate(() => window.fixture.calls.sent.length), 0);
          await input.press("Enter");
          await page.waitForFunction(() => window.fixture.calls.sent.length === 1);
          assert.equal(await input.inputValue(), "", `${phase}: sent draft clears`);
        } else {
          await openWork(page, width);
          const pending = page.locator(
            '[data-pet-work-open="pending:fixture-pending:fixture-decision"]',
          );
          await pending.scrollIntoViewIfNeeded();
          await pending.click();
          assert.deepEqual(
            await page.evaluate(() => window.fixture.calls.opened[0]),
            {
              agentSessionId: "fixture-pending",
              requestId: "fixture-decision",
              routeGeneration: 3,
              snapshotVersion: 1,
              generation: 7,
            },
            `${phase}: decision navigation preserves exact routing`,
          );
          const pendingFilter = page.locator('[data-pet-work-filter="pending"]');
          if (await pendingFilter.count()) {
            await pendingFilter.click();
            assert.equal(
              await pendingFilter.getAttribute("aria-pressed"),
              "true",
              `${phase}: active filter is announced`,
            );
            assert.equal(
              await page.locator("[data-pet-work-open]").count(),
              1,
              `${phase}: decision filter shows actionable work`,
            );
            await page.locator('[data-pet-work-filter="all"]').click();
          }
          const search = page.locator("[data-pet-work-search]");
          if (await search.count()) {
            await search.fill("no-fixture-task-matches-this-query");
            assert.equal(
              await page.locator("[data-pet-work-open]").count(),
              0,
              `${phase}: search removes unrelated rows`,
            );
            await search.fill("");
            await pending.waitFor();
            await page.locator('[data-pet-work-filter="completed"]').click();
            await search.fill("no-fixture-task-matches-this-query");
            await page.locator("[data-pet-work-drawer]").click();
            await page.evaluate(() =>
              window.fixture.latest.dispatch({ type: "set-overview-focus", focus: "pending" }),
            );
            await pending.waitFor({ state: "visible" });
            assert.equal(
              await search.inputValue(),
              "",
              `${phase}: pending focus clears stale search`,
            );
            assert.equal(
              await page.locator('[data-pet-work-filter="all"]').getAttribute("aria-pressed"),
              "true",
              `${phase}: pending focus clears stale filter`,
            );
            assert.equal(
              await page.locator("[data-pet-work-drawer]").getAttribute("aria-expanded"),
              "true",
              `${phase}: pending focus reopens inbox`,
            );
          }
          await page.evaluate(() => window.fixture.setDraft("Existing draft"));
          const ask = page
            .locator('[data-pet-follow-up-id="fixture-followup"]')
            .getByRole("button", { name: lang === "zh" ? "交给 Mimi" : "Ask Mimi", exact: true });
          await ask.scrollIntoViewIfNeeded();
          await ask.click();
          assert(
            (await input.inputValue()).includes("Existing draft"),
            `${phase}: handoff preserves existing draft`,
          );
          assert(
            (await input.inputValue()).includes("fixture-followup"),
            `${phase}: handoff keeps exact reminder ID`,
          );
          assert.equal(
            await page.evaluate(() => window.fixture.calls.sent.length),
            0,
            `${phase}: handoff waits for review`,
          );
          await geometry(page, `${phase}-work-open`);
          await page.screenshot({ path: path.join(output, `${phase}-work-open.png`) });
        }
        if (scenario === "populated") {
          await page.evaluate(() => window.fixture.setBusy(true));
          await page.locator("[data-pet-chat-activity]").waitFor();
          await geometry(page, `${phase}-replying`);
          await page.evaluate(() => window.fixture.setBusy(false));
        }
        await page.setViewportSize({ width, height: 600 });
        await geometry(page, `${phase}-short-window`);
        if (scenario === "populated") {
          await page.screenshot({ path: path.join(output, `${phase}-short-window.png`) });
          await page.evaluate(() => {
            const snapshot = window.fixture.latest.state.projection;
            const base = snapshot.sessions.find(
              (session) => session.agentSessionId === "fixture-completed",
            );
            window.fixture.latest.dispatch({
              type: "snapshot-received",
              snapshot: {
                ...snapshot,
                version: snapshot.version + 1,
                sessions: [
                  ...snapshot.sessions,
                  ...Array.from({ length: 12 }, (_, index) => ({
                    ...base,
                    agentSessionId: `fixture-older-${index}`,
                    title: `Older bounded task ${index}`,
                    lastActivityAt: base.lastActivityAt - 60000 * (index + 1),
                  })),
                ],
              },
            });
          });
          const older = page.locator('[data-pet-work-open="completed:fixture-older-11"]');
          assert.equal(await older.count(), 0, `${phase}: older item starts beyond preview limit`);
          await page.locator("[data-pet-work-search]").fill("Older bounded task 11");
          await older.waitFor({ state: "visible" });
          assert.equal(
            await page.locator("[data-pet-work-open]").count(),
            1,
            `${phase}: search finds older items beyond preview limit`,
          );
        }
        await page.close();
      }
    }
  }
  assert.deepEqual(errors, [], "No uncaught browser errors");
  assert.deepEqual(blocked, [], "The workbench makes no network requests");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ errors, blocked, reports }, null, 2),
  );
  console.log(
    JSON.stringify({
      ok: true,
      output,
      scenarios: reports.length,
      preview: path.join(output, "preview.html"),
    }),
  );
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ errors, blocked, reports }, null, 2),
  );
  await browser.close();
}
