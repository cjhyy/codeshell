/** Production reducer/Workbench, isolated external-tool shapes; no providers or real profile. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const development = process.argv.includes("--development");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-compact-tools-"));
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';import{initialChatState,reduceStream}from'../src/lib/streamReducer';
const noop=()=>{};window.sends=0;window.cancels=0;
function history(scope,extra,finished){let chat={...initialChatState(),items:[{kind:'user',id:'user',text:'Owned eight-command audit'}]};
for(let i=0;i<8;i++){for(const e of [{type:'stream_request_start',turnNumber:i+1},{type:'tool_use_start',toolCall:{id:'tool-'+i,toolName:['commandExecution','Bash','LinkAction'][i%3],args:{command:'Owned command '+i}}},{type:'tool_result',result:{id:'tool-'+i,result:'Owned result '+i,isError:i===6}},{type:'turn_complete',reason:'completed'}])chat=reduceStream(chat,e)}
chat=reduceStream(chat,{type:'tool_use_start',toolCall:{id:'active',toolName:'commandExecution_with_a_deliberately_very_long_name',args:{command:'Owned running command'}}});
if(finished)chat=reduceStream(chat,{type:'tool_result',result:{id:'active',result:'Owned final result'}});
if(extra){const index=chat.items.findIndex(item=>item.id==='tool-6');chat={...chat,items:[...chat.items.slice(0,index),...Array.from({length:extra},(_,i)=>({kind:'tool',id:'extra-'+i,name:'Bash',done:true,args:{command:'New owned result'}})),...chat.items.slice(index)]}}
chat={...chat,items:chat.items.map(item=>item.kind==='tool'&&item.done?{...item,args:undefined,result:undefined,summary:'Owned command '+item.id,detailRef:scope+'/'+item.id}:item)};window.sourceIds=chat.items.filter(item=>item.kind==='tool').map(item=>item.id);return chat;}
function Fixture(){const[scope,setScope]=React.useState('first'),[extra,setExtra]=React.useState(0),[finished,setFinished]=React.useState(false);window.switchScope=()=>setScope('second');window.appendCompleted=()=>setExtra(n=>n+1);window.finishActive=()=>setFinished(true);const chat=React.useMemo(()=>history(scope,extra,finished),[scope,extra,finished]);
const controller={panelSessionId:undefined,host:'desktop',workspaceApi:false,connection:'open',activeId:scope,chat,sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:'Compact tools',configuration:null,configurationVersion:0,sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:true,localDrafts:[],approvals:[{id:'owned-approval'}],approvalCount:()=>1,approvalContent:<div role='status'>Pending approval stays visible</div>,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:noop,newSession:noop,send:()=>{window.sends++;return false},stop:()=>window.cancels++,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:noop,
loadHistoryDetail:async ref=>{const response=await fetch('/detail?ref='+encodeURIComponent(ref));if(!response.ok)throw Error('Owned read failed');return response.json()}};return <Workbench controller={controller}/>};
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
});
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const reports = [],
  errors = [],
  blocked = [];
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: theme,
      serviceWorkers: "block",
    });
    const reads = [];
    let held;
    await context.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== "http://compact-tools-owned.test") {
        blocked.push(url.href);
        return route.abort();
      }
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
        });
      if (url.pathname === "/api/v1/environment")
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      if (url.pathname !== "/detail" || request.method() !== "GET") {
        blocked.push(url.href);
        return route.abort();
      }
      const ref = url.searchParams.get("ref");
      reads.push(ref);
      if (ref === "first/tool-1") {
        held = route;
        return;
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ args: { command: "ARG_" + ref }, result: "RESULT_" + ref }),
      });
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://compact-tools-owned.test/");
      for (const file of bundle.outputFiles.filter((f) => f.path.endsWith(".css")))
        await page.addStyleTag({ content: file.text });
      await page.addScriptTag({
        content: bundle.outputFiles.find((f) => f.path.endsWith(".js")).text,
      });
      await page.getByText("Owned eight-command audit", { exact: true }).waitFor();
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const metrics = await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".transcript > .msg.tool")];
          const rects = rows.map((row) => {
            const r = row.getBoundingClientRect();
            const summary = row.querySelector(".message-tool-card > summary"),
              s = summary.getBoundingClientRect();
            return {
              height: r.height,
              top: r.top,
              bottom: r.bottom,
              touchHeight: s.height,
              width: s.width,
            };
          });
          return {
            cards: rows.length,
            totalHeight: rects.at(-1).bottom - rects[0].top,
            rects,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        reports.push({ theme, width, ...metrics });
        console.log(
          JSON.stringify({ phase: "collapsed-layout", development, theme, width, ...metrics }),
        );
        await page.screenshot({ path: path.join(output, `${theme}-${width}-collapsed.png`) });
        assert.equal(
          metrics.cards,
          4,
          "six successful CLI records fold, with failed/last-success/running independent",
        );
        assert.ok(metrics.totalHeight <= 210, "collapsed tool region stays compact");
        assert.ok(metrics.scrollWidth <= width);
        for (const rect of metrics.rects) assert.ok(rect.touchHeight >= 44 && rect.height <= 48);
        for (let i = 1; i < metrics.rects.length; i++)
          assert.ok(metrics.rects[i].top - metrics.rects[i - 1].bottom <= 6.1);
      }
      assert.deepEqual(reads, []);
      assert.equal(await page.getByText("失败", { exact: true }).count(), 1);
      assert.equal(await page.getByText("执行中", { exact: true }).count(), 1);
      assert.equal(
        await page.getByText("Pending approval stays visible", { exact: true }).count(),
        1,
      );
      const group = page.locator(".message-tool-records").first();
      await group.locator(":scope > summary").tap();
      await group.locator(".message-tool-card").first().waitFor();
      assert.equal(await group.locator(".message-tool-card").count(), 6);
      assert.deepEqual(reads, [], "opening the list never fetches its detail bodies");
      assert.deepEqual(
        await group.locator(".message-tool-card .message-tool-summary").allTextContents(),
        [
          "Owned command tool-0",
          "Owned command tool-1",
          "Owned command tool-2",
          "Owned command tool-3",
          "Owned command tool-4",
          "Owned command tool-5",
        ],
      );
      for (const summary of await group.locator(".message-tool-card > summary").all())
        assert.ok((await summary.boundingBox()).height >= 44);
      const first = group.locator(".message-tool-card").nth(0);
      await first.locator("summary").tap();
      await first.getByText("RESULT_first/tool-0", { exact: true }).waitFor();
      assert.deepEqual(reads, ["first/tool-0"]);
      await first.evaluate((node) => {
        window.originalTool = node;
      });
      await page.evaluate(() => window.appendCompleted());
      await group.getByText("工具记录 · 7 项已完成", { exact: true }).waitFor();
      assert.equal(await first.evaluate((node) => node === window.originalTool), true);
      assert.notEqual(await first.getAttribute("open"), null);
      assert.equal(await first.getByText("RESULT_first/tool-0", { exact: true }).count(), 1);
      assert.deepEqual(
        reads,
        ["first/tool-0"],
        "appending records retains opened detail without a read",
      );
      await first.locator("summary").tap();
      await first.getByText("RESULT_first/tool-0", { exact: true }).waitFor({ state: "detached" });
      const single = page
        .locator(".message-tool-single .message-tool-card")
        .filter({ has: page.getByText("Owned command tool-7", { exact: true }) });
      await single.locator("summary").tap();
      await single.getByText("RESULT_first/tool-7", { exact: true }).waitFor();
      await single.evaluate((node) => {
        window.originalSingle = node;
      });
      await page.evaluate(() => window.finishActive());
      const promoted = page.locator(".message-tool-records").nth(1);
      await promoted.getByText("工具记录 · 2 项已完成", { exact: true }).waitFor();
      assert.notEqual(await promoted.getAttribute("open"), null);
      const promotedTool = promoted.locator(".message-tool-card").first();
      assert.equal(await promotedTool.evaluate((node) => node === window.originalSingle), true);
      assert.notEqual(await promotedTool.getAttribute("open"), null);
      assert.equal(await promotedTool.getByText("RESULT_first/tool-7", { exact: true }).count(), 1);
      assert.deepEqual(
        reads,
        ["first/tool-0", "first/tool-7"],
        "single-to-group preserves the mounted detail without refetching",
      );
      const pending = group.locator(".message-tool-card").nth(1);
      const requested = page.waitForRequest(
        (r) => new URL(r.url()).searchParams.get("ref") === "first/tool-1",
      );
      await pending.locator("summary").tap();
      await requested;
      await pending.getByRole("status").waitFor();
      assert.ok(held);
      await page.evaluate(() => window.switchScope());
      await page.waitForFunction(
        () => !document.querySelector(".message-tool-records")?.hasAttribute("open"),
      );
      await held.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ result: "LATE_OLD_SCOPE_RESULT" }),
      });
      held = undefined;
      assert.equal(await page.getByText("LATE_OLD_SCOPE_RESULT", { exact: true }).count(), 0);
      assert.equal(await page.locator(".message-tool-section").count(), 0);
      assert.deepEqual(await page.evaluate(() => window.sourceIds), [
        "tool-0",
        "tool-1",
        "tool-2",
        "tool-3",
        "tool-4",
        "tool-5",
        "extra-0",
        "tool-6",
        "tool-7",
        "active",
      ]);
      assert.equal(await page.evaluate(() => window.sends), 0);
      assert.equal(await page.evaluate(() => window.cancels), 0);
      reports.push({
        theme,
        detailReads: reads,
        lateScopeRejected: true,
        recordOrderPreserved: true,
        appendAndPromotionRetainMountedDetails: true,
        modelSends: 0,
        cancels: 0,
      });
    } finally {
      if (held) await held.fulfill({ status: 410, body: "Owned fixture closed" });
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(
      {
        ok: true,
        development,
        physicalPhoneTested: false,
        actualHostTested: false,
        source: "Production reducer + Workbench with isolated owned HTTP detail fixtures",
        reports,
        errors,
        blocked,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, development, output, reports }));
} finally {
  await browser.close();
}
