/* Real forwarding selection, async lifecycle and transferred-card disclosures. */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output = "/tmp/codeshell-forward-session-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {MessageStream} from './MessageStream';
  import {I18nProvider} from './i18n/I18nProvider';
  import {translate} from './i18n/translate';
  import {saveUILanguage} from './uiLanguage';
  const sourceSession='source-session-'+('LongSourceIdentifier'.repeat(18));
  const otherSession='other-session-'+('LongSourceIdentifier'.repeat(18));
  const longError='ForwardingError: '+('LongErrorIdentifierWithoutSpaces'.repeat(24));
  const raw=Array.from({length:3},(_,index)=>[
    {id:'raw-user-'+(index+1),type:'message',turnNumber:index,timestamp:index*3+1,data:{role:'user',content:'Task '+(index+1)}},
    {id:'raw-assistant-'+(index+1),type:'message',turnNumber:index,timestamp:index*3+2,data:{role:'assistant',content:'Answer '+(index+1)}},
    {id:'raw-boundary-'+(index+1),type:'turn_boundary',turnNumber:index+1,timestamp:index*3+3,data:{}},
  ]).flat();
  const summary={zh:'我们已经确定了首页的信息层级：当前任务、最近项目和常用入口。\\n\\n设计方向保持简洁，用清晰的标题、适度的留白和统一的操作样式帮助用户快速找到下一步。\\n\\n接下来先完成首页草图，再逐步细化任务卡片与导航。',
    en:'We agreed on the home page hierarchy: current tasks, recent projects, and common actions.\\n\\nThe design should use clear headings, comfortable spacing, and consistent controls so people can find the next step quickly.\\n\\nNext, finish the page sketch, then refine the task cards and navigation.'};
  const messages=lang=>[
    {kind:'user',id:'display-user-1',sourceEventId:'raw-user-1',text:lang==='zh'?'我们要重新设计项目首页，先帮我梳理重点。':'Help me identify the priorities for redesigning the project home page.'},
    {kind:'assistant',id:'display-answer-1',done:true,text:lang==='zh'?'首页可以突出三个区域：当前任务、最近项目和常用入口。先让信息层级清楚，再考虑视觉细节。':'Start with three areas: current tasks, recent projects, and common actions. Clarify the hierarchy before refining visual details.'},
    {kind:'user',id:'display-user-2',sourceEventId:'raw-user-2',text:lang==='zh'?'视觉上希望更简洁，操作也更顺手。':'Keep the visual design simple and make the controls easier to use.'},
    {kind:'assistant',id:'display-answer-2',done:true,text:lang==='zh'?'建议减少重复边框，统一按钮和间距。主要操作用明确的文字，次要信息保持低对比度。':'Reduce repeated borders and use consistent buttons and spacing. Give primary actions clear labels and keep secondary information quiet.'},
    {kind:'user',id:'display-user-3',sourceEventId:'raw-user-3',text:lang==='zh'?'很好，把这些结论带到新会话，继续讨论首页草图。':'Take these decisions into a new conversation so we can discuss the home page sketch.'},
    {kind:'assistant',id:'display-answer-3',done:true,text:lang==='zh'?'可以保留这三轮完整讨论作为背景，下一步直接从草图开始。':'Keep all three complete exchanges as background, then start directly with the sketch.'},
  ];
  window.codeshell={
    getSessionRawEvents:async()=>{
      if(window.phase==='loading')return new Promise(resolve=>{window.finishRead=()=>resolve(raw)});
      if(window.phase==='empty')return [];
      if(window.phase==='error')throw new Error(longError);
      return raw;
    },
    forkSession:params=>{
      window.forks.push(params);
      return new Promise((resolve,reject)=>{
        window.failFork=()=>reject(new Error(longError));
        window.finishFork=()=>resolve({sessionId:'target-session',mode:'summary',summary:summary[window.language],
          sourceRange:{fromEventId:params.fromEventId,toEventId:params.toEventId},estimatedTokens:3296,
          forkedFrom:{sessionId:params.sourceSessionId,mode:'summary',sourceEventCount:9,createdAt:3},
          workspace:{root:'/fixture/project',kind:'main'}});
      });
    },
  };
  const onSelectionChange=open=>{window.selectionOpen=open};
  function Fixture({lang}) {
    const [session,setSession]=React.useState(sourceSession);
    const [request,setRequest]=React.useState(0);
    const [created,setCreated]=React.useState(null);
    window.openSelection=()=>setRequest(value=>value+1);
    window.switchSession=()=>{setSession(otherSession);setCreated(null)};
    window.currentSession=session;
    const onCreated=React.useCallback((result,options)=>{
      const activate=options?.shouldActivate?.()??true;
      window.registrations.push({sessionId:result.sessionId,activate});
      if(activate){setSession(result.sessionId);setCreated(result)};
    },[]);
    const transcript=created?[
      {kind:'context_boundary',id:'transferred',strategy:'summary',before:9000,after:3296,contextTransfer:{
        summary:created.summary,sourceSessionId:created.forkedFrom.sessionId,
        fromEventId:created.sourceRange.fromEventId,toEventId:created.sourceRange.toEventId,
        sourceEventCount:9,estimatedTokens:3296}},
      {kind:'user',id:'follow-up',text:lang==='zh'?'在这个基础上，我们先画一个首页草图。':'Let’s use that background to sketch the home page.'},
    ]:messages(lang);
    return <main id="forward-fixture" className="fixed inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <MessageStream messages={transcript} engineSessionId={session} liveTurnActive={false}
        onContextPackageCreated={onCreated} onContextSelectionChange={onSelectionChange} contextSelectionRequest={request}/>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=props=>{
    saveUILanguage(props.lang);window.language=props.lang;window.phase=props.phase;
    document.documentElement.classList.toggle('dark',props.theme==='dark');
    window.forks=[];window.registrations=[];
    window.labels={cancel:translate(props.lang,'chat.contextPackage.cancelAria'),cancelText:translate(props.lang,'chat.contextPackage.cancel'),loading:translate(props.lang,'chat.contextPackage.loading'),
      empty:translate(props.lang,'chat.contextPackage.empty'),selected3:translate(props.lang,'chat.contextPackage.selected',{count:3})};
    window.sourceSession=sourceSession;window.otherSession=otherSession;window.longError=longError;
    root.render(<I18nProvider key={JSON.stringify(props)}><Fixture {...props}/></I18nProvider>);
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
});
const reports = [];
const failures = [];
const errors = [];

