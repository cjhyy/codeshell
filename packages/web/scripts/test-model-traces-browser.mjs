/* Owned model-history fixture. All nonfixture browser network requests are blocked. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const web = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(web, "../desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = process.env.CODESHELL_TRACE_WEB_QA_DIR || "/tmp/codeshell-web-model-traces-qa";
await mkdir(output, { recursive: true });
const source = `
import React from "react";
import {createRoot} from "react-dom/client";
import {ModelTraceExplorer} from "./components/ModelTraceExplorer";
window.fixture={fail:false,failTrace:false,copied:"",reads:[]};
Object.defineProperty(navigator,"clipboard",{value:{writeText:async(text)=>{window.fixture.copied=text}}});
const record=(i)=>({version:1,id:"request-"+i,traceId:"trace-"+Math.floor(i/2),sessionId:"session-"+Math.floor(i/2),source:"desktop",purpose:"main",provider:"fixture",model:"fixture-model",startedAt:1800000000000+i*100,endedAt:1800000000040+i*100,status:"completed",stream:true,inputState:"recorded",input:{systemPrompt:"Original actual system Prompt <script>window.injected=true</script>",messages:[{role:"user",content:"Actual input "+i}],tools:[],parameters:{temperature:0.2}},outputState:"recorded",output:{text:"Actual answer "+i},usage:{promptTokens:10,completionTokens:5,totalTokens:15},attempts:[{id:"attempt-"+i,number:1,startedAt:1800000000000,endedAt:1800000000020,status:"failed",httpStatus:429,coverage:"provider-wire",inputState:"recorded",input:{model:"effective-wire-model",prompt:"Actual provider prompt"},outputState:"recorded",output:{text:"Partial attempt answer"},error:"Owned rate limit"}]});
const records=Array.from({length:54},(_,i)=>record(i));
const api={list:async(q={})=>{window.fixture.reads.push(q);if(q.traceId&&window.fixture.failTrace)throw new Error("Owned tree read failure");let rows=records.filter(r=>(!q.traceId||r.traceId===q.traceId)&&(!q.search||r.id.includes(q.search))&&(!q.sessionId||r.sessionId===q.sessionId)&&(!q.model||r.model===q.model));const offset=Number(q.cursor||0),limit=q.limit||50;return{items:rows.slice(offset,offset+limit).map(({input,output,attempts,...r})=>({...r,attemptCount:attempts.length})),total:rows.length,nextCursor:offset+limit<rows.length?String(offset+limit):undefined}},get:async(id)=>{if(window.fixture.fail)throw new Error("Owned refresh failure");return{record:records.find(r=>r.id===id),events:[{id:"tool-event",traceId:records.find(r=>r.id===id).traceId,kind:"tool",name:"Read fixture",startedAt:1800000000000,endedAt:1800000000030,status:"completed",inputState:"recorded",input:{path:"/original/project"},outputState:"recorded",output:"Recorded tool output"}]}},getConfig:async()=>({enabled:true,captureContent:false,includeEphemeral:false,retentionDays:7})};
createRoot(document.getElementById("root")).render(<ModelTraceExplorer api={api} lang={new URL(location.href).searchParams.get("lang")||"zh"}/>);
`;
const result = await build({
  stdin: { contents: source, loader: "tsx", resolveDir: path.join(web, "src") },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const html = `<!doctype html><html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0;font-family:system-ui}#root{display:flex;flex-direction:column}</style><div id="root"></div><script>${result.outputFiles[0].text}</script></html>`;
const browser = await chromium.launch({
  executablePath: process.env.CODESHELL_TEST_CHROMIUM,
  headless: true,
});
const results = [];
try {
  for (const lang of ["zh", "en"])
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 540 },
      { width: 320, height: 360 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === "http://model-traces.fixture.invalid"
          ? route.fulfill({ contentType: "text/html", body: html })
          : route.abort(),
      );
      await page.goto(`http://model-traces.fixture.invalid/?lang=${lang}`);
      const list = page.locator(".cs-t-pane").nth(0);
      try {
        await list.locator(".cs-t-item").first().waitFor();
      } catch (error) {
        console.error(
          JSON.stringify({ lang, viewport, errors, text: await page.locator("body").innerText() }),
        );
        await page.screenshot({ path: path.join(output, `failed-${lang}-${viewport.width}.png`) });
        throw error;
      }
      await list.locator(".cs-t-item").first().click();
      const tree = page.locator(".cs-t-pane").nth(1);
      await tree.locator(".cs-t-item").first().click();
      const detail = page.locator(".cs-t-pane").nth(2);
      await detail.getByText("Original actual system Prompt", { exact: false }).waitFor();
      assert.equal(
        await page.evaluate(() => window.injected),
        undefined,
        "Prompt HTML remains inert text",
      );
      await detail
        .getByRole("button", { name: lang === "zh" ? "复制 JSON" : "Copy JSON", exact: true })
        .click();
      assert.ok(await page.evaluate(() => window.fixture.copied.includes("Actual input 0")));
      if (viewport.width <= 1000)
        await detail
          .getByRole("button", { name: lang === "zh" ? "返回" : "Back", exact: true })
          .click();
      await tree
        .getByRole("button", {
          name: lang === "zh" ? "尝试 1 · 429 · failed" : "Attempt 1 · 429 · failed",
          exact: true,
        })
        .click();
      await detail.getByText("Actual provider prompt", { exact: false }).waitFor();
      await page.evaluate(() => {
        window.fixture.fail = true;
      });
      await page
        .getByRole("button", { name: lang === "zh" ? "刷新" : "Refresh", exact: true })
        .click();
      await detail.getByRole("alert").waitFor();
      await detail.getByText("Partial attempt answer", { exact: false }).waitFor();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        "No horizontal viewport overflow",
      );
      assert.ok(
        await detail.evaluate((node) => node.getBoundingClientRect().height > 100),
        "The detail remains usable below compact filters",
      );
      await page.screenshot({ path: path.join(output, `traces-${lang}-${viewport.width}.png`) });
      if (viewport.width <= 1000)
        await detail
          .getByRole("button", { name: lang === "zh" ? "返回" : "Back", exact: true })
          .click();
      await tree
        .getByRole("button", { name: "tool · Read fixture · completed", exact: true })
        .click();
      await detail.getByText("Recorded tool output", { exact: true }).waitFor();
      if (viewport.width <= 1000) {
        await detail
          .getByRole("button", { name: lang === "zh" ? "返回" : "Back", exact: true })
          .click();
        await tree
          .getByRole("button", { name: lang === "zh" ? "返回" : "Back", exact: true })
          .click();
      }
      await list
        .getByRole("button", { name: lang === "zh" ? "下一页" : "Next page", exact: true })
        .click();
      await page.waitForFunction(() => window.fixture.reads.some((query) => query.cursor === "50"));
      await page.waitForFunction(() =>
        document.querySelector(".cs-t-pane .cs-t-item")?.textContent.includes("trace-25"),
      );
      await page.evaluate(() => {
        window.fixture.fail = false;
        window.fixture.failTrace = true;
      });
      await list.locator(".cs-t-item").first().click();
      await tree.getByRole("alert").waitFor();
      assert.ok(
        (await tree.innerText()).includes("Owned tree read failure"),
        "Tree failures are visible on narrow screens",
      );
      assert.ok(
        !(await detail.innerText()).includes("Actual input 0"),
        "Changing execution clears the previous Prompt",
      );
      await page.evaluate(() => {
        window.fixture.failTrace = false;
      });
      await tree
        .getByRole("button", { name: lang === "zh" ? "刷新" : "Refresh", exact: true })
        .click();
      await tree.locator(".cs-t-item").first().waitFor();
      assert.deepEqual(errors, []);
      results.push({ lang, viewport, passed: true });
      await page.close();
    }
} finally {
  await browser.close();
}
await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ output, cases: results.length, passed: true }));
