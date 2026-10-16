/* Real detail → grouped siblings → exact transcript, using production CSS. */
/* global document, window, requestAnimationFrame, Event, getComputedStyle */
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
const output = "/tmp/codeshell-subagent-detail-list-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {SubagentSessionDetail} from './subagents/SubagentSessionDetail';
  import {I18nProvider,useT} from './i18n/I18nProvider';
  import {saveUILanguage} from './uiLanguage';
  const ids=['active','completed','failed','paused','cancelled'];
  const now=Date.now();
  const names={
    zh:['Link 调研：追踪 Figma 读取链','实现会话导航并整理验证结果','检查权限边界与异常恢复','等待设计确认：'+('LongUnbrokenTaskTitle').repeat(10),'已取消的资料收集任务'],
    en:['Link research: trace the Figma reading flow','Implement session navigation and report validation','Inspect permission boundaries and recovery','Waiting for design review: '+('LongUnbrokenTaskTitle').repeat(10),'Cancelled source collection'],
  };
  let options={};
  function title(index){return index===3&&options.presentation?(options.lang==='zh'?'等待设计确认':'Waiting for design review'):names[options.lang][index]}
  function raw(id){return [
    {kind:'user',text:'Exact transcript '+id},
    ...(id==='child-nested'?[
      {kind:'stream',event:{type:'agent_start',agentId:'grandchild-one',name:'Nested explorer',description:'Investigate nested source'}},
      {kind:'stream',event:{type:'agent_end',agentId:'grandchild-one',description:'Investigate nested source'}},
    ]:[
      {kind:'stream',event:{type:'stream_request_start',turnNumber:0}},
      {kind:'stream',event:{type:'text_delta',text:options.lang==='zh'?'已梳理页面导航与数据读取链，验证结果保留在当前对话。':'Mapped the navigation and data reading flow. Validation results are retained in this conversation.'}},
      {kind:'stream',event:{type:'assistant_message',message:{role:'assistant',content:options.lang==='zh'?'已梳理页面导航与数据读取链，验证结果保留在当前对话。':'Mapped the navigation and data reading flow. Validation results are retained in this conversation.'}}},
      {kind:'stream',event:{type:'turn_complete',reason:'completed'}},
    ]),
  ];}
  function catalog(parent,cursor){
    if(parent==='child-nested')return {sessions:['grandchild-one','grandchild-two'].map(id=>({id,engineSessionId:id,title:'Nested '+id,parentSessionId:parent,status:'completed',updatedAt:now-60000})),nextCursor:null};
    if(parent==='new-parent')return {sessions:[{id:'new-child',engineSessionId:'new-child',title:'Current child',parentSessionId:parent,status:'completed',updatedAt:now-60000}],nextCursor:null};
    const rows=ids.map((id,index)=>({id,engineSessionId:id,title:title(index),parentSessionId:parent,status:id,updatedAt:now-(index+1)*60000}));
    return cursor?{sessions:rows.slice(3),nextCursor:null}:{sessions:[...rows.slice(0,3),{id:'foreign',engineSessionId:'foreign',title:'FOREIGN PARENT',parentSessionId:'foreign-parent',status:'active',updatedAt:now}],nextCursor:'page-two'};
  }
  window.codeshell={
    listDiskSessions:async(query)=>{
      window.actions.push(['catalog',query]);
      if(options.catalogError)throw new Error('Catalog unavailable: '+('long-error-without-spaces').repeat(30));
      if(options.delay&&query.parentSessionId==='old-parent')return new Promise(resolve=>window.resolveOldCatalog=()=>resolve({sessions:[{id:'old-child',engineSessionId:'old-child',title:'STALE CATALOG',parentSessionId:'old-parent',status:'active'}],nextCursor:null}));
      return catalog(query.parentSessionId,query.cursor);
    },
    getSessionTranscript:async(id)=>{
      window.actions.push(['transcript',id]);
      if(options.delay&&id==='old-child')return new Promise(resolve=>window.resolveOldTranscript=()=>resolve([{kind:'user',text:'STALE TRANSCRIPT'}]));
      return raw(id);
    },
  };
  function Fixture({initial}){
    const {t}=useT();
    const [props,setProps]=React.useState(initial);
    options=props;
    window.updateFixture=next=>setProps(current=>({...current,...next}));
    window.fixtureLabels={hint:t('msg.agent.openFromChat')};
    const agents=React.useMemo(()=>ids.map((id,index)=>({id,name:title(index),description:'Task '+id,done:id!=='active',error:id==='failed'?'Permission denied':undefined,startedAt:now-(index+1)*100000,endedAt:id==='active'?undefined:now-(index+1)*50000})),[props.lang,props.presentation]);
    return <main className="fixed inset-0 flex min-h-0 min-w-0 items-stretch justify-center bg-muted/30 text-foreground">
      <div id="detail-pane" style={{width:props.paneWidth}} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-x border-border bg-background">
        <SubagentSessionDetail agentId={props.agentId} parentSessionId={props.parentSessionId} label={props.agentId==='child-nested'?'Parent explorer':undefined}
          agents={props.agentId==='completed'||props.agentId==='active'?agents:[]} running={props.agentId==='active'} active={props.active!==false} onBack={()=>window.actions.push(['external-back'])}/>
      </div>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));let generation=0;
  window.renderFixture=props=>{
    localStorage.clear();saveUILanguage(props.lang);document.documentElement.classList.toggle('dark',props.mode==='dark');window.actions=[];options=props;
    window.resolveOldCatalog=undefined;window.resolveOldTranscript=undefined;
    root.render(<I18nProvider key={++generation}><Fixture initial={props}/></I18nProvider>);
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
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
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
  args: ["--disable-background-networking", "--disable-component-update", "--no-pings"],
});
const failures = [],
  errors = [],
  blocked = [],
  reports = [];
