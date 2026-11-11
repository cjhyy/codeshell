/* Production ChatView/AskUser/CSS with fixture-owned answer operations and no network. */
/* global document, window, requestAnimationFrame, KeyboardEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const sourceDesktop =
  process.argv.find((arg) => arg.startsWith("--source-desktop="))?.slice(17) || desktop;
const baseline = process.argv.includes("--expect-baseline-failures");
const development = process.argv.includes("--development");
const renderer = path.join(sourceDesktop, "src/renderer");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) || "/tmp/codeshell-ask-user-qa";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ChatView} from './ChatView';import {I18nProvider} from './i18n/I18nProvider';import {ToastProvider} from './ui/ToastProvider';import {saveUILanguage} from './uiLanguage';import {applyTheme,saveTheme} from './theme';
const noop=()=>{};let pending;window.answers=[];window.sends=[];
window.codeshell={sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>noop,listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:false}),log:noop};
function Fixture({scenario,variant,width,height,longDraft,longQuestion,initialQuestion}){
const [size,setSize]=React.useState({width,height});window.resizePane=(width,height)=>setSize({width,height});
const [questionVisible,setQuestionVisible]=React.useState(initialQuestion);
const [draft,setDraft]=React.useState(longDraft?('Long preserved composer draft'+String.fromCharCode(10)).repeat(30):'');
const [question,setQuestion]=React.useState(()=>({kind:'ask_user',id:'ask',requestId:'fixture-ask',header:'Review scope',question:longQuestion?('请逐项确认本次操作。'+ '这一项需要检查完整的页面内容、交互和保存反馈。'.repeat(30)):'请选择本次界面检查的范围。',multiSelect:scenario==='multi'||scenario==='async-multi'||scenario==='long-multi',asynchronous:scenario==='async-multi',optionsOnly:scenario==='single'||scenario==='long-single',
options:scenario==='free'?undefined:Array.from({length:scenario.startsWith('long-')?12:2},(_,i)=>({label:'方案 '+(i+1),description:scenario.startsWith('long-')?'逐项检查布局、文字、错误状态、键盘操作与较长内容，确保完整操作都可以到达。':'检查可见控件与键盘导航。'}))}));
window.fixture={get answers(){return window.answers},showQuestion(){setQuestionVisible(true)},refreshQuestion(){setQuestion(previous=>({...previous,options:previous.options?.map(option=>({...option}))}))},replaceQuestion(){setQuestion(previous=>({...previous,id:'next-ask',requestId:'fixture-next-ask',question:'第二个问题，请重新作答。',answer:undefined}))},finish(success){const operation=pending;if(!operation)throw new Error('No pending answer');pending=undefined;
if(success){setQuestion(previous=>({...previous,answer:operation.answer}));operation.resolve()}else operation.reject(new Error('Fixture answer denied'));}};
return <main style={{position:'fixed',top:0,left:0,width:size.width,height:size.height,overflow:'hidden'}} data-fixture-pane>
<ChatView variant={variant} messages={[{kind:'user',id:'user',text:'检查当前界面的交互。'},...(questionVisible?[question]:[])]} onSend={text=>window.sends.push(text)} onStop={noop} busy={false} activeProjectId='fixture' permissionMode='default' onPermissionChange={noop} goalEnabled={false} onGoalToggle={noop} modelOptions={[]} activeModelKey={null} onModelChange={noop} contextTokens={0} projects={[]} onSelectProject={noop} onAddProject={noop} configurationTarget={{noRepo:true}} configurationAvailable conversationRoot={null} conversationRootId={null} draft={draft} onDraftChange={setDraft} attachments={[]} onAttachmentsChange={noop}
onAskUserAnswer={(id,answer)=>{window.answers.push({id,answer});return new Promise((resolve,reject)=>{if(pending)throw new Error('Duplicate answer');pending={id,answer,resolve,reject}})}}/>
</main>;
}
const root=createRoot(document.getElementById('root'));let generation=0;
window.renderFixture=({scenario='single',lang='zh',mode='light',variant='main',width=390,height=540,longDraft=false,longQuestion=false,initialQuestion=true}={})=>{window.answers=[];window.sends=[];pending=undefined;localStorage.clear();saveUILanguage(lang);saveTheme(mode);applyTheme(mode);const current=++generation;
root.render(<React.StrictMode><I18nProvider key={current}><ToastProvider><div data-fixture-generation={current}><Fixture {...{scenario,variant,width,height,longDraft,longQuestion,initialQuestion}}/></div></ToastProvider></I18nProvider></React.StrictMode>);return current;};
`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": development ? '"development"' : '"production"' },
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
const reports = [],
  errors = [],
  blocked = [];
async function mount(options = {}) {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    serviceWorkers: "block",
    colorScheme: options.mode || "light",
  });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://ask-user-fixture.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://ask-user-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const generation = await page.evaluate((options) => window.renderFixture(options), options);
  await page
    .locator('[data-fixture-generation="' + generation + '"]')
    .waitFor({ state: "attached" });
  await page.locator("textarea").waitFor();
  return page;
}
const sticky = (page) => page.locator(".cs-chat-sticky");
const dock = (page) => page.locator(".cs-chat-composer-wrap .cs-chat-question-dock");
const answerInput = (page) => dock(page).locator('input:not([type="checkbox"])');
const submitAnswer = (page, lang = "zh") =>
  dock(page).getByRole("button", { name: lang === "zh" ? "发送回答" : "Send answer", exact: true });
const answerCalls = (page) => page.evaluate(() => window.answers);
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function sampleGeometryFrames(page) {
  await page.evaluate(() => {
    window.fixtureGeometryDone = new Promise((resolve) => {
      const samples = [];
      const sample = () => {
        const box = (selector) =>
          document.querySelector(selector)?.getBoundingClientRect().toJSON();
        const textarea = document.querySelector("textarea");
        samples.push({
          dock: box(".cs-chat-question-dock"),
          input: box('.cs-chat-question-dock input:not([type="checkbox"])'),
          composer: box("textarea"),
          wrap: box(".cs-chat-composer-wrap"),
          composerFocused: textarea === document.activeElement,
          composerValue: textarea.value,
          composerSelection: [textarea.selectionStart, textarea.selectionEnd],
        });
        if (samples.length === 20) resolve(samples);
        else requestAnimationFrame(sample);
      };
      sample();
    });
  });
}
function geometryDeviation(samples, reference, names) {
  return Math.max(
    ...samples.flatMap((sample) =>
      names.flatMap((name) =>
        ["x", "y", "width", "height"].map((key) =>
          Math.abs(sample[name][key] - reference[name][key]),
        ),
      ),
    ),
  );
}
async function screenshot(page, name) {
  const box = await page.locator("[data-fixture-pane]").boundingBox();
  await page.screenshot({ path: path.join(output, name + ".png"), clip: box });
}
async function hit(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return target === el || el.contains(target);
  });
}
async function contained(control, scroller) {
  const target = await control.boundingBox(),
    bounds = await scroller.boundingBox();
  return target.y >= bounds.y - 1 && target.y + target.height <= bounds.y + bounds.height + 1;
}
async function ime(page, input) {
  await input.fill("正在输入中文");
  await input.dispatchEvent("compositionstart");
  await input.evaluate((el) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })),
  );
  await input.dispatchEvent("compositionend");
  await input.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  await input.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, bubbles: true }),
    ),
  );
  await frames(page);
}
async function reject(page) {
  await page.evaluate(() => window.fixture.finish(false));
  await page.getByRole("alert").filter({ hasText: "回答提交失败" }).waitFor();
}
try {
  if (baseline) {
    const single = await mount();
    assert.equal(
      await sticky(single).locator("button,input,[tabindex]").count(),
      0,
      "Baseline choices cannot receive keyboard focus",
    );
    await screenshot(single, "before-single-keyboard");
    await single.close();
    const free = await mount({ scenario: "free" });
    await sticky(free).locator("input").fill("正在输入中文");
    await sticky(free)
      .locator("input")
      .evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
        ),
      );
    assert.equal((await answerCalls(free)).length, 1, "Baseline composing Enter sends prematurely");
    await free.close();
    const identity = await mount({ scenario: "free" });
    await sticky(identity).locator("input").fill("Only for question A");
    await identity.evaluate(() => window.fixture.replaceQuestion());
    await identity.getByText("第二个问题，请重新作答。", { exact: true }).waitFor();
    assert.equal(
      await sticky(identity).locator("input").inputValue(),
      "Only for question A",
      "Baseline question replacement inherits old drafts",
    );
    await identity.close();
    const short = await mount({ scenario: "long-single", width: 390, height: 360 });
    const last = sticky(short).locator("li").last();
    assert.equal(await hit(last), false);
    const composer = await short.locator("textarea").boundingBox();
    assert.ok(composer.y > 360, "Baseline question pushes composer out of pane");
    await screenshot(short, "before-short-question");
    await short.close();
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          baseline: true,
          keyboardFails: true,
          questionIdentityLeaks: true,
          composingEnterSends: true,
          shortPaneClips: true,
          errors,
          blocked,
        },
        null,
        2,
      ),
    );
  } else {
    const single = await mount();
    const first = dock(single).getByRole("button", { name: "方案 1", exact: true });
    const submit = submitAnswer(single);
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await answerInput(single).count(), 0, "Options-only questions have no free input");
    await first.focus();
    await single.keyboard.press("Space");
    assert.equal(await first.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await answerCalls(single), [], "Choosing an option does not submit it");
    await single.keyboard.press("Enter");
    assert.deepEqual(await answerCalls(single), [], "Option Enter remains a selection action");
    await submit.click();
    await single.waitForFunction(() => window.answers.length === 1);
    assert.deepEqual(await answerCalls(single), [{ id: "fixture-ask", answer: "方案 1" }]);
    assert.equal(await submit.isDisabled(), true);
    await submit.dispatchEvent("click");
    assert.equal(
      (await answerCalls(single)).length,
      1,
      "Pending answers cannot be submitted twice",
    );
    await reject(single);
    assert.equal(await first.getAttribute("aria-pressed"), "true");
    assert.equal(await submit.evaluate((el) => el === document.activeElement), true);
    await single.keyboard.press("Enter");
    await single.waitForFunction(() => window.answers.length === 2);
    await single.evaluate(() => window.fixture.finish(true));
    await dock(single).waitFor({ state: "hidden" });
    await single.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    await single.close();

    const protectedFocus = await mount();
    await dock(protectedFocus).getByRole("button", { name: "方案 1", exact: true }).click();
    await submitAnswer(protectedFocus).click();
    const outsideControl = protectedFocus.locator("textarea");
    await outsideControl.focus();
    await protectedFocus.evaluate(() => window.fixture.finish(true));
    await dock(protectedFocus).waitFor({ state: "hidden" });
    await frames(protectedFocus);
    assert.equal(
      await outsideControl.evaluate((el) => el === document.activeElement),
      true,
      "A completed answer keeps the user's new focus",
    );
    await protectedFocus.close();

    const stable = await mount({ scenario: "other", width: 760, height: 700 });
    const stableInput = answerInput(stable);
    assert.equal(await stableInput.count(), 1, "The free answer input is present before selection");
    assert.equal(await stableInput.getAttribute("autofocus"), null);
    const geometry = async (page) => ({
      dock: await dock(page).boundingBox(),
      input: await answerInput(page).boundingBox(),
      composer: await page.locator("textarea").boundingBox(),
    });
    const beforeSelection = await geometry(stable);
    const selectionFrames = [];
    await stableInput.evaluate((el) => {
      window.originalAnswerInput = el;
    });
    for (const option of ["方案 1", "方案 2", "方案 1"]) {
      await sampleGeometryFrames(stable);
      await dock(stable).getByRole("button", { name: option, exact: true }).click();
      const samples = await stable.evaluate(() => window.fixtureGeometryDone);
      const peakDeviation = geometryDeviation(samples, beforeSelection, [
        "dock",
        "input",
        "composer",
      ]);
      assert.ok(
        peakDeviation <= 0.5,
        "Selection does not animate or oscillate the question/input layout",
      );
      selectionFrames.push({ option, peakDeviation, samples });
      const current = await geometry(stable);
      for (const name of ["dock", "input", "composer"])
        for (const key of ["x", "y", "width", "height"])
          assert.ok(
            Math.abs(current[name][key] - beforeSelection[name][key]) <= 0.5,
            `${option} changes ${name}.${key}: ${JSON.stringify({ beforeSelection, current })}`,
          );
      assert.equal(await stableInput.inputValue(), "");
      assert.equal(
        await stableInput.evaluate((el) => el === window.originalAnswerInput),
        true,
        "Selection keeps the existing input DOM node",
      );
    }
    assert.equal(await dock(stable).locator('button[aria-pressed="true"]').count(), 1);
    assert.deepEqual(await answerCalls(stable), []);
    await stableInput.fill("保留正在编辑的草稿");
    assert.equal(await dock(stable).locator('button[aria-pressed="true"]').count(), 0);
    await stableInput.focus();
    await stableInput.evaluate((el) => el.setSelectionRange(2, 6));
    await stableInput.dispatchEvent("compositionstart");
    await stable.evaluate(() => window.fixture.refreshQuestion());
    await frames(stable);
    assert.deepEqual(
      await stableInput.evaluate((el) => ({
        same: el === window.originalAnswerInput,
        focused: el === document.activeElement,
        value: el.value,
        start: el.selectionStart,
        end: el.selectionEnd,
      })),
      { same: true, focused: true, value: "保留正在编辑的草稿", start: 2, end: 6 },
      "A same-request update preserves the composing input, draft, focus and selection",
    );
    await stableInput.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    assert.deepEqual(await answerCalls(stable), []);
    await stableInput.dispatchEvent("compositionend");
    await screenshot(stable, "stable-selection-and-draft");
    reports.push({
      case: "selection-geometry",
      before: beforeSelection,
      after: await geometry(stable),
      selectionFrames,
    });
    await stable.close();

    const arrival = await mount({ scenario: "other", initialQuestion: false });
    const composerDraft = arrival.locator("textarea");
    await composerDraft.fill("问题到来时保留我的输入");
    await composerDraft.focus();
    await composerDraft.evaluate((el) => el.setSelectionRange(2, 5));
    await composerDraft.dispatchEvent("compositionstart");
    await sampleGeometryFrames(arrival);
    await arrival.evaluate(() => window.fixture.showQuestion());
    await dock(arrival).waitFor();
    const arrivalFrames = await arrival.evaluate(() => window.fixtureGeometryDone);
    const arrivalPeakDeviation = geometryDeviation(arrivalFrames.slice(4), arrivalFrames.at(-1), [
      "dock",
      "input",
      "composer",
      "wrap",
    ]);
    assert.ok(
      arrivalPeakDeviation <= 0.5,
      "The question settles without ongoing frame-to-frame layout changes",
    );
    for (const sample of arrivalFrames) {
      assert.equal(sample.composerFocused, true);
      assert.equal(sample.composerValue, "问题到来时保留我的输入");
      assert.deepEqual(sample.composerSelection, [2, 5]);
    }
    assert.deepEqual(
      await composerDraft.evaluate((el) => ({
        focused: el === document.activeElement,
        value: el.value,
        start: el.selectionStart,
        end: el.selectionEnd,
      })),
      { focused: true, value: "问题到来时保留我的输入", start: 2, end: 5 },
      "An arriving question does not steal the composer's focus or draft",
    );
    await composerDraft.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await composerDraft.dispatchEvent("compositionend");
    assert.deepEqual(await arrival.evaluate(() => window.sends), []);
    assert.deepEqual(await answerCalls(arrival), []);
    reports.push({
      case: "question-arrival",
      settledPeakDeviation: arrivalPeakDeviation,
      samples: arrivalFrames,
    });
    await arrival.close();

    const multi = await mount({ scenario: "multi" });
    const checkboxes = dock(multi).getByRole("checkbox");
    assert.equal(await checkboxes.count(), 2);
    await checkboxes.nth(1).focus();
    await multi.keyboard.press("Space");
    assert.equal(await checkboxes.nth(1).getAttribute("aria-checked"), "true");
    await dock(multi).getByText("方案 2", { exact: true }).click();
    assert.equal(await checkboxes.nth(1).getAttribute("aria-checked"), "false");
    await dock(multi).getByText("方案 2", { exact: true }).click();
    await checkboxes.nth(1).focus();
    await multi.keyboard.press("Shift+Tab");
    assert.equal(await checkboxes.first().evaluate((el) => el === document.activeElement), true);
    await multi.keyboard.press("Space");
    const input = answerInput(multi);
    await input.fill("只检查文档");
    await submitAnswer(multi).click();
    assert.deepEqual(await answerCalls(multi), [
      { id: "fixture-ask", answer: "方案 2, 方案 1, 只检查文档" },
    ]);
    await reject(multi);
    assert.equal(await checkboxes.first().getAttribute("aria-checked"), "true");
    assert.equal(await input.inputValue(), "只检查文档");
    await multi.close();

    for (const scenario of ["free", "other"]) {
      const page = await mount({ scenario });
      const input = answerInput(page);
      await ime(page, input);
      assert.deepEqual(await answerCalls(page), [], "Every composing Enter path preserves drafts");
      assert.equal(await input.inputValue(), "正在输入中文");
      await input.press("Enter");
      assert.deepEqual(await answerCalls(page), [{ id: "fixture-ask", answer: "正在输入中文" }]);
      await reject(page);
      assert.equal(await input.inputValue(), "正在输入中文");
      assert.equal(await input.evaluate((el) => el === document.activeElement), true);
      await page.close();
    }
    for (const scenario of ["free", "multi", "other"]) {
      const identity = await mount({ scenario });
      if (scenario === "multi") await dock(identity).getByRole("checkbox").first().click();
      if (scenario === "other")
        await dock(identity).getByRole("button", { name: "方案 1", exact: true }).click();
      await answerInput(identity).fill("Only for question A");
      await identity.evaluate(() => window.fixture.replaceQuestion());
      await identity.getByText("第二个问题，请重新作答。", { exact: true }).waitFor();
      assert.equal(await answerInput(identity).inputValue(), "");
      assert.equal(
        await dock(identity).locator('[aria-checked="true"], [aria-pressed="true"]').count(),
        0,
      );
      assert.deepEqual(await answerCalls(identity), []);
      await identity.close();
    }

    const asynchronous = await mount({ scenario: "async-multi" });
    const group = asynchronous.getByRole("group", {
      name: "请选择本次界面检查的范围。",
      exact: true,
    });
    await group.getByRole("checkbox", { name: "方案 1", exact: true }).click();
    await group.locator('input:not([type="checkbox"])').fill("稍后继续的草稿");
    await group.getByRole("button", { name: "稍后回答", exact: true }).click();
    assert.equal(await group.getByRole("checkbox").count(), 0);
    await group.getByRole("button", { name: "回答问题", exact: true }).click();
    assert.equal(
      await group
        .getByRole("checkbox", { name: "方案 1", exact: true })
        .getAttribute("aria-checked"),
      "true",
    );
    assert.equal(
      await group.locator('input:not([type="checkbox"])').inputValue(),
      "稍后继续的草稿",
    );
    assert.deepEqual(await answerCalls(asynchronous), []);
    await asynchronous.close();

    for (const size of [
      { width: 320, height: 280 },
      { width: 390, height: 360 },
      { width: 480, height: 240 },
      { width: 760, height: 360 },
    ])
      for (const variant of ["main", "quickChat"])
        for (const lang of ["zh", "en"])
          for (const mode of ["light", "dark"]) {
            const page = await mount({
              ...size,
              variant,
              lang,
              mode,
              scenario: "long-single",
              longDraft: true,
            });
            const choices = dock(page).locator("button[aria-pressed]");
            assert.equal(await choices.count(), 12);
            assert.equal(
              await sticky(page).count(),
              0,
              "Questions belong to the composer, not the approval dock",
            );
            await choices.first().focus();
            for (let index = 1; index < 12; index++) await page.keyboard.press("Tab");
            assert.equal(
              await choices.last().evaluate((el) => el === document.activeElement),
              true,
            );
            assert.equal(await hit(choices.last()), true, "Tab scrolls the final choice into view");
            await page.keyboard.press("Space");
            assert.deepEqual(await answerCalls(page), []);
            await page.keyboard.press("Tab");
            const answerSend = submitAnswer(page, lang);
            assert.equal(await answerSend.evaluate((el) => el === document.activeElement), true);
            assert.equal(await hit(answerSend), true, "The explicit answer action stays reachable");
            const pane = await page.locator("[data-fixture-pane]").boundingBox(),
              askBox = await dock(page).boundingBox(),
              composerBox = await page.locator(".cs-chat-composer-wrap").boundingBox();
            assert.ok(
              composerBox.y >= pane.y - 1 &&
                composerBox.y + composerBox.height <= pane.y + pane.height + 1,
            );
            assert.equal(await contained(answerSend, page.locator(".cs-chat-composer-wrap")), true);
            const overflow = await page.locator("[data-fixture-pane]").evaluate((pane) =>
              [
                pane,
                pane.querySelector(".cs-chat-root"),
                pane.querySelector(".cs-chat-composer-wrap"),
                pane.querySelector(".cs-chat-question-dock"),
              ]
                .filter(Boolean)
                .map((el) => ({
                  className: el.className,
                  scrollWidth: el.scrollWidth,
                  clientWidth: el.clientWidth,
                })),
            );
            for (const measured of overflow)
              assert.ok(
                measured.scrollWidth <= measured.clientWidth + 1,
                "No horizontal overflow: " + JSON.stringify(measured),
              );
            await page.keyboard.press("Tab");
            assert.equal(
              await page.locator("textarea").evaluate((el) => el === document.activeElement),
              true,
            );
            const send = page.getByRole("button", {
              name: lang === "zh" ? "发送" : "Send",
              exact: true,
            });
            for (
              let step = 0;
              step < 10 && !(await send.evaluate((el) => el === document.activeElement));
              step++
            )
              await page.keyboard.press("Tab");
            assert.equal(await send.evaluate((el) => el === document.activeElement), true);
            assert.equal(await hit(send), true, "The main draft's send action stays reachable");
            assert.equal(await contained(send, page.locator(".cs-chat-composer-wrap")), true);
            await answerSend.focus();
            await screenshot(page, `after-${variant}-${size.width}x${size.height}-${lang}-${mode}`);
            reports.push({ ...size, variant, lang, mode, askBox, composerBox, overflow });
            await page.evaluate(() => window.resizePane(390, 200));
            await frames(page);
            assert.equal(await answerSend.evaluate((el) => el === document.activeElement), true);
            assert.equal(
              await hit(answerSend),
              true,
              "Focused answer survives container-only resize",
            );
            await page.close();
          }

    for (const variant of ["main", "quickChat"]) {
      const page = await mount({
        scenario: "long-multi",
        variant,
        width: 320,
        height: 240,
        longQuestion: true,
        longDraft: true,
      });
      const choices = dock(page).getByRole("checkbox");
      await choices.first().focus();
      for (let index = 1; index < 12; index++) await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      await page.keyboard.press("Tab");
      assert.equal(await answerInput(page).evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("Tab");
      const submit = submitAnswer(page);
      assert.equal(await submit.evaluate((el) => el === document.activeElement), true);
      assert.equal(
        await hit(submit),
        true,
        "Long questions and twelve choices keep the answer action reachable",
      );
      assert.equal(await contained(submit, page.locator(".cs-chat-composer-wrap")), true);
      await screenshot(page, `after-long-multi-${variant}-320x240`);
      await page.keyboard.press("Enter");
      assert.deepEqual(await answerCalls(page), [{ id: "fixture-ask", answer: "方案 12" }]);
      await page.close();
    }
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          baseline: false,
          runtime: development ? "development" : "production",
          explicitSingleSelection: true,
          stableSelectionGeometry: true,
          sameInputNodeAndComposition: true,
          arrivalPreservesComposerFocus: true,
          longQuestionMultiSubmit: true,
          preservesOutsideFocus: true,
          keyboardChoices: true,
          questionIdentityIsolated: true,
          multiContract: true,
          ime: true,
          failedAnswerKeepsDraft: true,
          asynchronous: true,
          noHorizontalOverflow: true,
          actualPaneHeight: true,
          reports,
          errors,
          blocked,
        },
        null,
        2,
      ),
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    `PASS AskUser ${baseline ? "baseline defects reproduced" : "explicit selection, stable drafts, IME and 32 container layouts"}: ${output}`,
  );
} finally {
  await browser.close();
}
