/* Real MessageStream → process disclosure → production stick-to-bottom hook. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const phase = option("--phase") || "after";
assert.ok(["before", "after"].includes(phase), "--phase must be before or after");
const desktop = option("--desktop") || fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const output = option("--output") || "/tmp/codeshell-process-disclosure-qa/" + phase;
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MessageStream} from './MessageStream';
import {I18nProvider,useT} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';
const start=Date.now()-65000;
function messages(live,extra='',options={}){
  const zh=options.presentation&&options.lang==='zh';
  return [
    {kind:'user',id:'history-user',text:'Review the previous navigation changes.'},
    {kind:'assistant',id:'history-answer',done:true,text:Array.from({length:24},(_,i)=>'Previous result '+(i+1)+': the surrounding conversation remains readable while new work continues.').join('\\n\\n')},
    {kind:'user',id:'target-user',text:zh?'检查聊天过程展开与滚动行为。':'Check the disclosure behavior in this conversation.',turnTiming:{startedAt:start,durationMs:65000,completed:!live,completedCleanly:true}},
    ...(options.noIntro?[]:[{kind:'assistant',id:'target-intro',done:true,text:Array.from({length:options.presentation?4:14},(_,i)=>zh?'第 '+(i+1)+' 步：检查展开操作的阅读位置，并验证流式输出不会抢走焦点。':'Inspection step '+(i+1)+': retain this process detail while checking scrolling and following behavior.').join('\\n\\n')}]),
    ...Array.from({length:options.toolCount||3},(_,index)=>['Read','Grep','Bash'][index%3]).map((toolName,index)=>({kind:'tool',id:'target-tool-'+index,toolName,args:JSON.stringify(toolName==='Read'?{file_path:'/fixture/scroll.tsx'}:toolName==='Grep'?{pattern:'scrollTop',path:'/fixture'}:{command:'bun test scroll'}),status:options.runningTool&&live&&index===(options.toolCount||3)-1?'running':'succeeded',startedAt:start+index*10,endedAt:start+index*10+5,result:'Verified operation '+index})),
    {kind:'assistant',id:'target-answer',done:!live,text:(zh?'已验证展开、收起和对话滚动行为，检查结果保留在当前对话。':'Current answer: the disclosure must remain predictable while the user reads it. ')+extra},
    ...Array.from({length:options.laterTurns||0},(_,index)=>[
      {kind:'user',id:'later-user-'+index,text:'Later request '+index},
      {kind:'assistant',id:'later-answer-'+index,done:true,text:'Later completed answer '+index},
    ]).flat(),
  ];
}
window.codeshell={};
function Fixture({initialLive,...options}){
  const {t}=useT();
  window.jumpLabel=t('chat.stream.jumpToBottomAria');
  const [count,setCount]=React.useState(options.toolCount||3);
  window.addToolFixture=()=>setCount(value=>value+1);
  const [laterTurns,setLaterTurns]=React.useState(0);
  window.addLaterTurns=()=>setLaterTurns(6);
  const [live,setLive]=React.useState(initialLive);
  const [extra,setExtra]=React.useState('');
  window.completeFixture=()=>setLive(false);
  window.streamFixture=()=>setExtra(value=>value+'\\n\\n'+('New streaming output remains below the current reading position. ').repeat(8));
  return <main className="fixed inset-0 flex min-h-0 min-w-0 flex-col bg-background text-foreground"><MessageStream messages={messages(live,extra,{...options,toolCount:count,laterTurns})} engineSessionId="scroll-fixture" liveTurnActive={live} turnEpoch={live?0:1}/></main>;
}
const root=createRoot(document.getElementById('root'));let epoch=0;
window.renderFixture=props=>{saveUILanguage(props.lang||'zh');document.documentElement.classList.toggle('dark',props.mode==='dark');root.render(<I18nProvider key={++epoch}><Fixture {...props}/></I18nProvider>)};
window.scrollElement=()=>document.querySelector('.cs-chat-transcript').parentElement;
window.headerElement=()=>document.querySelector('.cs-process-heading');
window.metric=()=>{const s=window.scrollElement(),h=window.headerElement(),focus=document.activeElement,box=focus&&s.contains(focus)?focus.getBoundingClientRect():null;return {focusTop:box?.top??null,focusBottom:box?.bottom??null,focusLabel:box?(focus.getAttribute('aria-label')||focus.textContent||'').slice(0,80):null,time:performance.now(),scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight,headerTop:h.getBoundingClientRect().top,headerBottom:h.getBoundingClientRect().bottom,expanded:h.getAttribute('aria-expanded'),distance:s.scrollHeight-s.scrollTop-s.clientHeight,jump:!!document.querySelector('button[aria-label="'+window.jumpLabel+'"]')}};
// Transparent diagnostics: the native setter still performs every write.
// Native scroll anchoring does not call this JS setter; hook writes carry their source stack.
const scrollTopDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
Object.defineProperty(Element.prototype,'scrollTop',{...scrollTopDescriptor,set(value){
  const tracked=window.traceEvent&&this===window.scrollElement();
  const beforeTop=tracked?this.scrollTop:undefined;
  scrollTopDescriptor.set.call(this,value);
  if(tracked)window.traceEvent('scroll-write',{requested:value,beforeTop,stack:new Error('scrollTop write').stack});
}});
window.beginTrace=(name,duration=1000)=>{
  const frames=[];const begin=performance.now();
  const sample=(kind,extra={})=>frames.push({kind,...window.metric(),elapsed:performance.now()-begin,...extra});
  window.traceEvent=sample;
  sample('before');const s=window.scrollElement();const scroll=()=>sample('scroll');s.addEventListener('scroll',scroll);
  const ro=new ResizeObserver(()=>sample('resize'));ro.observe(s.firstElementChild);
  window.traceDone=new Promise(resolve=>{const tick=()=>{sample('frame');if(performance.now()-begin<duration)requestAnimationFrame(tick);else{s.removeEventListener('scroll',scroll);ro.disconnect();window.traceEvent=null;resolve({name,frames})}};requestAnimationFrame(tick)});
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
const context = await browser.newContext({
  reducedMotion: "reduce",
  serviceWorkers: "block",
  viewport: { width: 680, height: 520 },
});
const blocked = [],
  errors = [],
  assertionFailures = [],
  traces = [];
await context.route("**/*", (route) =>
  route.request().url() === "http://process-scroll.test/"
    ? route.fulfill({
        contentType: "text/html",
        body:
          '<!doctype html><html><head><meta charset="utf-8"><style>' +
          css +
          '</style></head><body><div id="root"></div><script>' +
          bundle.outputFiles[0].text +
          "</script></body></html>",
      })
    : (blocked.push(route.request().url()), route.abort()),
);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("http://process-scroll.test/");
async function render(live, props = {}) {
  await page.evaluate((value) => window.renderFixture(value), { initialLive: live, ...props });
  await page.locator(".cs-process-heading").waitFor();
  await page.waitForTimeout(200);
}
async function trace(name, action, check) {
  await page.evaluate((value) => window.beginTrace(value), name);
  await action();
  const result = await page.evaluate(() => window.traceDone);
  const painted = result.frames.filter(
    (frame) => frame.kind === "before" || frame.kind === "frame",
  );
  const first = painted[0],
    last = painted.at(-1);
  const range = (key) =>
    Math.max(...painted.map((frame) => frame[key])) -
    Math.min(...painted.map((frame) => frame[key]));
  const entry = {
    ...result,
    summary: {
      first,
      last,
      headerTopRange: range("headerTop"),
      scrollTopRange: range("scrollTop"),
    },
  };
  traces.push(entry);
  await page.screenshot({ path: path.join(output, name + ".png"), animations: "disabled" });
  console.log(name, JSON.stringify(entry.summary));
  if (phase === "after" && check) {
    try {
      check(entry);
    } catch (error) {
      assertionFailures.push({ name, error: error.stack });
      console.error(error.message);
    }
  }
  return entry;
}
const anchored = (entry) => {
  assert.ok(
    entry.summary.headerTopRange <= 2,
    entry.name + ": process header stays anchored in every frame: " + entry.summary.headerTopRange,
  );
  assert.ok(
    entry.summary.scrollTopRange <= 2,
    entry.name + ": reading scroll position stays fixed: " + entry.summary.scrollTopRange,
  );
};
const remains = (expanded) => (entry) =>
  assert.ok(
    entry.frames.every((frame) => frame.expanded === String(expanded)),
    entry.name + ": disclosure intent persists through every frame",
  );