const context = await browser.newContext({ reducedMotion: "reduce", serviceWorkers: "block" });
await context.route("**/*", (route) => {
  if (route.request().url() === "http://subagent-list.test/")
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
    });
  blocked.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(5000);
await page.goto("http://subagent-list.test/");
const pane = page.locator("#detail-pane");
async function settle() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function render(extra = {}) {
  await page.evaluate((props) => window.renderFixture(props), {
    lang: "zh",
    mode: "light",
    paneWidth: 620,
    agentId: "completed",
    parentSessionId: "parent",
    ...extra,
  });
  await settle();
}
async function actions(kind) {
  return page.evaluate((type) => window.actions.filter((item) => item[0] === type), kind);
}
async function geometry(label) {
  const result = await pane.evaluate((element) => ({
    pageWidth: window.innerWidth,
    pageScroll: document.documentElement.scrollWidth,
    paneWidth: element.clientWidth,
    paneScroll: element.scrollWidth,
    listWidth: element.querySelector("[data-subagent-list]")?.clientWidth,
    listScroll: element.querySelector("[data-subagent-list]")?.scrollWidth,
  }));
  assert.ok(result.pageScroll <= result.pageWidth + 1, `${label}: page has no horizontal overflow`);
  assert.ok(
    result.paneScroll <= result.paneWidth + 1,
    `${label}: panel has no horizontal overflow`,
  );
  if (result.listWidth)
    assert.ok(
      result.listScroll <= result.listWidth + 1,
      `${label}: list has no horizontal overflow`,
    );
  return result;
}
async function reachable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      visible:
        box.top >= 0 &&
        box.bottom <= window.innerHeight + 1 &&
        box.left >= 0 &&
        box.right <= window.innerWidth + 1,
      hit: element === hit || element.contains(hit),
    };
  });
  assert.ok(result.visible && result.hit, `${label}: fully visible and reachable`);
}
async function capture(name) {
  await page.evaluate(() => document.activeElement?.blur());
  await settle();
  await pane.screenshot({ path: path.join(output, name + ".png"), animations: "disabled" });
}
async function run(label, task) {
  try {
    await task();
    reports.push({ label, result: "pass" });
  } catch (error) {
    failures.push({ label, error: error.stack });
    await page.screenshot({ path: path.join(output, `failure-${label}.png`) });
    if (process.argv.includes("--fail-fast")) throw error;
  }
}
try {
  for (const lang of ["zh", "en"])
    for (const mode of ["light", "dark"])
      for (const paneWidth of [620, 320]) {
        const label = `${lang}-${mode}-${paneWidth}`;
        await run(label, async () => {
          await page.setViewportSize({ width: 800, height: paneWidth === 320 ? 360 : 620 });
          await render({ lang, mode, paneWidth });
          await pane.getByText("Exact transcript completed", { exact: true }).waitFor();
          assert.equal(
            await pane.locator("[data-subagent-list]").count(),
            0,
            `${label}: direct opens conversation`,
          );
          await capture(`direct-${label}`);
          const back = pane.locator('[data-subagent-action="back-to-list"]').first();
          await reachable(back, label);
          await back.focus();
          await back.press("Enter");
          await pane.locator('[data-subagent-list-id="cancelled"]').waitFor();
          await settle();
          assert.deepEqual(
            await pane
              .locator("[data-subagent-list-status]")
              .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("data-subagent-list-status")),
              ),
            ["active", "completed", "failed", "paused", "cancelled"],
          );
          assert.equal(
            await pane.locator('[data-subagent-list-id="foreign"]').count(),
            0,
            `${label}: foreign parent excluded`,
          );
          assert.equal(await pane.getByRole("combobox").count(), 0, `${label}: no legacy picker`);
          assert.equal(
            await pane.locator("[data-tool-name],.cs-agent-tool-list,.cs-agent-operation").count(),
            0,
            `${label}: list contains no tool logs`,
          );
          assert.deepEqual(
            await actions("transcript"),
            [["transcript", "completed"]],
            `${label}: list never reads a transcript`,
          );
          assert.ok(
            (await actions("catalog")).every((item) => item[1].parentSessionId === "parent"),
          );
          assert.equal(
            await pane
              .locator('[data-subagent-list-id="active"] [data-subagent-time-kind="elapsed"]')
              .count(),
            1,
          );
          assert.equal(
            await pane
              .locator('[data-subagent-list-id="completed"] [data-subagent-time-kind="completed"]')
              .count(),
            1,
          );
          await geometry(label);
          const titleHeight = await pane
            .locator('[data-subagent-list-id="paused"] > span:nth-child(2) > span')
            .evaluate((element) => ({
              height: element.getBoundingClientRect().height,
              lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
            }));
          assert.ok(
            titleHeight.height <= titleHeight.lineHeight * 2 + 1,
            `${label}: long title is limited to two lines`,
          );
          await capture(`list-${label}`);
          if (label === "zh-light-620")
            console.log(`First list preview: ${path.join(output, `list-${label}.png`)}`);
          const last = pane.locator('[data-subagent-list-id="cancelled"]');
          await reachable(last, `${label} final row`);
          await last.focus();
          assert.equal(await last.evaluate((element) => document.activeElement === element), true);
          await pane.screenshot({
            path: path.join(output, `keyboard-${label}.png`),
            animations: "disabled",
          });
          await last.press("Enter");
          await pane.getByText("Exact transcript cancelled", { exact: true }).waitFor();
          assert.equal(await pane.locator("[data-subagent-list]").count(), 0);
          assert.deepEqual(
            (await actions("transcript")).map((item) => item[1]),
            ["completed", "cancelled"],
          );
          await geometry(`${label} sibling`);
        });
      }
  await run("hidden-list", async () => {
    await page.setViewportSize({ width: 800, height: 520 });
    await render();
    await pane.getByText("Exact transcript completed", { exact: true }).waitFor();
    await pane.locator('[data-subagent-action="back-to-list"]').click();
    await pane.locator('[data-subagent-list-id="active"]').waitFor();
    await settle();
    await page.evaluate(() => window.updateFixture({ active: false }));
    await settle();
    assert.equal(await pane.locator("[data-subagent-list]").getAttribute("inert"), "");
    assert.equal(await pane.locator('[data-subagent-list-id="active"]').isDisabled(), true);
    const before = await page.evaluate(() => JSON.stringify(window.actions));
    await page.evaluate(() => window.dispatchEvent(new Event("codeshell:files-changed")));
    await page.waitForTimeout(3100);
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.actions)),
      before,
      "hidden list pauses events and polling",
    );
    await page.evaluate(() => window.updateFixture({ active: true }));
    await pane.locator('[data-subagent-list-id="active"]:enabled').waitFor();
    await settle();
    assert.equal(
      (await actions("transcript")).length,
      1,
      "reopening list still avoids transcript reads",
    );
    assert.ok(
      (await actions("catalog")).length >
        JSON.parse(before).filter((item) => item[0] === "catalog").length,
    );
  });
  await run("late-response", async () => {
    await render({ agentId: "old-child", parentSessionId: "old-parent", delay: true });
    await page.waitForFunction(() => window.resolveOldTranscript && window.resolveOldCatalog);
    await pane.locator('[data-subagent-action="back-to-list"]').click();
    await pane.locator('[data-subagent-list][aria-busy="true"]').waitFor();
    assert.deepEqual(
      await actions("transcript"),
      [["transcript", "old-child"]],
      "pending list never starts another transcript read",
    );
    const animation = await pane
      .locator("[data-subagent-list] .animate-spin")
      .evaluate((element) => getComputedStyle(element).animationName);
    assert.equal(animation, "none", "reduced motion disables the loading animation");
    await page.evaluate(() =>
      window.updateFixture({ agentId: "new-child", parentSessionId: "new-parent", delay: false }),
    );
    await pane.getByText("Exact transcript new-child", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.resolveOldTranscript();
      window.resolveOldCatalog();
    });
    await settle();
    assert.equal(
      await pane.getByText(/STALE/).count(),
      0,
      "late old parent responses cannot replace selected child",
    );
    await pane.locator('[data-subagent-action="back-to-list"]').click();
    await pane.locator('[data-subagent-list-id="new-child"]').waitFor();
    assert.deepEqual(
      await pane
        .locator("[data-subagent-list-id]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-subagent-list-id")),
        ),
      ["new-child"],
    );
  });
  await run("nested-back", async () => {
    await render({ agentId: "child-nested" });
    await pane.getByText("Exact transcript child-nested", { exact: true }).waitFor();
    await pane.locator(".cs-agent-transcript").click();
    await pane.getByText("Exact transcript grandchild-one", { exact: true }).waitFor();
    await pane.locator('[data-subagent-action="back-to-list"]').last().click();
    await pane.locator('[data-subagent-list-id="grandchild-two"]').waitFor();
    assert.ok(
      (await actions("catalog")).some((item) => item[1].parentSessionId === "child-nested"),
    );
    assert.deepEqual(await actions("external-back"), []);
    await pane.locator('[data-subagent-list-id="grandchild-two"]').click();
    await pane.getByText("Exact transcript grandchild-two", { exact: true }).waitFor();
    await pane.locator('[data-subagent-action="back-to-list"]').last().click();
    await pane.locator('[data-subagent-action="back-to-parent"]').last().click();
    await pane.getByText("Exact transcript child-nested", { exact: true }).waitFor();
    assert.deepEqual(
      await actions("external-back"),
      [],
      "nested list returns locally to parent conversation",
    );
    await pane.locator('[data-subagent-action="back-to-list"]').click();
    await pane.locator('[data-subagent-action="back-to-parent"]').click();
    assert.equal(
      (await actions("external-back")).length,
      1,
      "only top list header invokes external back",
    );
  });
  await run("no-target", async () => {
    await render({ agentId: undefined });
    const hint = await page.evaluate(() => window.fixtureLabels.hint);
    await pane.getByText(hint, { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("codeshell:files-changed")));
    await settle();
    assert.deepEqual(
      await page.evaluate(() => window.actions),
      [],
      "targetless view queries nothing",
    );
    assert.equal(await pane.locator("[data-subagent-list]").count(), 0);
    assert.equal(await pane.locator('[data-subagent-action="back-to-list"]').count(), 0);
  });
  await run("catalog-error", async () => {
    await page.setViewportSize({ width: 800, height: 360 });
    await render({ paneWidth: 320, catalogError: true });
    await pane.getByText("Exact transcript completed", { exact: true }).waitFor();
    await pane.locator('[data-subagent-action="back-to-list"]').click();
    await pane.getByRole("alert").waitFor();
    await geometry("long catalog error");
    await capture("catalog-error-zh-light-320");
    await reachable(
      pane.locator('[data-subagent-list-id="cancelled"]'),
      "error retains final sibling",
    );
    assert.deepEqual(await actions("transcript"), [["transcript", "completed"]]);
  });
  for (const mode of ["light", "dark"])
    await run(`presentation-${mode}`, async () => {
      await page.setViewportSize({ width: 800, height: 560 });
      await render({ mode, paneWidth: 620, presentation: true });
      await pane.getByText("Exact transcript completed", { exact: true }).waitFor();
      await capture(`preview-conversation-${mode}`);
      await pane.locator('[data-subagent-action="back-to-list"]').click();
      await pane.locator('[data-subagent-list-id="cancelled"]').waitFor();
      await capture(`preview-list-${mode}`);
    });
} catch (error) {
  if (!failures.length) failures.push({ label: "fixture", error: error.stack });
} finally {
  await browser.close();
}
const report = {
  result: failures.length || errors.length || blocked.length ? "fail" : "pass",
  workflows: reports.length,
  reports,
  failures,
  browserErrors: errors,
  blockedRequests: blocked,
  output,
};
await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.result !== "pass") process.exitCode = 1;
