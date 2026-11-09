/* Real ChatView + Tailwind: goal reply routing, IME, state isolation and layout. */
/* global window, requestAnimationFrame, KeyboardEvent, CompositionEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const renderer = path.join(desktop, "src/renderer");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  path.resolve(desktop, "../../.tmp/goal-reply-qa");
await mkdir(output, { recursive: true });
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ChatView} from './ChatView';import {I18nProvider} from './i18n/I18nProvider';
import {ToastProvider} from './ui/ToastProvider';import {saveUILanguage} from './uiLanguage';
import {applyTheme,saveTheme} from './theme';
const noop=()=>{};
window.codeshell={sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>noop,listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']}),localFileExists:async()=>true,sessionFileExists:async()=>true,readImageDataUrl:async()=>null,openPath:async(...args)=>{window.calls.push(['open',...args]);return ''},log:noop};
window.addEventListener('codeshell:open-file',event=>window.calls.push(['file',event.detail]));
const question='请按 100% 显示查看当前原尺寸对照：[查看对照图](/fixture/compare.png)。这处效果在实际编辑时是否仍明显不一致？请回复“这处可接受”，或指出具体异常位置。';
const initialGoal={objective:'优化设计工作台，一直优化到没有太多样式差异',goalId:'goal-one',revision:2,round:3,paused:false,setAtMs:Date.now()-251174000,activeMs:65000,waitingForUser:question};
const history=[{kind:'user',id:'human',text:'优化设计工作台'},{kind:'assistant',id:'assistant',text:'已完成当前对照，请确认这处效果。',done:true}];
function Fixture({width=760,height=800,legacy=false,longQuestion=false,sendFailure='none'}){
 const [session,setSession]=React.useState('session-a');
 const [draft,setDraft]=React.useState('Keep my ordinary composer draft');
 const [goal,setGoal]=React.useState(()=>({...initialGoal,...(legacy?{activeMs:undefined}:{}),...(longQuestion?{waitingForUser:question+' 很长的问题内容。'.repeat(100)}:{})}));
 const [busy,setBusy]=React.useState(false);const [openAsk,setOpenAsk]=React.useState(false);
 const [failure,setFailure]=React.useState(sendFailure);const pendingFailure=React.useRef(null);
 const send=(text,opts)=>{window.calls.push(['send',text,opts]);if(failure==='reject')return Promise.reject(new Error('Fixture send rejected'));setBusy(true);setGoal(previous=>({...previous,waitingForUser:undefined,clockSinceMs:Date.now()}));if(failure==='optimistic')return new Promise((_,reject)=>{pendingFailure.current=()=>{setBusy(false);setGoal(goal);reject(new Error('Fixture launch rejected'))}});};
 window.fixture={draft:()=>draft,setSession,setGoal,setBusy,setOpenAsk,setFailure,rejectPending:()=>pendingFailure.current?.(),goal:()=>goal};
 const messages=openAsk?[...history,{kind:'ask_user',id:'ask',requestId:'owned-ask',question:'真正的 AskUser 问题',options:[{label:'继续'},{label:'停止'}]}]:history;
 return <main data-fixture-pane style={{position:'fixed',top:0,left:0,width,height,overflow:'hidden',display:'flex',flexDirection:'column'}}>
 <ChatView messages={messages} onSend={send} onStop={()=>setBusy(false)} onAskUserAnswer={(id,answer)=>window.calls.push(['ask',id,answer])} busy={busy} liveTurnActive={busy} permissionMode='default' onPermissionChange={noop} modelOptions={[{key:'fixture',label:'Fixture model',provider:'fixture',supportsVision:true}]} activeModelKey='fixture' onModelChange={noop} draft={draft} onDraftChange={setDraft} attachments={[]} onAttachmentsChange={noop} variant='main' activeProjectId='fixture' engineSessionId={session} sendBucket={session} goalEnabled activeGoal={goal} onGoalToggle={noop} onGoalPausedChange={paused=>setGoal(previous=>({...previous,paused}))} onUpdateGoal={noop} onDeleteGoal={noop} contextTokens={0} projects={[]} onSelectProject={noop} onAddProject={noop} configurationTarget={{projectId:'fixture'}} configurationAvailable conversationRoot='/fixture' conversationRootId='root' conversationRootStatus='ok'/>
 </main>;
}
const root=createRoot(document.getElementById('root'));let generation=0;
window.renderFixture=options=>{localStorage.clear();saveUILanguage(options.lang||'zh');saveTheme(options.mode||'light');applyTheme(options.mode||'light');window.calls=[];const current=++generation;root.render(<I18nProvider key={current}><ToastProvider><div data-fixture-generation={current}><Fixture {...options}/></div></ToastProvider></I18nProvider>);return current};
`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
});
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
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
const cases = [],
  errors = [],
  blocked = [];
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const replyInput = (page) =>
  page.getByRole("textbox", { name: /^(回答目标问题|Answer the goal question)$/ });
const replyButton = (page) =>
  page.getByRole("button", { name: /^(回复并继续|Reply and continue)$/ });
const selectedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const excludedCase = process.argv.find((arg) => arg.startsWith("--skip-case="))?.slice(12);
async function mount(options = {}) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 900 },
    serviceWorkers: "block",
  });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://goal-reply.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://goal-reply.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const generation = await page.evaluate((options) => window.renderFixture(options), options);
  await page
    .locator('[data-fixture-generation="' + generation + '"]')
    .waitFor({ state: "attached" });
  await replyInput(page).waitFor();
  await frames(page);
  return page;
}
async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(output, name + ".png"),
    clip: await page.locator("[data-fixture-pane]").boundingBox(),
  });
}
async function check(name, test) {
  if (selectedCase && !name.includes(selectedCase)) return;
  if (excludedCase && name.includes(excludedCase)) return;
  await test();
  cases.push(name);
  console.log("PASS " + name);
}
try {
  await check(
    "waiting is actionable without expansion; clock freezes and local image link opens",
    async () => {
      const page = await mount();
      assert.equal(
        await page
          .getByRole("button", { name: "展开目标", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(await replyButton(page).isDisabled(), true);
      const before = await page.locator("[data-goal-state]").innerText();
      assert.match(before, /1m 05s/);
      await page.waitForTimeout(1150);
      assert.equal(await page.locator("[data-goal-state]").innerText(), before);
      await page.locator('a[data-path-link="true"]').click();
      assert.equal(await page.evaluate(() => window.calls[0][1].path), "/fixture/compare.png");
      await screenshot(page, "waiting-light");
      await page.close();
    },
  );
  await check(
    "IME and plain Enter keep the answer; Ctrl+Enter sends exactly once to the session",
    async () => {
      const page = await mount();
      await replyInput(page).fill("这处可接受");
      await replyInput(page).evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      });
      assert.equal(await page.evaluate(() => window.calls.length), 0);
      await replyInput(page).press("Enter");
      assert.equal(await page.evaluate(() => window.calls.length), 0);
      await replyInput(page).press("Control+Enter");
      await page.locator('[data-goal-state="running"]').waitFor();
      assert.deepEqual(
        await page.evaluate(() =>
          window.calls
            .filter((call) => call[0] === "send")
            .map((call) => [call[1], call[2].bucket, call[2].continueGoal]),
        ),
        [["这处可接受", "session-a", true]],
      );
      assert.equal(
        await page.evaluate(() => window.fixture.draft()),
        "Keep my ordinary composer draft",
      );
      assert.equal(await replyInput(page).count(), 0);
      await page.close();
    },
  );
  await check(
    "Meta+Enter sends in English and double clicks cannot duplicate a reply",
    async () => {
      const page = await mount({ lang: "en" });
      await replyInput(page).fill("Accept this part");
      await replyInput(page).press("Meta+Enter");
      await page.locator('[data-goal-state="running"]').waitFor();
      assert.equal(
        await page.evaluate(() => window.calls.filter((call) => call[0] === "send").length),
        1,
      );
      await page.close();
      const duplicate = await mount();
      await replyInput(duplicate).fill("这处可接受");
      await replyButton(duplicate).evaluate((element) => {
        element.click();
        element.click();
      });
      await duplicate.locator('[data-goal-state="running"]').waitFor();
      assert.equal(
        await duplicate.evaluate(() => window.calls.filter((call) => call[0] === "send").length),
        1,
      );
      await duplicate.close();
    },
  );
  await check("answers do not leak across session or question changes", async () => {
    const page = await mount();
    await replyInput(page).fill("unsent answer in session A");
    await page.evaluate(() => window.fixture.setSession("session-b"));
    await frames(page);
    assert.equal(await replyInput(page).inputValue(), "");
    await replyInput(page).fill("answer to previous question");
    await page.evaluate(() =>
      window.fixture.setGoal((previous) => ({
        ...previous,
        waitingForUser: "第二个问题：请指出异常位置。",
      })),
    );
    await frames(page);
    assert.equal(await replyInput(page).inputValue(), "");
    await replyInput(page).fill("右侧标题基线");
    await replyButton(page).click();
    await page.locator('[data-goal-state="running"]').waitFor();
    assert.deepEqual(
      await page.evaluate(() =>
        window.calls
          .filter((call) => call[0] === "send")
          .map((call) => [call[1], call[2].bucket, call[2].continueGoal]),
      ),
      [["右侧标题基线", "session-b", true]],
    );
    await page.close();
  });
  await check(
    "blocking AskUser keeps one answer destination and manual pause hides reply action",
    async () => {
      const page = await mount();
      await page.evaluate(() => window.fixture.setOpenAsk(true));
      await frames(page);
      assert.equal(await replyInput(page).count(), 0);
      assert.equal(await page.getByText("真正的 AskUser 问题", { exact: true }).count(), 1);
      await page.evaluate(() => {
        window.fixture.setOpenAsk(false);
        window.fixture.setGoal((previous) => ({ ...previous, paused: true }));
      });
      await page.locator('[data-goal-state="paused"]').waitFor();
      assert.equal(await replyInput(page).count(), 0);
      const before = await page.locator("[data-goal-state]").innerText();
      await page.waitForTimeout(1100);
      assert.equal(await page.locator("[data-goal-state]").innerText(), before);
      await page.close();
    },
  );
  await check("old unknown accounting never shows creation age as running time", async () => {
    const page = await mount({ legacy: true });
    const text = await page.locator("[data-goal-state]").innerText();
    assert.doesNotMatch(text, /69h|1m 05s/);
    await page.close();
  });
  for (const sendFailure of ["reject", "optimistic"]) {
    await check(
      sendFailure + " send failure preserves the answer, reports failure and permits retry",
      async () => {
        const page = await mount({ sendFailure });
        await replyInput(page).fill("右侧标题基线仍偏下，请继续优化");
        await replyButton(page).click();
        if (sendFailure === "optimistic") {
          await page.locator('[data-goal-state="running"]').waitFor();
          assert.equal(await replyInput(page).count(), 0);
          await page.evaluate(() => window.fixture.rejectPending());
        }
        await page.getByRole("alert").filter({ hasText: "回复未发送，请重试。" }).waitFor();
        assert.equal(await replyInput(page).inputValue(), "右侧标题基线仍偏下，请继续优化");
        assert.equal(await replyButton(page).isEnabled(), true);
        assert.equal(
          await page.evaluate(() => window.fixture.draft()),
          "Keep my ordinary composer draft",
        );
        assert.equal(await page.locator('[data-goal-state="waiting"]').count(), 1);
        await page.evaluate(() => window.fixture.setFailure("none"));
        await frames(page);
        await replyButton(page).click();
        await page.locator('[data-goal-state="running"]').waitFor();
        assert.deepEqual(
          await page.evaluate(() =>
            window.calls
              .filter((call) => call[0] === "send")
              .map((call) => [call[1], call[2].bucket, call[2].continueGoal]),
          ),
          [
            ["右侧标题基线仍偏下，请继续优化", "session-a", true],
            ["右侧标题基线仍偏下，请继续优化", "session-a", true],
          ],
        );
        assert.equal(await replyInput(page).count(), 0);
        await page.close();
      },
    );
  }
  for (const mode of ["light", "dark"]) {
    await check(mode + " narrow layout keeps answer and action within the pane", async () => {
      const page = await mount({ width: 360, height: 800, mode, longQuestion: true });
      for (const locator of [
        page.locator("[data-goal-state]"),
        replyInput(page),
        replyButton(page),
      ]) {
        const bounds = await locator.boundingBox();
        assert(
          bounds && bounds.x >= -1 && bounds.x + bounds.width <= 361,
          "control overflows horizontally",
        );
      }
      assert(await replyInput(page).isVisible());
      const overflows = await page
        .locator("[data-goal-state]")
        .evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      await screenshot(page, "waiting-narrow-" + mode);
      if (overflows.scroll > overflows.client + 1) {
        const geometry = await page.locator("[data-goal-state]").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll("*")]
            .filter((child) => child.getBoundingClientRect().right > bounds.right + 1)
            .map((child) => ({
              tag: child.tagName,
              text: child.textContent?.slice(0, 100),
              className: child.getAttribute("class"),
              bounds: child.getBoundingClientRect().toJSON(),
            }));
        });
        await writeFile(
          path.join(output, "overflow-" + mode + ".json"),
          JSON.stringify({ overflows, geometry }, null, 2),
        );
      }
      assert(overflows.scroll <= overflows.client + 1, "goal contents overflow horizontally");
      await replyInput(page).fill("右侧标题基线仍偏下");
      await screenshot(page, "waiting-narrow-" + mode);
      await replyButton(page).click();
      await page.locator('[data-goal-state="running"]').waitFor();
      await page.close();
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} finally {
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ cases, errors, blocked }, null, 2),
  );
}
console.log(JSON.stringify({ passed: cases.length, output }));
