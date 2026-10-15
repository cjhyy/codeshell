/* Production ChatView/QuickChatPanel with owned draft/queue state and forbidden network. */
/* global document, window, requestAnimationFrame, getComputedStyle, HTMLElement */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const sourceDesktop =
  process.argv.find((arg) => arg.startsWith("--source-desktop="))?.slice(17) || desktop;
const renderer = path.join(sourceDesktop, "src/renderer");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const baseline = process.argv.includes("--expect-baseline-overflow");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  "/tmp/codeshell-composer-overflow-qa";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ChatView} from './ChatView';import {QuickChatPanel} from './panels/QuickChatPanel';
import {I18nProvider} from './i18n/I18nProvider';import {ToastProvider} from './ui/ToastProvider';
import {saveUILanguage} from './uiLanguage';import {applyTheme,saveTheme} from './theme';import {translate} from './i18n/translate';
const noop=()=>{};window.codeshell={sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>noop,listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']}),log:noop};
const history=[{kind:'user',id:'human',text:'Review the current interface.'},{kind:'assistant',id:'assistant',text:('Earlier output with preserved reading context. '+String.fromCharCode(10)).repeat(30),done:true}];
const makeQueue=count=>Array.from({length:count},(_,i)=>'Queued message '+(i+1));
function Fixture({variant,width,height,queueCount=0,draftLines=0,busy=false,newChat=false,pending=false}){
 const [empty,setEmpty]=React.useState(newChat);
 const [size,setSize]=React.useState({width,height});const [draft,setDraft]=React.useState(draftLines?Array.from({length:draftLines},(_,i)=>'Long draft line '+(i+1)).join(String.fromCharCode(10)):'Short draft');
 const [queue,setQueue]=React.useState(makeQueue(queueCount));const [running,setRunning]=React.useState(busy);
 window.fixture={draft:()=>draft,queue:()=>queue,resize:(width,height)=>setSize({width,height}),setQueue:count=>setQueue(makeQueue(count)),setDraft,setBusy:setRunning,setNewChat:setEmpty};
 const messages=pending?[...history,{kind:'ask_user',id:'ask',requestId:'owned-ask',header:'Review scope',question:'Choose a scope. '.repeat(60),optionsOnly:true,options:Array.from({length:12},(_,i)=>({label:'Option '+(i+1),description:'Review this complete option.'}))}]:empty?[]:history;
 const shared={messages,onSend:text=>window.calls.push(['send',text]),onStop:()=>{window.calls.push(['stop']);setRunning(false)},onAskUserAnswer:noop,busy:running,liveTurnActive:running,permissionMode:'default',onPermissionChange:noop,modelOptions:[{key:'fixture',label:'Fixture model',provider:'fixture',supportsVision:true}],activeModelKey:'fixture',onModelChange:noop,draft,onDraftChange:setDraft,attachments:[],onAttachmentsChange:noop};
 return <main data-fixture-pane style={{position:'fixed',top:0,left:0,width:size.width,height:size.height,overflow:'hidden',display:'flex',flexDirection:'column'}}>
 {variant==='quickChat'?<QuickChatPanel {...shared} sessionId='qchat-fixture' creationNonce='fixture' cwd='/fixture' creationStatus='ready' contextMode='blank' copiedEventCount={0} onRetry={noop} onUseBlank={noop}/>:<ChatView {...shared} variant='main' activeProjectId='fixture' goalEnabled={false} onGoalToggle={noop} contextTokens={0} projects={[]} onSelectProject={noop} onAddProject={noop} configurationTarget={{projectId:'fixture'}} configurationAvailable conversationRoot='/fixture' conversationRootId='root' welcomeNode={empty?<div data-owned-welcome><h2>Start a conversation</h2><p>Describe the next task.</p></div>:undefined} queuedInputCount={queue.length} queuedInputItems={queue} onQueueInput={text=>{window.calls.push(['queue',text]);setQueue(previous=>[...previous,text])}} onForceSend={text=>window.calls.push(['force',text])} onGuideQueuedInput={()=>window.calls.push(['guide-all',queue.slice()])} onClearQueuedInput={()=>{window.calls.push(['clear']);setQueue([])}} onRemoveQueuedInput={index=>{window.calls.push(['remove',index,queue[index]]);setQueue(previous=>previous.filter((_,i)=>i!==index))}}/>}
 </main>;
}
const root=createRoot(document.getElementById('root'));let generation=0;
window.renderFixture=options=>{localStorage.clear();saveUILanguage(options.lang||'en');saveTheme(options.mode||'light');applyTheme(options.mode||'light');window.calls=[];window.labels={send:translate(options.lang||'en','chat.composer.send'),stop:translate(options.lang||'en','chat.composer.stop'),guide:translate(options.lang||'en','chat.queue.guideAllAria'),remove:index=>translate(options.lang||'en','chat.queue.removeItemAria',{index}),clear:translate(options.lang||'en','chat.queue.clearAria'),force:translate(options.lang||'en','chat.composer.guideAria')};const current=++generation;root.render(<I18nProvider key={current}><ToastProvider><div data-fixture-generation={current}><Fixture {...options}/></div></ToastProvider></I18nProvider>);return current};
`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
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
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
const reports = [],
  cases = [],
  comparisons = [],
  errors = [],
  blocked = [];
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function mount(options = {}) {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    serviceWorkers: "block",
  });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://composer-overflow.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://composer-overflow.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const generation = await page.evaluate((options) => window.renderFixture(options), options);
  await page
    .locator('[data-fixture-generation="' + generation + '"]')
    .waitFor({ state: "attached" });
  await page.locator("textarea").waitFor();
  await frames(page);
  page.fixtureOptions = options;
  return page;
}
async function snapshot(page) {
  return page.evaluate(() => {
    const pane = document.querySelector("[data-fixture-pane]"),
      root = document.querySelector("[data-chat-variant]"),
      composer = document.querySelector(".cs-chat-composer-wrap"),
      textarea = document.querySelector("textarea"),
      stream = document.querySelector(".cs-chat-transcript")?.parentElement;
    const box = (element) => element?.getBoundingClientRect().toJSON();
    const hit = (element) => {
      if (!element) return false;
      const bounds = element.getBoundingClientRect(),
        outer = pane.getBoundingClientRect();
      if (bounds.height <= 0 || bounds.top < outer.top - 1 || bounds.bottom > outer.bottom + 1)
        return false;
      const target = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      return target === element || element.contains(target);
    };
    return {
      pane: box(pane),
      root: box(root),
      pending: root.getAttribute("data-pending-interaction"),
      rootScrollTop: root.scrollTop,
      rootScrollHeight: root.scrollHeight,
      rootClientHeight: root.clientHeight,
      composer: box(composer),
      composerScrollTop: composer.scrollTop,
      composerClientHeight: composer.clientHeight,
      composerScrollHeight: composer.scrollHeight,
      composerOverflow: getComputedStyle(composer).overflowY,
      textarea: box(textarea),
      textareaScrollHeight: textarea.scrollHeight,
      stream: box(stream),
      streamHeight: stream?.clientHeight,
      newChat: box(document.querySelector(".cs-new-chat")),
      buttons: Array.from(composer.querySelectorAll("button"))
        .filter((button) => !button.disabled)
        .map((button) => ({
          name: button.getAttribute("aria-label") || button.textContent,
          box: box(button),
          hit: hit(button),
        })),
      focusTag: document.activeElement?.tagName,
      focusName: document.activeElement?.getAttribute("aria-label"),
    };
  });
}
async function hit(locator) {
  return locator.evaluate((element) => {
    const target = element.getBoundingClientRect(),
      pane = document.querySelector("[data-fixture-pane]").getBoundingClientRect();
    if (
      target.width <= 0 ||
      target.height <= 0 ||
      target.left < pane.left - 1 ||
      target.right > pane.right + 1 ||
      target.top < pane.top - 1 ||
      target.bottom > pane.bottom + 1
    )
      return false;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      if (
        style.overflowX !== "visible" &&
        (target.left < bounds.left - 1 || target.right > bounds.right + 1)
      )
        return false;
      if (
        style.overflowY !== "visible" &&
        (target.top < bounds.top - 1 || target.bottom > bounds.bottom + 1)
      )
        return false;
    }
    const found = document.elementFromPoint(
      target.x + target.width / 2,
      target.y + target.height / 2,
    );
    return found === element || element.contains(found);
  });
}
async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(output, name + ".png"),
    clip: await page.locator("[data-fixture-pane]").boundingBox(),
  });
}
const label = (page, key, index) =>
  page.evaluate(
    ({ key, index }) =>
      typeof window.labels[key] === "function" ? window.labels[key](index) : window.labels[key],
    { key, index },
  );
const action = async (page, busy) =>
  page.getByRole("button", { name: await label(page, busy ? "stop" : "send"), exact: true });
async function wheelTo(page, target) {
  for (let i = 0; i < 12; i++) {
    if (await hit(target)) return;
    const geometry = await snapshot(page);
    const composer = geometry.composer,
      pane = geometry.pane;
    const y = Math.max(
      pane.top + 8,
      Math.min(
        pane.bottom - 8,
        (Math.max(composer.top, pane.top) + Math.min(composer.bottom, pane.bottom)) / 2,
      ),
    );
    await page.mouse.move(Math.max(pane.left + 4, composer.left + 4), y);
    await page.mouse.wheel(0, 120);
    await frames(page);
  }
  await screenshot(page, "wheel-failure");
  assert.equal(
    await hit(target),
    true,
    "Mouse wheel reaches the full action button " +
      JSON.stringify({ options: page.fixtureOptions, state: await snapshot(page) }),
  );
}
async function tabTo(page, targetName) {
  for (let i = 0; i < 64; i++) {
    await page.keyboard.press("Tab");
    await frames(page);
    const rootState = await snapshot(page);
    assert.equal(rootState.rootScrollTop, 0, "Keyboard scroll stays in the intended scrollers");
    const focused = await page.evaluate(() => {
      const element = document.activeElement,
        composer = document.querySelector(".cs-chat-composer-wrap");
      if (!(element instanceof HTMLElement) || !composer.contains(element)) return null;
      const target = element.getBoundingClientRect(),
        bounds = composer.getBoundingClientRect(),
        pane = document.querySelector("[data-fixture-pane]").getBoundingClientRect();
      const outer = document.querySelector(".cs-new-chat")?.getBoundingClientRect();
      return {
        tag: element.tagName,
        name: element.getAttribute("aria-label"),
        target: target.toJSON(),
        bounds: bounds.toJSON(),
        pane: pane.toJSON(),
        outer: outer?.toJSON(),
      };
    });
    if (focused) {
      if (focused.target.height <= focused.bounds.height)
        assert.ok(
          focused.target.top >= focused.bounds.top - 1 &&
            focused.target.bottom <= focused.bounds.bottom + 1,
          JSON.stringify(focused),
        );
      assert.ok(
        focused.target.top < focused.pane.bottom && focused.target.bottom > focused.pane.top,
        JSON.stringify(focused),
      );
      if (focused.name === targetName) return;
    }
  }
  assert.fail("Keyboard did not reach " + targetName);
}
async function assertFocusedAction(page, control) {
  assert.equal(await control.evaluate((element) => element === document.activeElement), true);
  if (!(await hit(control))) {
    await screenshot(page, "focus-failure");
    await writeFile(
      path.join(output, "focus-failure.json"),
      JSON.stringify(await snapshot(page), null, 2),
    );
  }
  assert.equal(
    await hit(control),
    true,
    "Focused action remains fully visible and hit-testable " + JSON.stringify(await snapshot(page)),
  );
  const bounds = await control.boundingBox(),
    composer = await page.locator(".cs-chat-composer-wrap").boundingBox();
  assert.ok(
    bounds.y >= composer.y - 1 && bounds.y + bounds.height <= composer.y + composer.height + 1,
  );
  const newChat = page.locator(".cs-new-chat");
  if (await newChat.count()) {
    const outer = await newChat.boundingBox();
    assert.ok(
      bounds.y >= outer.y - 1 && bounds.y + bounds.height <= outer.y + outer.height + 1,
      "New-chat parent also contains the focused action",
    );
  }
  assert.equal((await snapshot(page)).rootScrollTop, 0);
}
try {
  if (baseline) {
    const page = await mount({
      variant: "main",
      width: 320,
      height: 360,
      queueCount: 12,
      draftLines: 30,
      busy: true,
    });
    const initial = await snapshot(page);
    assert.ok(initial.composer.height > initial.pane.height);
    assert.equal(initial.streamHeight, 0);
    assert.equal(await hit(await action(page, true)), false);
    await page.mouse.move(160, 180);
    await page.mouse.wheel(0, 1600);
    await frames(page);
    const after = await snapshot(page);
    assert.equal(after.composerScrollTop, 0);
    assert.equal(after.rootScrollTop, 0);
    assert.equal(await hit(await action(page, true)), false);
    await screenshot(page, "before-main-320x360-queue-draft");
    reports.push({ case: "queue-mouse-clipped", initial, after });
    await page.close();
    const draft = await mount({ variant: "main", width: 800, height: 240, draftLines: 30 });
    assert.equal(await hit(await action(draft, false)), false);
    await screenshot(draft, "before-main-800x240-draft");
    reports.push({ case: "draft-send-clipped", state: await snapshot(draft) });
    await draft.close();
  } else {
    for (const width of [320, 800])
      for (const height of [240, 360, 480]) {
        const optionsList = [];
        for (const [lang, mode] of [
          ["zh", "light"],
          ["en", "dark"],
        ])
          for (const scenario of [
            { name: "draft", draftLines: 30 },
            { name: "queue-draft", draftLines: 30, queueCount: 12, busy: true },
          ])
            optionsList.push({ variant: "main", width, height, lang, mode, ...scenario });
        optionsList.push(
          { variant: "main", width, height, name: "short" },
          { variant: "main", width, height, name: "queue", queueCount: 12, busy: true },
        );
        for (const [newChat, busy, name] of [
          [true, false, "new-draft"],
          [true, true, "new-busy-draft"],
        ])
          optionsList.push({
            variant: "main",
            width,
            height,
            newChat,
            busy,
            draftLines: 30,
            name,
            lang: width === 320 ? "zh" : "en",
            mode: height === 360 ? "dark" : "light",
          });
        for (const busy of [false, true])
          optionsList.push({
            variant: "quickChat",
            width,
            height,
            busy,
            draftLines: 30,
            name: busy ? "quick-busy" : "quick-draft",
            lang: width === 320 ? "zh" : "en",
            mode: height === 360 ? "dark" : "light",
          });
        for (const options of optionsList) {
          const page = await mount(options);
          const initial = await snapshot(page);
          assert.equal(initial.pending, null);
          assert.ok(initial.composer.height <= initial.root.height + 1);
          assert.ok(initial.rootScrollHeight <= initial.rootClientHeight + 1);
          if (options.variant === "main" && !options.newChat)
            assert.ok(
              initial.streamHeight >= 63,
              "Active output remains readable " + JSON.stringify(options),
            );
          if (options.queueCount)
            assert.equal(
              await page
                .locator(".cs-chat-composer-wrap button[aria-label]")
                .filter({ hasText: options.lang === "zh" ? "删除" : "Delete" })
                .count(),
              12,
              "All queued items remain rendered",
            );
          if (
            options.variant === "main" &&
            width === 320 &&
            height === 360 &&
            options.name === "queue-draft"
          )
            await screenshot(page, "after-initial-" + options.lang + "-" + options.mode);
          const control = await action(page, !!options.busy);
          await wheelTo(page, control);
          assert.equal((await snapshot(page)).rootScrollTop, 0);
          if (
            options.variant === "main" &&
            width === 320 &&
            height === 360 &&
            options.name === "queue-draft"
          )
            await screenshot(page, "after-wheel-" + options.lang + "-" + options.mode);
          await page
            .locator(".cs-chat-composer-wrap")
            .evaluate((element) => (element.scrollTop = 0));
          await page.evaluate(() => document.activeElement?.blur());
          await tabTo(page, await label(page, options.busy ? "stop" : "send"));
          await assertFocusedAction(page, control);
          reports.push({ options, initial, after: await snapshot(page) });
          await page.close();
        }
      }
    for (const [lang, mode] of [
      ["zh", "dark"],
      ["en", "light"],
    ]) {
      const page = await mount({
        variant: "main",
        width: 320,
        height: 360,
        queueCount: 12,
        draftLines: 30,
        busy: true,
        lang,
        mode,
      });
      await screenshot(page, "after-initial-" + lang + "-" + mode);
      await wheelTo(page, await action(page, true));
      await screenshot(page, "after-wheel-" + lang + "-" + mode);
      await page.close();
    }
    for (const height of [240, 360, 480]) {
      const page = await mount({
        variant: "main",
        width: 320,
        height,
        queueCount: 12,
        draftLines: 30,
        busy: true,
      });
      const sixty = await snapshot(page);
      if (height === 360) await screenshot(page, "compare-60-percent");
      await page.addStyleTag({
        content:
          '[data-chat-variant="main"][data-mode="active"] .cs-chat-composer-wrap {max-height:70% !important}',
      });
      await frames(page);
      const seventy = await snapshot(page);
      if (height === 360) await screenshot(page, "compare-70-percent");
      comparisons.push({ height, sixty, seventy });
      await page.close();
    }
    const page = await mount({
      variant: "main",
      width: 800,
      height: 480,
      queueCount: 12,
      draftLines: 30,
      busy: true,
    });
    await page.getByRole("button", { name: await label(page, "guide"), exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
      "guide-all",
      Array.from({ length: 12 }, (_, i) => "Queued message " + (i + 1)),
    ]);
    cases.push("Guide callback runs once while the complete queue remains intact");
    const last = page.getByRole("button", { name: await label(page, "remove", 12), exact: true });
    await last.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
      "remove",
      11,
      "Queued message 12",
    ]);
    assert.equal((await page.evaluate(() => window.fixture.queue())).length, 11);
    cases.push("Remove retains the original index and other queue items");
    const input = page.locator("textarea");
    const draft = await input.inputValue();
    await input.focus();
    await page.keyboard.press("Enter");
    assert.equal((await page.evaluate(() => window.calls.at(-1)))[0], "queue");
    assert.equal((await page.evaluate(() => window.calls.at(-1)))[1], draft);
    assert.equal(await input.inputValue(), "");
    cases.push("Busy Enter queues the full draft and clears the accepted input");
    await input.fill("Force this preserved draft");
    const force = page.getByRole("button", { name: await label(page, "force"), exact: true });
    await force.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
      "force",
      "Force this preserved draft",
    ]);
    assert.equal(await input.inputValue(), "");
    cases.push("Guide draft keeps its existing force-send contract");
    const stop = await action(page, true);
    await stop.focus();
    for (const size of [
      [320, 240],
      [800, 480],
      [320, 360],
    ]) {
      await page.evaluate(([width, height]) => window.fixture.resize(width, height), size);
      await frames(page);
      await assertFocusedAction(page, stop);
    }
    for (const count of [0, 20, 5, 12]) {
      await page.evaluate((count) => window.fixture.setQueue(count), count);
      await frames(page);
      await assertFocusedAction(page, stop);
    }
    cases.push(
      "Focused Stop survives pane resize and queue growth without refocusing or scrolling the root",
    );
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Outside fixture";
      button.dataset.outside = "true";
      button.style.cssText = "position:fixed;left:1000px;top:740px";
      document.body.appendChild(button);
      button.focus();
      window.fixture.resize(320, 240);
      window.fixture.setQueue(20);
    });
    await frames(page);
    assert.equal(
      await page
        .locator("[data-outside]")
        .evaluate((element) => element === document.activeElement),
      true,
    );
    cases.push("Resize and queue updates preserve outside focus");
    await page.getByRole("button", { name: await label(page, "clear"), exact: true }).focus();
    await page.keyboard.press("Space");
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ["clear"]);
    assert.deepEqual(await page.evaluate(() => window.fixture.queue()), []);
    cases.push("Clear still removes the complete queue");
    await page.close();
    const focusedInput = await mount({
      variant: "main",
      width: 320,
      height: 360,
      draftLines: 30,
      busy: true,
    });
    await focusedInput.locator("textarea").focus();
    await focusedInput.locator("textarea").evaluate((element) => element.setSelectionRange(12, 20));
    await focusedInput.evaluate(() => window.fixture.setQueue(12));
    await frames(focusedInput);
    assert.deepEqual(
      await focusedInput.locator("textarea").evaluate((element) => ({
        active: element === document.activeElement,
        start: element.selectionStart,
        end: element.selectionEnd,
      })),
      { active: true, start: 12, end: 20 },
    );
    const inputState = await snapshot(focusedInput);
    assert.ok(
      inputState.textarea.top < inputState.composer.bottom &&
        inputState.textarea.bottom > inputState.composer.top,
    );
    assert.equal(inputState.rootScrollTop, 0);
    cases.push(
      "A focused long draft keeps its selection and a visible input slice when the queue arrives",
    );
    const preservedDraft = await focusedInput.locator("textarea").inputValue();
    await focusedInput.locator("textarea").dispatchEvent("compositionstart");
    await frames(focusedInput);
    await focusedInput
      .locator("textarea")
      .dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await focusedInput.locator("textarea").dispatchEvent("compositionend");
    assert.equal(await focusedInput.locator("textarea").inputValue(), preservedDraft);
    assert.deepEqual(await focusedInput.evaluate(() => window.calls), []);
    cases.push("Composing Enter preserves the focused draft without submitting");
    await focusedInput.close();
    const newChat = await mount({
      variant: "main",
      width: 800,
      height: 480,
      newChat: true,
      draftLines: 30,
    });
    const send = await action(newChat, false);
    await tabTo(newChat, await label(newChat, "send"));
    for (const size of [
      [320, 240],
      [800, 480],
      [320, 360],
    ]) {
      await newChat.evaluate(([width, height]) => window.fixture.resize(width, height), size);
      await frames(newChat);
      await assertFocusedAction(newChat, send);
    }
    cases.push("New-chat focused Send remains inside both scrolling ancestors on pane resize");
    await newChat.evaluate(() => window.fixture.setQueue(12));
    await frames(newChat);
    await assertFocusedAction(newChat, send);
    for (const empty of [false, true, false]) {
      await newChat.evaluate((empty) => window.fixture.setNewChat(empty), empty);
      await frames(newChat);
      await assertFocusedAction(newChat, send);
    }
    cases.push("New/active transitions and nested queue growth keep the focused Send visible");
    const idleDraft = await newChat.locator("textarea").inputValue();
    await newChat.locator("textarea").focus();
    await newChat.keyboard.press("Enter");
    assert.deepEqual(await newChat.evaluate(() => window.calls.at(-1)), ["send", idleDraft]);
    assert.equal(await newChat.locator("textarea").inputValue(), "");
    cases.push("Idle Enter sends the full draft through the existing send contract");
    await newChat.close();
    const quick = await mount({
      variant: "quickChat",
      width: 320,
      height: 240,
      draftLines: 30,
      busy: true,
    });
    const quickDraft = await quick.locator("textarea").inputValue();
    await quick.locator("textarea").focus();
    await quick.keyboard.press("Enter");
    assert.equal(await quick.locator("textarea").inputValue(), quickDraft);
    assert.deepEqual(await quick.evaluate(() => window.calls), []);
    cases.push("Quick Chat busy Enter preserves the draft without queueing or sending");
    await quick.close();
    for (const variant of ["main", "quickChat"]) {
      const pending = await mount({
        variant,
        width: 320,
        height: 360,
        queueCount: 12,
        draftLines: 30,
        busy: true,
        pending: true,
      });
      const state = await snapshot(pending);
      assert.equal(state.pending, "true");
      assert.ok(state.composer.height <= state.root.height * 0.4 + 1);
      assert.ok(
        (await pending.locator(".cs-chat-sticky").boundingBox()).height <=
          state.root.height * 0.6 + 1,
      );
      cases.push(variant + " retains pending 60/40 bounds");
      await pending.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { baseline, layouts: reports.length, cases, comparisons, errors, blocked, reports },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, baseline, layouts: reports.length, cases, errors, blocked }),
  );
} finally {
  await browser.close();
}