async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function reachable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const geometry = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      box: box.toJSON(),
      disabled: node.matches(":disabled"),
      hit: hit === node || node.contains(hit),
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  assert.ok(
    geometry.box.width > 0 &&
      geometry.box.height > 0 &&
      geometry.box.left >= 0 &&
      geometry.box.right <= geometry.width + 1 &&
      geometry.box.top >= 0 &&
      geometry.box.bottom <= geometry.height + 1,
    `${label}: visible geometry ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.disabled || geometry.hit,
    `${label}: pointer reaches control ${JSON.stringify(geometry)}`,
  );
}
async function fits(page, label) {
  const geometry = await page.locator("#forward-fixture").evaluate((node) => ({
    width: node.clientWidth,
    scrollWidth: node.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(
    geometry.scrollWidth <= geometry.width + 1 && geometry.documentWidth <= geometry.viewport + 1,
    `${label}: no horizontal overflow ${JSON.stringify(geometry)}`,
  );
  reports.push({ label, geometry });
}

try {
  const page = await browser.newPage({ viewport: { width: 640, height: 720 } });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://forward.test/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://forward.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const lang of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const viewport of [
        { width: 640, height: 720 },
        { width: 320, height: 360 },
      ]) {
        await page.setViewportSize(viewport);
        const context = { lang, theme, viewport };
        const label = `${lang}/${theme}/${viewport.width}x${viewport.height}`;
        const merge = page.locator('[data-context-action="merge"]');
        const turn = (index) => page.locator('[data-context-turn-index="' + index + '"]');
        const selected = page.locator('[data-context-turn-selected="true"]');
        const screenshot = async (phase) => {
          if (lang === "zh")
            await page.screenshot({
              path: path.join(
                output,
                `${lang}-${theme}-${viewport.width}x${viewport.height}-${phase}.png`,
              ),
            });
        };
        const open = async (phase) => {
          await page.evaluate((props) => window.renderFixture(props), { lang, theme, phase });
          await settle(page);
          await page.evaluate(() => window.openSelection());
          await merge.waitFor();
          await settle(page);
          return page.evaluate(() => window.labels);
        };
        try {
          let labels = await open("loading");
          let cancel = page.getByRole("button", { name: labels.cancel, exact: true });
          await page.getByText(labels.loading, { exact: true }).first().waitFor();
          assert.ok(await merge.isDisabled());
          await reachable(cancel, `${label}/loading cancel`);
          await fits(page, `${label}/loading`);
          await screenshot("loading");
          await cancel.click();
          await merge.waitFor({ state: "hidden" });
          await page.evaluate(() => window.finishRead());
          await settle(page);
          assert.equal(await merge.count(), 0, `${label}: cancelled read never reopens selection`);

          labels = await open("empty");
          cancel = page.getByRole("button", { name: labels.cancel, exact: true });
          await page.getByText(labels.empty, { exact: true }).first().waitFor();
          assert.ok(await merge.isDisabled());
          assert.equal(await page.locator("[data-context-turn-index]").count(), 0);
          await reachable(merge, `${label}/empty action`);
          await fits(page, `${label}/empty`);
          await screenshot("empty");
          await cancel.click();
          await merge.waitFor({ state: "hidden" });

          labels = await open("error");
          cancel = page.getByRole("button", { name: labels.cancel, exact: true });
          const longError = await page.evaluate(() => window.longError);
          assert.ok(
            (await page.locator("#forward-fixture").textContent()).includes(longError),
            `${label}: full read error remains available`,
          );
          await reachable(merge, `${label}/error action`);
          await reachable(cancel, `${label}/error cancel`);
          await fits(page, `${label}/read error`);
          await screenshot("error");
          await cancel.click();
          await merge.waitFor({ state: "hidden" });

          labels = await open("ready");
          cancel = page.getByRole("button", { name: labels.cancel, exact: true });
          await turn(2).waitFor();
          assert.ok(await merge.isDisabled());
          await turn(0).click();
          await turn(2).click();
          assert.equal(
            await selected.count(),
            3,
            `${label}: forward endpoints select every intervening turn`,
          );
          assert.ok(
            (await page.locator("#forward-fixture").textContent()).includes(labels.selected3),
            `${label}: selected count is shown`,
          );
          await fits(page, `${label}/selected`);
          await screenshot("selected");
          if (lang === "zh" && theme === "light")
            await page.screenshot({
              path: path.join(
                output,
                viewport.width === 640
                  ? "preview-forwarding-light.png"
                  : "preview-forwarding-narrow.png",
              ),
            });
          await reachable(merge, `${label}/forward action`);
          await merge.click();
          const sourceSession = await page.evaluate(() => window.sourceSession);
          assert.deepEqual(
            await page.evaluate(() => window.forks),
            [
              {
                sourceSessionId: sourceSession,
                mode: "summary",
                fromEventId: "raw-user-1",
                toEventId: "raw-boundary-3",
              },
            ],
            `${label}: exact inclusive raw range`,
          );
          assert.ok(await merge.isDisabled());
          // Both cancel controls stay available to stop the running summary (R74).
          assert.ok(await cancel.isEnabled(), `${label}: header cancel can stop packaging`);
          assert.ok(
            await page.getByRole("button", { name: labels.cancelText, exact: true }).isEnabled(),
            `${label}: footer cancel can stop packaging`,
          );
          for (const button of await page.locator("[data-context-turn-index]").all())
            assert.ok(await button.isDisabled(), `${label}: selection freezes during packaging`);
          await turn(1).evaluate((node) => node.click());
          assert.equal(
            await selected.count(),
            3,
            `${label}: packaging cannot mutate the visible range`,
          );
          await fits(page, `${label}/packaging`);
          await screenshot("packaging");
          await page.evaluate(() => window.failFork());
          await page.waitForFunction(
            () => !document.querySelector('[data-context-action="merge"]').disabled,
          );
          assert.ok((await page.locator("#forward-fixture").textContent()).includes(longError));
          await reachable(merge, `${label}/retry action`);
          await reachable(cancel, `${label}/retry cancel`);
          await fits(page, `${label}/packaging error`);
          await merge.click();
          await page.evaluate(() => window.switchSession());
          await merge.waitFor({ state: "hidden" });
          const otherSession = await page.evaluate(() => window.otherSession);
          await page.evaluate(() => window.finishFork());
          await settle(page);
          assert.equal(
            await page.evaluate(() => window.currentSession),
            otherSession,
            `${label}: deferred package cannot replace switched session`,
          );
          assert.deepEqual(
            await page.evaluate(() => window.registrations),
            [{ sessionId: "target-session", activate: false }],
            `${label}: stale package registers without navigation`,
          );

          await page.evaluate(() => window.openSelection());
          await turn(2).waitFor();
          await turn(2).click();
          await turn(0).click();
          assert.equal(await selected.count(), 3, `${label}: reverse endpoints remain contiguous`);
          await merge.click();
          assert.deepEqual(
            (await page.evaluate(() => window.forks)).at(-1),
            {
              sourceSessionId: otherSession,
              mode: "summary",
              fromEventId: "raw-user-1",
              toEventId: "raw-boundary-3",
            },
            `${label}: reverse selection uses raw boundaries`,
          );
          await page.evaluate(() => window.finishFork());
          await merge.waitFor({ state: "hidden" });
          await page.waitForFunction(() => window.currentSession === "target-session");
          const card = page.locator("details").first();
          const cardSummary = card.locator(":scope > summary");
          await cardSummary.waitFor();
          assert.equal(await card.evaluate((node) => node.open), false);
          await reachable(cardSummary, `${label}/context disclosure`);
          await cardSummary.focus();
          await cardSummary.press("Enter");
          assert.equal(
            await card.evaluate((node) => node.open),
            true,
            `${label}: keyboard opens forwarded summary`,
          );
          await fits(page, `${label}/forwarded summary`);
          await screenshot("transferred");
          if (lang === "zh" && theme === "light" && viewport.width === 640) {
            await page.evaluate(() => document.activeElement?.blur());
            await page.screenshot({
              path: path.join(output, "preview-transferred-light.png"),
              animations: "disabled",
            });
          }
          const sourceDetails = card.locator("details");
          const sourceSummary = sourceDetails.locator(":scope > summary");
          await reachable(sourceSummary, `${label}/source disclosure`);
          await sourceSummary.focus();
          await sourceSummary.press("Enter");
          assert.equal(
            await sourceDetails.evaluate((node) => node.open),
            true,
            `${label}: keyboard opens full source metadata`,
          );
          const sourceText = await sourceDetails.textContent();
          assert.ok(
            sourceText.includes(otherSession) &&
              sourceText.includes("raw-user-1") &&
              sourceText.includes("raw-boundary-3"),
          );
          assert.ok(
            await sourceDetails.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
            `${label}: long source metadata wraps within card`,
          );
          await fits(page, `${label}/source metadata`);
          await screenshot("source");
          await sourceSummary.press("Enter");
          assert.equal(await sourceDetails.evaluate((node) => node.open), false);
          await cardSummary.press("Enter");
          assert.equal(await card.evaluate((node) => node.open), false);
        } catch (error) {
          const screenshotPath = path.join(
            output,
            `failure-${lang}-${theme}-${viewport.width}x${viewport.height}.png`,
          );
          await page.screenshot({ path: screenshotPath });
          failures.push({ ...context, error: error.message, screenshot: screenshotPath });
          console.error(`${label}: ${error.message}`);
          if (process.argv.includes("--fail-fast")) throw error;
        }
      }
  const result = {
    result: failures.length ? "fail" : "pass",
    workflows: 8,
    geometryCases: reports.length,
    failures,
    browserErrors: errors,
    output,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ ...result, reports }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], "No browser errors");
  assert.equal(failures.length, 0, "Forwarding fixture failed; see report.json");
} finally {
  await browser.close();
}
