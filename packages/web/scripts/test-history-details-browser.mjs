/** Actual Workbench deferred detail UI; isolated synthetic sessions and an owned HTTP fixture only. */
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
const output = await mkdtemp(path.join(tmpdir(), "codeshell-history-details-"));
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';
const noop=()=>{};window.sends=0;window.earlierCalls=0;window.reloads=0;
function Fixture(){const[scope,setScope]=React.useState('first');const[live,setLive]=React.useState(0);window.appendLive=()=>setLive(n=>n+1);const[older,setOlder]=React.useState(false),[earlierError,setEarlierError]=React.useState('');window.switchScope=()=>setScope('second');
const items=[...(older?[{kind:'user',id:'earlier',text:'Earlier record '+'owned '.repeat(800)}]:[]),{kind:'user',id:'user',text:'Original task',attachments:[{name:'owned.txt',size:4}]},
...Array.from({length:4},(_,i)=>({kind:'tool',id:'tool-'+i,name:'Read '+i,done:true,summary:'Owned step '+i,activityGroupKey:scope+'/run/turn/main',detailRef:scope+'/tool-'+i})),
{kind:'tool',id:'error',name:'Failed step',done:true,error:true,summary:'Visible failure',detailRef:scope+'/error'},
{kind:'tool',id:'running',name:'Running step',done:false,args:{query:'still active'}},
{kind:'assistant',id:'answer',text:'Original complete answer.',reasoning:'',reasoningDetailRef:scope+'/reasoning',done:true},{kind:'assistant',id:'long',text:'Large text preview',textDetailRef:scope+'/text',reasoning:'',done:true},...Array.from({length:live},(_,i)=>({kind:'assistant',id:'live-'+i,text:'Fresh output '+i,done:true}))];
const controller={host:'desktop',workspaceApi:false,connection:'open',activeId:scope,chat:{items,run:'running'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:'Owned history',configuration:null,configurationVersion:0,sessionsVersion:0,draft:'Preserved draft',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:true,localDrafts:[],approvals:[{id:'approval'}],approvalCount:()=>1,approvalContent:<div role='status'>Approval remains visible</div>,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:noop,newSession:noop,send:()=>{window.sends++;return false},stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:noop,
historyHasEarlier:!older,historyEarlierError:earlierError,loadEarlierHistory:async()=>{window.earlierCalls++;if(window.earlierCalls===1){setEarlierError('Owned earlier retry');throw new Error('Owned earlier retry');}setOlder(true);setEarlierError('');},reloadHistory:()=>window.reloads++,loadHistoryDetail:async ref=>{const response=await fetch('/detail?ref='+encodeURIComponent(ref));if(!response.ok)throw new Error('Owned detail temporarily unavailable');return response.json();}};
return <Workbench controller={controller}/>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"development"' },
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
    const reads = [],
      attempts = new Map();
    let held;
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://history-detail-owned.test") {
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
      if (url.pathname !== "/detail" || route.request().method() !== "GET") {
        blocked.push(url.href);
        return route.abort();
      }
      const ref = url.searchParams.get("ref");
      reads.push(ref);
      attempts.set(ref, (attempts.get(ref) ?? 0) + 1);
      if (ref === "first/tool-3") {
        held = route;
        return;
      }
      if (ref === "first/tool-2" && attempts.get(ref) === 1)
        return route.fulfill({ status: 503, body: "Owned temporary failure" });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          args: { ownedParameter: "ARGUMENT_" + ref },
          result: "RESULT_" + ref + "\n<script>window.forbiddenExecution=true</script>",
          reasoning: "REASONING_" + ref,
          text: "FULL_TEXT_" + ref,
        }),
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://history-detail-owned.test/");
    for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css")))
      await page.addStyleTag({ content: file.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
    });
    const group = page.locator(".message-tool-group");
    await group.waitFor();
    assert.equal(
      await group.locator(":scope > summary").textContent(),
      "✓已完成 4 项操作Read 0 · Read 1 · Read 2",
    );
    assert.equal(await page.locator(".message-tool-card").count(), 3);
    assert.deepEqual(reads, []);
    for (const text of [
      "Original task",
      "Original complete answer.",
      "📎 owned.txt",
      "Approval remains visible",
      "Failed step",
      "Running step",
    ])
      assert.equal(await page.getByText(text, { exact: true }).count(), 1, text);
    assert.equal(await page.locator(".message-tool-section").count(), 0);
    await page.getByRole("button", { name: "读取更早记录", exact: true }).tap();
    const retryEarlier = page.getByRole("button", { name: "重试读取更早记录", exact: true });
    await retryEarlier.waitFor();
    await retryEarlier.scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        ),
    );
    const original = page.getByText("Original task", { exact: true });
    await retryEarlier.evaluate((button) => {
      // Capture after Chromium brings the touch target into view, immediately
      // before the actual click asks React to prepend the owned page.
      button.addEventListener(
        "click",
        () => {
          const list = document.querySelector(".messages");
          const original = [...list.querySelectorAll(".msg")].find(
            (node) => node.textContent === "Original task📎 owned.txt",
          );
          window.earlierAnchorOffset =
            original.getBoundingClientRect().top - list.getBoundingClientRect().top;
        },
        { capture: true, once: true },
      );
    });
    await retryEarlier.tap();
    await page.getByText("Earlier record", { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelector(".message-earlier-history") === null);
    const afterEarlier = await original.evaluate(
      (node) =>
        node.closest(".msg").getBoundingClientRect().top -
        document.querySelector(".messages").getBoundingClientRect().top,
    );
    const beforeEarlier = await page.evaluate(() => window.earlierAnchorOffset);
    assert.ok(
      Math.abs(afterEarlier - beforeEarlier) < 2,
      `earlier page preserves reading position: ${beforeEarlier} -> ${afterEarlier}`,
    );

    await page.evaluate(() => window.appendLive());
    await page.getByText("Fresh output 0", { exact: true }).waitFor();
    const afterLive = await original.evaluate(
      (node) =>
        node.closest(".msg").getBoundingClientRect().top -
        document.querySelector(".messages").getBoundingClientRect().top,
    );
    assert.ok(
      Math.abs(afterLive - beforeEarlier) < 2,
      "new output cannot resume following while reading an earlier page",
    );
    // Explicit keyboard scrolling releases the held anchor and restores normal
    // near-bottom following; opening a detail alone never does this.
    const messages = page.getByRole("region", { name: "消息列表", exact: true });
    await messages.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => {
      const node = document.querySelector(".messages");
      return node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
    });
    await page.evaluate(() => window.appendLive());
    await page.getByText("Fresh output 1", { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector(".messages");
      return node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
    });

    await group.locator(":scope > summary").tap();
    await group.locator(".message-tool-card").first().waitFor();
    assert.equal(await group.locator(".message-tool-card").count(), 4);
    assert.deepEqual(reads, [], "expanding the activity list fetches no bodies");
    const tool = (index) => group.locator(".message-tool-card").nth(index);
    await tool(0).locator("summary").tap();
    await tool(0).getByText("RESULT_first/tool-0", { exact: false }).waitFor();
    assert.deepEqual(reads, ["first/tool-0"]);
    assert.equal(await tool(0).getByRole("button", { name: "复制结果" }).count(), 1);
    assert.equal(await page.evaluate(() => window.forbiddenExecution), undefined);
    await tool(0).locator("summary").tap();
    await tool(0).locator(".message-tool-section").first().waitFor({ state: "detached" });
    assert.equal(await page.getByText("RESULT_first/tool-0", { exact: false }).count(), 0);
    await tool(2).locator("summary").tap();
    await tool(2).getByRole("alert").waitFor();
    await tool(2).getByRole("button", { name: "重新载入会话", exact: true }).tap();
    assert.equal(await page.evaluate(() => window.reloads), 1);

    await tool(2).getByRole("button", { name: "重试读取详情" }).tap();
    await tool(2).getByText("RESULT_first/tool-2", { exact: false }).waitFor();
    assert.equal(attempts.get("first/tool-2"), 2);
    await tool(3).locator("summary").tap();
    await tool(3).getByRole("status").waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll(".message-detail-status").length > 0,
    );
    for (let i = 0; !held && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(held, "owned delayed detail request was received");
    await page.evaluate(() => window.switchScope());
    await page.waitForFunction(
      () => !document.querySelector(".message-tool-group")?.hasAttribute("open"),
    );
    await held.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ result: "LATE_OLD_SESSION_RESULT" }),
    });
    assert.equal(await page.getByText("LATE_OLD_SESSION_RESULT", { exact: true }).count(), 0);
    assert.equal(await group.getAttribute("open"), null);
    assert.equal(await page.locator(".message-tool-section").count(), 0);
    const reasoning = page.locator(".message-reasoning");
    await reasoning.locator("summary").tap();
    await reasoning.getByText("REASONING_second/reasoning", { exact: true }).waitFor();
    await reasoning.locator("summary").tap();
    await reasoning.locator("pre").waitFor({ state: "detached" });
    const fullText = page.locator(".message-full-text");
    assert.equal(await page.getByText("Large text preview", { exact: true }).count(), 1);
    assert.ok(!reads.includes("second/text"), "oversized text is not prefetched");
    assert.equal(
      await page.getByRole("button", { name: "复制已显示内容", exact: true }).count(),
      1,
    );
    assert.equal(
      await page
        .getByText("Original complete answer.", { exact: true })
        .locator("..")
        .getByRole("button", { name: "复制回复", exact: true })
        .count(),
      1,
    );
    await fullText.locator("summary").tap();
    await fullText.getByText("FULL_TEXT_second/text", { exact: true }).waitFor();
    assert.equal(await page.getByText("Large text preview", { exact: true }).count(), 0);
    assert.equal(await fullText.getByRole("button", { name: "复制回复", exact: true }).count(), 1);
    await fullText.locator("summary").tap();
    await fullText
      .getByText("FULL_TEXT_second/text", { exact: true })
      .waitFor({ state: "detached" });
    assert.equal(await page.getByText("Large text preview", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Original complete answer.", { exact: true }).count(), 1);
    assert.equal(
      await page.getByRole("textbox", { name: "任务内容" }).inputValue(),
      "Preserved draft",
    );
    assert.equal(await page.evaluate(() => window.sends), 0);
    await page.screenshot({ path: path.join(output, `${theme}-grouped-history.png`) });
    reports.push({
      theme,
      reads,
      groupCount: 1,
      retiredOldResponse: true,
      fullTextOnDemand: true,
      earlierAnchorPreserved: true,
      modelCalls: 0,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ output, reports, errors, blocked }, null, 2));
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