async function pauseByWheel() {
  await page.mouse.move(340, 260);
  await page.mouse.wheel(0, -550);
  await page.waitForTimeout(180);
}
let failure;
try {
  await render(false);
  await trace(
    "historical-expand-at-bottom",
    () => page.locator(".cs-process-heading").click(),
    (entry) => {
      anchored(entry);
      assert.equal(entry.summary.last.expanded, "true");
      assert.equal(entry.summary.last.jump, true);
    },
  );
  await trace(
    "historical-expanded-stream",
    () => page.evaluate(() => window.streamFixture()),
    anchored,
  );
  await trace(
    "historical-collapse",
    () => page.locator(".cs-process-heading").click(),
    (entry) => {
      anchored(entry);
      assert.equal(entry.summary.last.expanded, "false");
    },
  );
  await render(true);
  await trace(
    "live-complete-following",
    () => page.evaluate(() => window.completeFixture()),
    (entry) => {
      remains(true)(entry);
      assert.ok(entry.summary.headerTopRange < 64, entry.name + ": no forced collapse jump");
      assert.ok(entry.summary.last.distance <= 2, entry.name + ": still follows bottom");
    },
  );
  await render(true);
  await pauseByWheel();
  await trace(
    "live-complete-paused",
    () => page.evaluate(() => window.completeFixture()),
    (entry) => {
      remains(true)(entry);
      anchored(entry);
      assert.equal(entry.summary.last.jump, true);
    },
  );
  await render(true);
  await pauseByWheel();
  await trace(
    "stream-while-paused",
    () => page.evaluate(() => window.streamFixture()),
    (entry) => {
      anchored(entry);
      assert.equal(entry.summary.last.jump, true);
    },
  );
  const jumpLabel = await page.evaluate(() => window.jumpLabel);
  await page.getByRole("button", { name: jumpLabel, exact: true }).click();
  await trace(
    "stream-after-explicit-jump",
    () => page.evaluate(() => window.streamFixture()),
    (entry) =>
      assert.ok(entry.summary.last.distance <= 2, entry.name + ": explicit jump rearms following"),
  );
  await render(true);
  await pauseByWheel();
  await page.mouse.wheel(0, 10000);
  await page.waitForTimeout(180);
  await trace(
    "stream-after-wheel-to-bottom",
    () => page.evaluate(() => window.streamFixture()),
    (entry) => {
      assert.ok(entry.summary.last.distance <= 2, entry.name + ": user wheel rearms following");
      assert.equal(entry.summary.last.jump, false);
    },
  );
  for (const modifier of ["Control", "Meta", ""]) {
    await render(false);
    const heading = page.locator(".cs-process-heading");
    await heading.click();
    await page.waitForTimeout(1100);
    await heading.focus();
    const end = await trace(
      "history-" + (modifier || "Plain") + "-End",
      () => heading.press(modifier ? modifier + "+End" : "End"),
      (entry) => {
        const nativeAttempted =
          entry.summary.last.distance < entry.summary.first.distance - 2 ||
          entry.frames.some(
            (frame) =>
              frame.kind === "scroll-write" && frame.beforeTop > entry.summary.first.scrollTop + 2,
          );
        entry.nativeEndAttempted = nativeAttempted;
        if (nativeAttempted)
          assert.ok(
            entry.summary.last.distance <= 2,
            entry.name + ": native end scroll is allowed",
          );
      },
    );
    if (end.nativeEndAttempted)
      await trace(
        "stream-after-" + (modifier || "Plain") + "-End",
        () => page.evaluate(() => window.streamFixture()),
        (entry) => {
          assert.ok(
            entry.summary.last.distance <= 2,
            entry.name + ": modified end rearms following",
          );
          assert.equal(entry.summary.last.jump, false);
        },
      );
  }
  await render(false);
  await page.locator(".cs-process-heading").click();
  await page.waitForTimeout(1100);
  await page.locator(".cs-process-heading").focus();
  const visibleFocus = (entry) => {
    assert.ok(
      entry.summary.last.focusTop >= 0,
      entry.name + ": focused control is below viewport top",
    );
    assert.ok(
      entry.summary.last.focusBottom <= entry.summary.last.clientHeight + 1,
      entry.name + ": focused control is above viewport bottom",
    );
    assert.ok(entry.summary.last.focusLabel, entry.name + ": a transcript control owns focus");
  };
  await trace("history-Tab-to-tools", () => page.keyboard.press("Tab"), visibleFocus);
  await trace(
    "history-Tab-stream",
    () => page.evaluate(() => window.streamFixture()),
    (entry) => {
      anchored(entry);
      visibleFocus(entry);
    },
  );
  await trace("history-ShiftTab-to-header", () => page.keyboard.press("Shift+Tab"), visibleFocus);
  await render(true);
  await page.mouse.move(340, 260);
  await page.mouse.wheel(0, -550);
  await page.waitForTimeout(80);
  await page.locator(".cs-process-heading").click();
  await trace(
    "wheel-then-disclosure-completion",
    () => page.evaluate(() => window.completeFixture()),
    (entry) => {
      remains(false)(entry);
      anchored(entry);
    },
  );
  await trace(
    "wheel-then-disclosure-stream",
    () => page.evaluate(() => window.streamFixture()),
    anchored,
  );
  await render(true, { noIntro: true, toolCount: 1, runningTool: true });
  await page.locator(".cs-process-heading").click();
  await page.evaluate(() => (window.savedProcessHeader = window.headerElement()));
  await trace(
    "live-closed-group-growth",
    () => page.evaluate(() => window.addToolFixture()),
    remains(false),
  );
  if (phase === "after")
    assert.equal(
      await page.evaluate(() => window.savedProcessHeader === window.headerElement()),
      true,
      "first-tool to tool-group folding retains the same process component",
    );
  await trace(
    "live-closed-completion",
    () => page.evaluate(() => window.completeFixture()),
    (entry) => {
      remains(false)(entry);
      anchored(entry);
      assert.equal(entry.summary.last.jump, true);
    },
  );
  await trace(
    "live-closed-completion-stream",
    () => page.evaluate(() => window.streamFixture()),
    anchored,
  );
  await render(true, { runningTool: true });
  const toolGroup = page.locator(".cs-process-content > div > button[aria-expanded]").first();
  await toolGroup.click();
  assert.equal(await toolGroup.getAttribute("aria-expanded"), "false");
  await trace(
    "inner-group-closed-completion",
    () => page.evaluate(() => window.completeFixture()),
    (entry) => {
      remains(true)(entry);
      anchored(entry);
    },
  );
  if (phase === "after")
    assert.equal(
      await toolGroup.getAttribute("aria-expanded"),
      "false",
      "explicit inner tool-group closure survives completion",
    );
  await render(false);
  await page.locator(".cs-process-heading").click();
  await page.evaluate(() => (window.savedProcessHeader = window.headerElement()));
  await trace(
    "history-expanded-crosses-tail-cutoff",
    () => page.evaluate(() => window.addLaterTurns()),
    remains(true),
  );
  if (phase === "after")
    assert.equal(
      await page.evaluate(() => window.savedProcessHeader === window.headerElement()),
      true,
      "crossing the content-visibility tail cutoff retains the same process component",
    );
  await render(true, { presentation: true });
  await page.waitForTimeout(1200);
  const beforeSelection = await page.evaluate(() => window.metric());
  const selectionTarget = await page.evaluate(() => {
    const pane = window.scrollElement().getBoundingClientRect();
    const paragraph = [...document.querySelectorAll(".cs-chat-transcript p")].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.top > pane.top + 20 &&
        rect.bottom < pane.bottom - 30 &&
        element.textContent.length > 20
      );
    });
    if (!paragraph) throw new Error("No visible selectable paragraph");
    const rect = paragraph.getBoundingClientRect();
    return { x: rect.left + 30, y: rect.top + 9, edgeY: pane.top - 20 };
  });
  await page.mouse.move(selectionTarget.x, selectionTarget.y);
  await page.mouse.down();
  await page.mouse.move(selectionTarget.x, selectionTarget.edgeY, { steps: 15 });
  await page.waitForTimeout(800);
  const draggingSelection = await page.evaluate(() => ({
    ...window.metric(),
    selectedCharacters: window.getSelection()?.toString().length ?? 0,
  }));
  await page.mouse.up();
  await page.waitForTimeout(100);
  const afterSelection = await page.evaluate(() => window.metric());
  assert.ok(
    draggingSelection.selectedCharacters > 0,
    "native pointer drag selects real transcript text",
  );
  assert.ok(
    beforeSelection.scrollTop - afterSelection.scrollTop > 20,
    "text selection auto-scroll moves upward",
  );
  const selectionStream = await trace(
    "pointer-selection-stream",
    () => page.evaluate(() => window.streamFixture()),
    anchored,
  );
  selectionStream.selectionDrag = {
    before: beforeSelection,
    dragging: draggingSelection,
    after: afterSelection,
    target: selectionTarget,
  };
  for (const lang of ["zh", "en"])
    for (const mode of ["light", "dark"])
      for (const width of [680, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 360 : 520 });
        await render(false, { lang, mode, presentation: true });
        await page.locator(".cs-process-heading").screenshot({
          path: path.join(output, "collapsed-" + lang + "-" + mode + "-" + width + ".png"),
          animations: "disabled",
        });
        await trace(
          "layout-" + lang + "-" + mode + "-" + width,
          async () => {
            const heading = page.locator(".cs-process-heading");
            if (lang === "en") {
              await heading.focus();
              await heading.press("Space");
              assert.equal(
                await heading.evaluate((element) => document.activeElement === element),
                true,
                "keyboard disclosure preserves button focus",
              );
            } else await heading.click();
          },
          (entry) => {
            anchored(entry);
            assert.equal(entry.summary.last.expanded, "true");
          },
        );
        const geometry = await page.evaluate(() => ({
          width: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          headerWidth: window.headerElement().getBoundingClientRect().width,
          processWidth: window.headerElement().parentElement.clientWidth,
        }));
        assert.ok(
          geometry.scrollWidth <= geometry.width + 1,
          "no page overflow " + JSON.stringify(geometry),
        );
        assert.ok(
          geometry.headerWidth <= geometry.processWidth + 1,
          "header fits process container " + JSON.stringify(geometry),
        );
        await page.evaluate(() => document.activeElement?.blur());
        const presentationDelta = await page.evaluate(
          () => window.headerElement().getBoundingClientRect().top - 16,
        );
        await page.mouse.move(width / 2, 180);
        await page.mouse.wheel(0, presentationDelta);
        await page.waitForTimeout(180);
        await page.mouse.move(width - 2, 2);
        await page.screenshot({
          path: path.join(output, "preview-" + lang + "-" + mode + "-" + width + ".png"),
          animations: "disabled",
        });
      }
} catch (error) {
  failure = error.stack;
  console.error(failure);
} finally {
  await browser.close();
}
const report = {
  phase,
  result: failure || assertionFailures.length || errors.length || blocked.length ? "fail" : "pass",
  traces,
  assertionFailures,
  errors,
  blockedRequests: blocked,
  failure,
  output,
};
await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
if (report.result !== "pass") process.exitCode = 1;
