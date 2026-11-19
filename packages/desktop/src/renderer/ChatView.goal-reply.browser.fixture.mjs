/* Real ChatView + Tailwind: the goal question banner, answered through the main composer. */
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
const background='生产服务器从这台机器连不上：SSH 被拒，也没有云厂商的命令行工具。上次是在执行机上部署的，所以这次需要你决定部署方式，以及发版指的是哪一个版本。预发布流水线已经在跑，网页优化合并后也可以再发正式版。两件事互不依赖，可以分别决定；没有选的那一项我会保持现状，不做任何对外操作。';
const deploy={id:'deploy',header:'部署方式',question:'服务端怎么部署？',options:[{label:'你在执行机上部署',description:'我写部署计划和验收清单'},{label:'这次先不部署'}]};
const release={id:'release',header:'发版',question:'发哪个版本？',options:[{label:'预发布'},{label:'合并后发正式版',description:'等网页优化合并'}],default:'合并后发正式版'};
const details={
 none:()=>({}),
 options:text=>({waitingDetail:{level:'preference',questions:[{id:'q1',question:text,options:[{label:'这处可接受',description:'按当前效果收尾'},{label:'继续优化'}]}]}}),
 several:()=>({waitingForUser:background,waitingDetail:{level:'preference',questions:[deploy,release]}}),
 consent:()=>({waitingDetail:{level:'consent'}}),
};
const history=[{kind:'user',id:'human',text:'优化设计工作台'},{kind:'assistant',id:'assistant',text:'已完成当前对照，请确认这处效果。',done:true}];
function Fixture({width=760,height=800,legacy=false,longQuestion=false,sendFailure='none',detail='none'}){
 const [session,setSession]=React.useState('session-a');
 const [draft,setDraft]=React.useState('');
 const [goal,setGoal]=React.useState(()=>({...initialGoal,...(legacy?{activeMs:undefined}:{}),...(longQuestion?{waitingForUser:question+' 很长的问题内容。'.repeat(100)}:{}),...details[detail](longQuestion?question+' 很长的问题内容。'.repeat(100):question)}));
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
const question = (page) => page.locator("[data-goal-reply]");
// The goal question has no input of its own: the one composer answers it.
const composer = (page) => page.locator("textarea");
const choice = (page, name) => question(page).getByRole("button", { name, exact: true });
const cards = (page) => question(page).locator("[data-goal-reply-choice]");
const card = (page, label) => question(page).getByRole("radio", { name: label });
const sends = (page) =>
  page.evaluate(() =>
    window.calls
      .filter((call) => call[0] === "send")
      .map((call) => [call[1], call[2].bucket, call[2].continueGoal]),
  );
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
  await question(page).waitFor();
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
    "the question is shown once with one input box; clock freezes and local image link opens",
    async () => {
      const page = await mount();
      assert.equal(
        await page
          .getByRole("button", { name: "展开目标", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
      // One input on screen, and it says what it is for.
      assert.equal(await page.locator("textarea, input[type=text]").count(), 1);
      assert.equal(
        await composer(page).getAttribute("placeholder"),
        "在这里回答上面的问题，Enter 发送…",
      );
      assert.equal(await question(page).getByRole("button").count(), 0);
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
    "the main composer answers the question: IME Enter is ignored, Enter sends once",
    async () => {
      const page = await mount();
      await composer(page).fill("这处可接受");
      await composer(page).evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      });
      assert.equal(await page.evaluate(() => window.calls.length), 0);
      await composer(page).press("Enter");
      await page.locator('[data-goal-state="running"]').waitFor();
      assert.deepEqual(await sends(page), [["这处可接受", "session-a", true]]);
      assert.equal(await page.evaluate(() => window.fixture.draft()), "");
      assert.equal(await question(page).count(), 0);
      // With no question open, the composer is an ordinary composer again.
      await page.evaluate(() => window.fixture.setBusy(false));
      await frames(page);
      assert.notEqual(
        await composer(page).getAttribute("placeholder"),
        "在这里回答上面的问题，Enter 发送…",
      );
      await composer(page).fill("另一条普通消息");
      await composer(page).press("Enter");
      assert.deepEqual((await sends(page))[1], ["另一条普通消息", "session-a", undefined]);
      await page.close();
    },
  );
  await check(
    "option cards answer one question with one click, mark the recommended one and cannot double send",
    async () => {
      const page = await mount({ detail: "options" });
      assert.equal(await cards(page).count(), 2);
      assert.equal(await question(page).locator('[data-goal-reply-choice="default"]').count(), 1);
      // The first option is the recommended one; its description is on the card.
      assert.match(
        await cards(page).first().innerText(),
        /这处可接受[\s\S]*推荐[\s\S]*按当前效果收尾/,
      );
      // Still one input on screen, and one question means no separate send button.
      assert.equal(await page.locator("textarea, input[type=text]").count(), 1);
      assert.equal(await question(page).locator("[data-goal-reply-submit]").count(), 0);
      await screenshot(page, "waiting-options-light");
      await question(page)
        .locator('[data-goal-reply-choice="option"]')
        .evaluate((element) => {
          element.click();
          element.click();
        });
      await page.locator('[data-goal-state="running"]').waitFor();
      assert.deepEqual(await sends(page), [["继续优化", "session-a", true]]);
      await page.close();
    },
  );
  await check(
    "several questions sit in one banner and are sent as one combined answer",
    async () => {
      const page = await mount({ detail: "several" });
      assert.equal(await question(page).count(), 1);
      assert.equal(await question(page).locator("[data-goal-reply-question]").count(), 2);
      assert.equal(await cards(page).count(), 4);
      assert.equal(await question(page).locator('[data-goal-reply-choice="default"]').count(), 2);
      // The banner adds no input: free-form answers still use the one composer.
      assert.equal(await page.locator("textarea, input[type=text]").count(), 1);
      assert.equal(await question(page).locator("textarea, input").count(), 0);
      // Long background starts collapsed and can be opened.
      const more = question(page).getByRole("button", { name: "展开说明", exact: true });
      assert.equal(await more.getAttribute("aria-expanded"), "false");
      await more.click();
      await question(page).getByRole("button", { name: "收起", exact: true }).waitFor();
      const submit = question(page).locator("[data-goal-reply-submit]");
      assert(await submit.isDisabled());
      await card(page, "这次先不部署").click();
      await frames(page);
      assert.equal(await card(page, "这次先不部署").getAttribute("aria-checked"), "true");
      // One pick does not send: every question needs one.
      assert.deepEqual(await sends(page), []);
      assert(await submit.isDisabled());
      await card(page, "预发布").click();
      await card(page, "你在执行机上部署").click();
      await frames(page);
      assert.equal(await card(page, "这次先不部署").getAttribute("aria-checked"), "false");
      await screenshot(page, "waiting-several-light");
      await submit.evaluate((element) => {
        element.click();
        element.click();
      });
      await page.locator('[data-goal-state="running"]').waitFor();
      assert.deepEqual(await sends(page), [
        ["部署方式：你在执行机上部署\n发版：预发布", "session-a", true],
      ]);
      await page.close();
      // The main composer answers several questions too, without any pick.
      const typed = await mount({ detail: "several" });
      await composer(typed).fill("都先别动，等我看完");
      await composer(typed).press("Enter");
      await typed.locator('[data-goal-state="running"]').waitFor();
      assert.deepEqual(await sends(typed), [["都先别动，等我看完", "session-a", true]]);
      await typed.close();
    },
  );
  await check("a consent question offers explicit agree / disagree in both languages", async () => {
    const page = await mount({ detail: "consent" });
    assert.equal(await question(page).getAttribute("data-goal-reply-level"), "consent");
    assert.equal(await question(page).getByRole("button").count(), 2);
    await screenshot(page, "waiting-consent-light");
    await choice(page, "不同意").click();
    await page.locator('[data-goal-state="running"]').waitFor();
    assert.deepEqual(await sends(page), [["不同意", "session-a", true]]);
    await page.close();
    const english = await mount({ detail: "consent", lang: "en" });
    await choice(english, "Agree").click();
    await english.locator('[data-goal-state="running"]').waitFor();
    assert.deepEqual(await sends(english), [["Agree", "session-a", true]]);
    await english.close();
  });
  await check("answers go to the session and question that are on screen", async () => {
    const page = await mount();
    await page.evaluate(() => window.fixture.setSession("session-b"));
    await frames(page);
    await page.evaluate(() =>
      window.fixture.setGoal((previous) => ({
        ...previous,
        waitingForUser: "第二个问题：请指出异常位置。",
      })),
    );
    await frames(page);
    assert.match(await question(page).innerText(), /第二个问题/);
    await composer(page).fill("右侧标题基线");
    await composer(page).press("Enter");
    await page.locator('[data-goal-state="running"]').waitFor();
    assert.deepEqual(await sends(page), [["右侧标题基线", "session-b", true]]);
    await page.close();
  });
  await check(
    "a blocking AskUser goes first and the goal question queues; a pause hides it",
    async () => {
      const page = await mount({ detail: "options" });
      await page.evaluate(() => window.fixture.setOpenAsk(true));
      await frames(page);
      // One pending item at a time: the goal question waits, it is not a disabled card.
      assert.equal(await question(page).count(), 0);
      assert.equal(await page.locator("[data-goal-reply-queued]").count(), 1);
      assert.equal(await page.getByText("真正的 AskUser 问题", { exact: true }).count(), 1);
      assert.notEqual(
        await composer(page).getAttribute("placeholder"),
        "在这里回答上面的问题，Enter 发送…",
      );
      await screenshot(page, "queued-behind-ask-light");
      await page.evaluate(() => window.fixture.setOpenAsk(false));
      await question(page).waitFor();
      assert.equal(await page.locator("[data-goal-reply-queued]").count(), 0);
      await page.evaluate(() =>
        window.fixture.setGoal((previous) => ({ ...previous, paused: true })),
      );
      await page.locator('[data-goal-state="paused"]').waitFor();
      assert.equal(await question(page).count(), 0);
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
      sendFailure + " send failure gives the answer back, reports failure and permits retry",
      async () => {
        const page = await mount({ sendFailure });
        await composer(page).fill("右侧标题基线仍偏下，请继续优化");
        await composer(page).press("Enter");
        if (sendFailure === "optimistic") {
          await page.locator('[data-goal-state="running"]').waitFor();
          assert.equal(await question(page).count(), 0);
          await page.evaluate(() => window.fixture.rejectPending());
        }
        await page.getByRole("alert").filter({ hasText: "回复未发送，请重试。" }).waitFor();
        assert.equal(await composer(page).inputValue(), "右侧标题基线仍偏下，请继续优化");
        assert.equal(await page.locator('[data-goal-state="waiting"]').count(), 1);
        await page.evaluate(() => window.fixture.setFailure("none"));
        await frames(page);
        await composer(page).press("Enter");
        await page.locator('[data-goal-state="running"]').waitFor();
        assert.deepEqual(await sends(page), [
          ["右侧标题基线仍偏下，请继续优化", "session-a", true],
          ["右侧标题基线仍偏下，请继续优化", "session-a", true],
        ]);
        assert.equal(await question(page).count(), 0);
        assert.equal(await page.getByRole("alert").count(), 0);
        await page.close();
      },
    );
  }
  for (const [mode, detail] of [
    ["light", "options"],
    ["dark", "options"],
    ["dark", "several"],
  ]) {
    const name = mode + " narrow layout keeps the " + detail + " banner within the pane";
    await check(name, async () => {
      const page = await mount({ width: 360, height: 800, mode, longQuestion: true, detail });
      for (const locator of [
        page.locator("[data-goal-state]"),
        question(page),
        ...(await cards(page).all()),
        composer(page),
      ]) {
        const bounds = await locator.boundingBox();
        assert(
          bounds && bounds.x >= -1 && bounds.x + bounds.width <= 361,
          "control overflows horizontally",
        );
      }
      assert(await composer(page).isVisible());
      const overflows = await page
        .locator("[data-goal-state]")
        .evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      await screenshot(page, "waiting-narrow-" + detail + "-" + mode);
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
          path.join(output, "overflow-" + detail + "-" + mode + ".json"),
          JSON.stringify({ overflows, geometry }, null, 2),
        );
      }
      assert(overflows.scroll <= overflows.client + 1, "goal contents overflow horizontally");
      await composer(page).fill("右侧标题基线仍偏下");
      await composer(page).press("Enter");
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
