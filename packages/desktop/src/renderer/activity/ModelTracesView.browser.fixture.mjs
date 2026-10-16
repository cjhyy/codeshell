/* Production model trace explorer with owned bridge fixtures and real compiled CSS. */
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
const tailwind = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwind("@tailwindcss/node");
const { Scanner } = tailwind("@tailwindcss/oxide");
const output = process.env.CODESHELL_TRACE_QA_DIR || "/tmp/codeshell-model-traces-qa";
await mkdir(output, { recursive: true });
const source = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { ModelTracesView } from "./activity/ModelTracesView";
import { ActivityNavigation } from "./activity/ActivityNavigation";
import { AppMainView } from "./app/AppShell";
import { I18nProvider } from "./i18n/I18nProvider";
const root = createRoot(document.getElementById("root"));
window.fixture = { calls: [], copied: "", failList: false, failGet: false, failConfig: false, config: { enabled: true, captureContent: true, includeEphemeral: true, retentionDays: 7 } };
const records = Array.from({length:70}, (_, i) => ({
 version:1,id:"request-"+i,traceId:"execution-"+Math.floor(i/10),sessionId:"session-original",runId:"run-"+Math.floor(i/10),source:i===4?"external-cli-input":"desktop",purpose:i%3===0?"answer":"compaction",provider:"provider-"+(i%2),model:"model-"+(i%3),startedAt:1800000000000+i*5000,endedAt:1800000002000+i*5000,status:i%5===0?"failed":"completed",stream:true,
 inputState:i===3?"not-recorded":"recorded", input:i===3?undefined:{systemPrompt:"System Prompt snapshot 中文\\n"+"Long system instruction content. 中文规则 ".repeat(80),messages:[{role:"user",content:"Original user request 中文"},{role:"assistant",content:[{type:"text",text:"Previous answer"}]}],tools:[{name:"Read",description:"Read original file",parameters:{path:{type:"string"}}}],parameters:{temperature:0.3}},
 outputState:i===3?"not-recorded":"recorded",output:i===3?undefined:{text:"Final recorded answer "+i,thinking:"Recorded reasoning",stopReason:"stop"},usage:{promptTokens:1234,completionTokens:200,totalTokens:1434,cacheReadTokens:100},
 attempts:[{id:"attempt-"+i+"-1",number:1,startedAt:1800000000000+i*5000,endedAt:1800000000200+i*5000,status:"failed",httpStatus:429,coverage:i===4?"logical-input":"provider-wire",inputState:"recorded",input:{model:"final-wire-model",messages:[{role:"user",content:"Final provider wire input "+i}],tools:[{type:"function",function:{name:"Read"}}]},outputState:"not-recorded",error:"Owned rate limit"},{id:"attempt-"+i+"-2",number:2,startedAt:1800000000300+i*5000,firstTokenAt:1800000000500+i*5000,endedAt:1800000002000+i*5000,status:"completed",coverage:"provider-wire",inputState:"recorded",input:{model:"final-wire-model",retry:true},outputState:"recorded",output:{text:"Attempt two answer "+i},usage:{promptTokens:1234,completionTokens:200,totalTokens:1434}}]
}));
// One long conversation has seven runs. Independent Panel inference has no session.
records.push({...records[1],id:"panel-independent",traceId:"panel-process",sessionId:undefined,runId:undefined,source:"panel:video-studio",purpose:"speech",model:"panel-speech-model",stream:false,usage:undefined,startedAt:1799999900000,endedAt:1799999902000,input:{messages:[{role:"user",content:"Independent Panel speech input"}]},output:{data:{mimeType:"audio/wav",bytes:1234}},attempts:[]});
for(let i=0;i<55;i++) records.push({...records[1],id:"older-call-"+i,traceId:i===54?"panel-process":"older-run-"+i,sessionId:"older-session-"+i,runId:"older-run-"+i,startedAt:1799999000000-i*5000,endedAt:1799999002000-i*5000,attempts:[]});
const matches = (r,query) => (!query.withoutSession||!r.sessionId)&&(!query.traceId||r.traceId===query.traceId)&&(!query.sessionId||r.sessionId===query.sessionId)&&(!query.model||r.model===query.model)&&(!query.purpose||r.purpose===query.purpose)&&(!query.source||r.source===query.source)&&(!query.provider||r.provider===query.provider)&&(!query.status||r.status===query.status)&&(!query.search||JSON.stringify([r.id,r.traceId,r.sessionId,r.model,r.source]).includes(query.search));
const paginate = (items,query) => {const start=Number(query.cursor||0),limit=query.limit||50,total=items.length;return {items:items.slice(start,start+limit),total,...(start+limit<total?{nextCursor:String(start+limit)}:{})};};
window.codeshell = { listSessions:async()=>[{id:"session-original",title:"Panel Prompt audit / 核对 Panel Prompt"},...Array.from({length:55},(_,i)=>({id:"older-session-"+i,title:"Archived conversation "+i}))], listSessionTitles:async()=>({}), modelTraces: {
 sessions:async(query={})=>{window.fixture.calls.push(["sessions",query]);if(window.fixture.failList)throw new Error("Owned list failure");const groups=new Map();for(const r of records.filter(r=>matches(r,query))){const key=r.sessionId?"session:"+r.sessionId:"trace:"+r.traceId;let group=groups.get(key);if(!group){group={key,...(r.sessionId?{sessionId:r.sessionId}:{traceId:r.traceId}),latestRequestId:r.id,latestTraceId:r.traceId,startedAt:r.startedAt,updatedAt:r.endedAt||r.startedAt,callCount:0,traceCount:0,sources:[],models:[],runningCount:0,failedCount:0,traces:new Set()};groups.set(key,group);}group.callCount++;group.traces.add(r.traceId);group.traceCount=group.traces.size;group.startedAt=Math.min(group.startedAt,r.startedAt);if((r.endedAt||r.startedAt)>=group.updatedAt){group.updatedAt=r.endedAt||r.startedAt;group.latestRequestId=r.id;group.latestTraceId=r.traceId;}if(!group.sources.includes(r.source))group.sources.push(r.source);if(!group.models.includes(r.model))group.models.push(r.model);if(r.status==="running")group.runningCount++;if(r.status==="failed")group.failedCount++;}return paginate([...groups.values()].sort((a,b)=>b.updatedAt-a.updatedAt).map(({traces,...group})=>group),query);},
 list:async(query={})=>{ window.fixture.calls.push(["list",query]); if(window.fixture.failList)throw new Error("Owned list failure");return paginate(records.filter(r=>matches(r,query)).map(({input,output,attempts,...r})=>({...r,attemptCount:attempts.length})),query); },
 get:async(id)=>{window.fixture.calls.push(["get",id]);if(window.fixture.failGet)throw new Error("Owned detail failure "+"long-error/".repeat(30));const record=records.find(r=>r.id===id);return record?{record,events:[{id:"tool-event",parentId:record.id,traceId:record.traceId,kind:"tool",name:"Read source file",startedAt:record.startedAt+600,endedAt:record.startedAt+800,status:"completed",inputState:"recorded",input:{path:"/original/source.ts"},outputState:"recorded",output:"Original tool result 中文"}]}:null;},
 getConfig:async()=>window.fixture.config,
 setConfig:async(patch)=>{window.fixture.calls.push(["config",patch]);if(window.fixture.failConfig)throw new Error("Owned config failure");window.fixture.config={...window.fixture.config,...patch};return window.fixture.config;}
} };
Object.defineProperty(window,"isSecureContext",{value:true});Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.fixture.copied=text;}}});
window.mount=(lang,initial={})=>{localStorage.setItem("codeshell.uiLanguage",lang);document.documentElement.classList.toggle("dark",lang==="en");root.render(<I18nProvider key={lang+JSON.stringify(initial)}><div className="flex h-screen min-h-0 flex-col bg-background text-foreground"><div className="h-11 shrink-0 border-b px-3 py-3 text-xs">CodeShell</div><AppMainView lifecycle={null} searchLayer={null} navigation={<ActivityNavigation page="traces" onNavigate={()=>{}} taskInboxEnabled={true}/>}><ModelTracesView {...initial} onOpenSession={async id=>{window.fixture.calls.push(["openSession",id]);return false;}}/></AppMainView></div></I18nProvider>);};
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
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
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const reports = [];
const errors = [];
const labels = (lang) =>
  lang === "zh"
    ? {
        title: "执行观测",
        executions: "会话与独立调用",
        tree: "会话内执行与调用",
        detail: "调用详情",
        backList: "返回会话列表",
        backTree: "返回执行与调用",
        input: "输入",
        output: "输出",
        raw: "原始 JSON",
        refresh: "刷新记录",
        capture: "记录 Prompt 正文",
        ephemeral: "记录临时会话",
        next: "下一页",
        previous: "上一页",
        search: "搜索模型、用途、来源或编号",
        open: "打开原会话",
        wire: "最终 Provider 请求",
        copy: "复制 JSON",
      }
    : {
        title: "Execution traces",
        executions: "Sessions and standalone calls",
        tree: "Executions and calls",
        detail: "Call details",
        backList: "Back to sessions",
        backTree: "Back to executions and calls",
        input: "Input",
        output: "Output",
        raw: "Raw JSON",
        refresh: "Refresh traces",
        capture: "Record Prompt content",
        ephemeral: "Record temporary conversations",
        next: "Next page",
        previous: "Previous page",
        search: "Search model, purpose, source or ID",
        open: "Open original conversation",
        wire: "Final Provider request",
        copy: "Copy JSON",
      };
async function assertCallInView(page, requestId) {
  await page.waitForFunction((id) => {
    const button = document.querySelector(`[data-trace-request="${id}"]`);
    if (!button) return false;
    let scroller = button.parentElement;
    while (scroller && !/auto|scroll/.test(window.getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
    if (!scroller) return false;
    const rect = button.getBoundingClientRect(),
      area = scroller.getBoundingClientRect();
    const x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return (
      rect.top >= Math.max(0, area.top) - 1 &&
      rect.bottom <= Math.min(window.innerHeight, area.bottom) + 1 &&
      (hit === button || button.contains(hit))
    );
  }, requestId);
}
async function assertHeadingFocus(page, heading, message) {
  const id = await heading.getAttribute("id");
  await page.waitForFunction((id) => document.activeElement?.id === id, id);
  assert.ok(await heading.evaluate((node) => document.activeElement === node), message);
}
async function selectTree(page, text, selector) {
  const locator = page.locator(selector);
  if (!(await locator.isVisible()))
    await page.getByRole("button", { name: text.backTree, exact: true }).click();
  await locator.click();
}
try {
  for (const viewport of [
    { width: 1280, height: 820 },
    { width: 390, height: 700 },
    { width: 320, height: 360 },
  ])
    for (const lang of ["zh", "en"]) {
      const text = labels(lang),
        page = await browser.newPage({ viewport, serviceWorkers: "block" });
      page.setDefaultTimeout(7000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        route.request().url() === "http://traces.test/"
          ? route.fulfill({
              contentType: "text/html",
              body: '<style>html,body,#root{height:100%;margin:0;overflow:hidden}</style><div id="root"></div>',
            })
          : route.abort(),
      );
      await page.goto("http://traces.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((lang) => window.mount(lang), lang);
      await page.locator('[data-trace-session="session:session-original"]').waitFor();
      assert.equal(await page.locator("[data-trace-session]").count(), 50);
      assert.equal(
        await page.locator('[data-trace-session="session:session-original"]').count(),
        1,
        "All runs in one conversation occupy one session row",
      );
      if (viewport.width >= 1100) await assertCallInView(page, "request-69");
      await page.screenshot({ path: path.join(output, `sessions-${lang}-${viewport.width}.png`) });
      const regions = [
        page.getByRole("region", { name: text.executions, exact: true }),
        page.getByRole("region", { name: text.tree, exact: true }),
        page.getByRole("region", { name: text.detail, exact: true }),
      ];
      if (viewport.width >= 1100) {
        const bounds = await Promise.all(regions.map((r) => r.boundingBox()));
        assert.ok(
          bounds[0].x < bounds[1].x && bounds[1].x < bounds[2].x,
          "wide view has three columns",
        );
      } else {
        assert.equal(await regions[1].isVisible(), false);
        assert.equal(await regions[2].isVisible(), false);
      }
      await page.locator('[data-trace-session="session:session-original"]').click();
      await page.locator('[data-trace-group="execution-6"]').waitFor();
      assert.equal(await page.locator("[data-trace-group]").count(), 7);
      assert.equal(await page.locator("[data-trace-request]").count(), 70);
      assert.ok(
        await page.evaluate(() =>
          window.fixture.calls.some(
            ([method, query]) =>
              method === "list" && query.sessionId === "session-original" && !query.traceId,
          ),
        ),
        "Opening a conversation reads all its runs instead of only the latest trace",
      );
      if (viewport.width >= 1100) await assertCallInView(page, "request-69");
      await page.screenshot({ path: path.join(output, `runs-${lang}-${viewport.width}.png`) });
      await page.locator('[data-trace-request="request-0"]').click();
      await page.locator('[data-trace-detail-id="request-0"]').waitFor();
      assert.ok(
        (await page.locator('[data-trace-detail-id="request-0"]').textContent()).includes(
          "System Prompt snapshot",
        ),
      );
      await page.screenshot({ path: path.join(output, `prompt-${lang}-${viewport.width}.png`) });
      await selectTree(page, text, '[data-trace-attempt="attempt-0-1"]');
      await page.getByRole("button", { name: text.copy + " · " + text.wire, exact: true }).click();
      assert.ok(
        (await page.evaluate(() => window.fixture.copied)).includes("Final provider wire input 0"),
      );
      await page.getByRole("button", { name: text.output, exact: true }).click();
      assert.ok(
        !(await page.locator('[data-trace-detail-id="attempt-0-1"]').textContent()).includes(
          "Final recorded answer",
        ),
      );
      await selectTree(page, text, '[data-trace-attempt="attempt-0-2"]');
      assert.ok(
        (await page.locator('[data-trace-detail-id="attempt-0-2"]').textContent()).includes(
          "Attempt two answer 0",
        ),
      );
      await page.evaluate(() => {
        window.fixture.failGet = true;
      });
      await page.getByRole("button", { name: text.refresh, exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Owned detail failure" }).waitFor();
      assert.ok(
        (await page.locator('[data-trace-detail-id="attempt-0-2"]').textContent()).includes(
          "Attempt two answer 0",
        ),
      );
      await page.evaluate(() => {
        window.fixture.failGet = false;
      });
      await page.getByRole("button", { name: text.refresh, exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Owned detail failure" })
        .waitFor({ state: "hidden" });
      await selectTree(page, text, '[data-trace-event="tool-event"]');
      assert.ok(
        (await page.locator('[data-trace-detail-id="tool-event"]').textContent()).includes(
          "Original tool result 中文",
        ),
      );
      await page.getByRole("checkbox", { name: text.capture, exact: true }).uncheck();
      await page.waitForFunction(() => window.fixture.config.captureContent === false);
      await page.getByRole("checkbox", { name: text.capture, exact: true }).check();
      await page.waitForFunction(() => window.fixture.config.captureContent === true);
      await page.getByRole("checkbox", { name: text.ephemeral, exact: true }).uncheck();
      await page.waitForFunction(() => window.fixture.config.includeEphemeral === false);
      await page.getByRole("checkbox", { name: text.ephemeral, exact: true }).check();
      await page.waitForFunction(() => window.fixture.config.includeEphemeral === true);
      if (viewport.width < 1100) {
        await page.getByRole("button", { name: text.backTree, exact: true }).click();
        await assertHeadingFocus(
          page,
          regions[1].getByRole("heading", { name: text.tree, exact: true }),
          "Back from detail restores execution-tree focus",
        );
        assert.equal(
          await page.locator('[data-trace-event="tool-event"]').getAttribute("aria-pressed"),
          "true",
          "Returning to the execution tree retains the selected event",
        );
        await page.getByRole("button", { name: text.backList, exact: true }).click();
        await assertHeadingFocus(
          page,
          regions[0].getByRole("heading", { name: text.executions, exact: true }),
          "Back from executions restores session-list focus",
        );
      }
      await page.getByRole("button", { name: text.next, exact: true }).click();
      await page.locator('[data-trace-session="session:older-session-48"]').waitFor();
      assert.equal(
        await page.locator("[data-trace-session]").count(),
        7,
        "Pagination counts sessions rather than raw calls",
      );
      await page.getByRole("searchbox", { name: text.search, exact: true }).fill("request-3");
      await page.waitForFunction(
        () => document.querySelectorAll("[data-trace-session]").length === 1,
      ); // request-3 and request-30..39 all belong to one conversation
      assert.ok(
        await page
          .locator("[data-model-traces-page]")
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
        "no horizontal page overflow",
      );
      await page.getByRole("searchbox", { name: text.search, exact: true }).fill("");
      await page.locator('[data-trace-session="trace:panel-process"]').click();
      await page.locator('[data-trace-request="panel-independent"]').waitFor();
      assert.equal(
        await page.locator("[data-trace-request]").count(),
        1,
        "A session sharing a trace ID cannot enter the standalone Panel group",
      );
      await page.locator('[data-trace-request="panel-independent"]').click();
      await page
        .locator('[data-trace-detail-id="panel-independent"]')
        .getByText("Independent Panel speech input", { exact: true })
        .waitFor();
      assert.ok(
        await page.evaluate(() =>
          window.fixture.calls.some(
            ([method, query]) =>
              method === "list" &&
              query.traceId === "panel-process" &&
              query.withoutSession === true &&
              !query.sessionId,
          ),
        ),
        "Independent Panel calls use their actual trace without inventing a conversation",
      );
      await page.screenshot({
        path: path.join(output, `traces-${lang}-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
      reports.push({ lang, viewport });
      await page.close();
    }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "report.json"), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ result: "pass", cases: reports.length, output }));
} finally {
  await browser.close();
}
