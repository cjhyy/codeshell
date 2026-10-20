/** Whole production conversation/activity block; data-only mock, no model/network.
 * Run with scripts/run-isolated-node-smoke.mjs. Optional --phase before|after,
 * --source-desktop /absolute/path/to/packages/desktop and --output /absolute/path.
 */
/* global window, document, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
assert.ok(process.env.CODE_SHELL_TEST_HOME, "Use scripts/run-isolated-node-smoke.mjs");
const phase = option("--phase") || "after";
assert.ok(["before", "after"].includes(phase));
const ownDesktop = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = option("--source-desktop") || ownDesktop;
const renderer = path.join(desktop, "src/renderer");
const output = option("--output") || "/tmp/codeshell-chat-activity-harmony-qa/" + phase;
await mkdir(output, { recursive: true });
const require = createRequire(path.join(ownDesktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {MessageStream} from './MessageStream';import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';import {saveTheme,applyTheme} from './theme';
const root=createRoot(document.getElementById('root'));let generation=0;
window.codeshell={log:()=>{}};
function Fixture({lang,theme,variant,paneWidth,history=false}){
 const zh=lang==='zh';const [live,setLive]=React.useState(true);const [extra,setExtra]=React.useState('');
 window.completeFixture=()=>setLive(false);window.appendFixture=()=>setExtra(value=>value+'\\n\\n'+(zh?'补充结果保留在当前对话，阅读位置保持不变。':'Additional result stays in this conversation without taking the reading position. ').repeat(5));
 const start=React.useRef(Date.now()-12500).current;
 const narration=zh?'我会先查看所选 Figma 页面，再核对画板结构与组件命名，最后整理需要调整的地方。':'I will inspect the selected Figma page, check its frames and component names, then summarize the changes.';
 const result=zh?'已检查所选页面的 3 个画板。页面结构清晰，建议统一按钮高度与卡片左右间距；原始内容已保留。':'Reviewed the three selected frames. The structure is clear; align button heights and card gutters. The original content is preserved.';
 const actions=['figma.file.get','figma.page.inspect','figma.components.list'];
 const messages=[
 ...(history?[{kind:'user',id:'earlier-user',text:'Earlier request'},{kind:'assistant',id:'earlier-answer',done:true,text:Array.from({length:22},(_,i)=>'Earlier paragraph '+i+': surrounding conversation remains available while inspecting current activity.').join('\\n\\n')}]:[]),
 {kind:'user',id:'previous-user',text:zh?'这份设计稿可以继续沿用现有组件吗？':'Can this design reuse our existing components?'},
 {kind:'assistant',id:'previous-answer',done:true,text:zh?'可以。我会保留现有结构，先核对页面和组件，再给出具体建议。':'Yes. I will retain the existing structure and check the page and components before suggesting changes.'},
 {kind:'user',id:'current-user',text:zh?'查看当前选中的 Figma 页面，帮我检查布局和组件。':'Inspect the selected Figma page and review its layout and components.',turnTiming:{startedAt:start,durationMs:12500,completed:!live,completedCleanly:true}},
 {kind:'assistant',id:'narration',done:true,text:narration},
 ...actions.map((action,index)=>({kind:'tool',id:'link-'+index,toolName:'LinkAction',args:JSON.stringify({action,resource:'selected-figma-page'}),status:'succeeded',startedAt:start+index*100,endedAt:start+index*100+250,durationMs:250+index*130,summary:zh?'已读取所选内容并保留返回结果。':'Read the selected content and retained its result.',result:JSON.stringify({action,frames:3,status:'ok'},null,2)})),
 {kind:'assistant',id:'final-answer',done:!live,text:result+(history?'\\n\\n'+Array.from({length:10},()=>result).join('\\n\\n'):'')+extra},
 ];
 const wallpaper=theme==='dark'?'linear-gradient(135deg,#1b2933 0%,#2e3028 48%,#332938 100%)':'linear-gradient(135deg,#dce8e2 0%,#f2e5d3 48%,#e4dcec 100%)';
 return <main data-owned-pane data-chat-variant={variant} data-theme-surface="chat" className="fixed inset-y-0 left-1/2 flex min-h-0 min-w-0 -translate-x-1/2 flex-col text-foreground" style={{width:paneWidth,'--cs-surface-chat-image':wallpaper,'--cs-surface-chat-opacity':'1'}}>
 <MessageStream messages={messages} liveTurnActive={live} turnEpoch={live?0:1} engineSessionId="harmony-owned" readOnly/>
 </main>;
}
window.renderFixture=props=>{saveUILanguage(props.lang);saveTheme(props.theme);applyTheme(props.theme);const id=++generation;root.render(<I18nProvider key={id}><div data-generation={id}><Fixture {...props}/></div></I18nProvider>);return id};
window.scrollElement=()=>document.querySelector('.cs-chat-transcript').parentElement;
window.beginTrace=selector=>{const frames=[];const start=performance.now();window.traceDone=new Promise(resolve=>{const tick=()=>{const s=window.scrollElement(),h=document.querySelector(selector);frames.push({time:performance.now()-start,top:s.scrollTop,header:h.getBoundingClientRect().top,expanded:h.getAttribute('aria-expanded')});if(performance.now()-start<700)requestAnimationFrame(tick);else resolve(frames)};tick()})};
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".wav": "empty" },
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
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--disable-background-networking", "--disable-component-update", "--no-pings"],
});
const context = await browser.newContext({
  reducedMotion: "reduce",
  serviceWorkers: "block",
});
const blocked = [],
  errors = [],
  measurements = [],
  focus = [],
  traces = [];
await context.route("**/*", (route) =>
  route.request().url() === "https://activity-harmony-owned.test/"
    ? route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><meta charset="utf-8"><body><div id="root"></div></body></html>',
      })
    : (blocked.push(route.request().url()), route.abort()),
);
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => errors.push(error.message));
async function frames() {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}
async function mount(config) {
  const id = await page.evaluate((props) => window.renderFixture(props), config);
  await page.locator(`[data-generation="${id}"]`).waitFor({ state: "attached" });
  await page.locator(".cs-process-heading").waitFor();
  await frames();
}
async function measure(label) {
  await page.mouse.move(2, 2);
  await frames();
  const result = await page.evaluate(() => {
    const snapshot = (node) => {
      if (!node) return null;
      const style = window.getComputedStyle(node);
      return {
        box: node.getBoundingClientRect().toJSON(),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        background: style.backgroundColor,
        border: style.border,
        radius: style.borderRadius,
        padding: style.padding,
        paddingLeft: parseFloat(style.paddingLeft),
        outline: style.outline,
        shadow: style.boxShadow,
      };
    };
    const process = document.querySelector('[data-message-kind="process"]');
    const content = process.querySelector(".cs-process-content");
    const group = process.querySelector("[data-tool-group]");
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      pane: snapshot(document.querySelector("[data-owned-pane]")),
      process: snapshot(process),
      surface: snapshot(process.querySelector(".cs-process-surface") ?? process),
      header: snapshot(process.querySelector(".cs-process-heading")),
      content: snapshot(content),
      narration: snapshot(content?.querySelector("p")),
      group: snapshot(group),
      groupHeader: snapshot(group?.querySelector("button")),
      rows: [...process.querySelectorAll("[data-tool-card]")].map(snapshot),
      headings: [...process.querySelectorAll("[data-tool-heading]")].map(snapshot),
      adjacent: [...document.querySelectorAll('[data-message-kind="assistant"]')].map(snapshot),
    };
  });
  measurements.push({ label, ...result });
  assert.ok(result.document <= result.viewport + 1, label + ": document overflow");
  for (const row of result.rows) {
    assert.ok(row.scrollWidth <= row.clientWidth + 1, label + ": tool overflow");
    assert.ok(row.box.height >= 32 && row.box.height <= 36, label + ": compact height");
  }
  assert.equal(result.rows.length, 3, "Actual process contains three actual LinkAction records");
  if (phase === "after") {
    assert.ok(result.surface.background.startsWith("rgb("), label + ": opaque activity surface");
    for (const item of [result.header, result.content, result.group, ...result.rows])
      assert.equal(item.background, "rgba(0, 0, 0, 0)", label + ": no nested painted surface");
    const gutter = result.narration.box.left;
    assert.ok(
      Math.abs(gutter - result.header.box.left - result.header.paddingLeft) <= 1,
      label + ": narration and header gutter",
    );
    assert.ok(Math.abs(gutter - result.group.box.left) <= 1, label + ": group gutter");
    assert.ok(
      result.rows.every((row) => Math.abs(row.box.left - gutter) <= 1),
      label + ": row gutter",
    );
    assert.ok(
      Math.abs(
        result.surface.box.left - result.adjacent[0].box.left - result.adjacent[0].paddingLeft,
      ) <= 1,
      label + ": outer chat gutter",
    );
  }
  return result;
}
async function screenshot(name) {
  await page.evaluate(() => document.activeElement?.blur());
  await frames();
  await page.locator("[data-owned-pane]").screenshot({
    path: path.join(output, name + ".png"),
    animations: "disabled",
  });
}
async function trace(name, selector, action) {
  const header = page.locator(selector).first();
  // A previous disclosure deliberately retains its reading anchor. Release
  // it with real user scroll intent before positioning a different target.
  const pane = await page.locator("[data-owned-pane]").boundingBox();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.wheel(0, -1);
  await page.waitForTimeout(80);
  await header.scrollIntoViewIfNeeded();
  await frames();
  await page.evaluate((selector) => window.beginTrace(selector), selector);
  await action(header);
  const samples = await page.evaluate(() => window.traceDone);
  const range = (key) =>
    Math.max(...samples.map((sample) => sample[key])) -
    Math.min(...samples.map((sample) => sample[key]));
  const result = { name, headerRange: range("header"), scrollRange: range("top"), samples };
  traces.push(result);
  if (phase === "after")
    assert.ok(result.headerRange <= 2, name + ": anchor moved " + result.headerRange);
}
const configurations = [
  {
    label: "desktop-zh-light",
    lang: "zh",
    theme: "light",
    variant: "main",
    paneWidth: 720,
    width: 960,
    height: 700,
  },
  {
    label: "quick-zh-light",
    lang: "zh",
    theme: "light",
    variant: "quickChat",
    paneWidth: 320,
    width: 400,
    height: 680,
  },
  {
    label: "desktop-en-dark",
    lang: "en",
    theme: "dark",
    variant: "main",
    paneWidth: 620,
    width: 860,
    height: 700,
  },
];
let failure;
try {
  await page.goto("https://activity-harmony-owned.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const config of configurations) {
    await page.setViewportSize({ width: config.width, height: config.height });
    await mount(config);
    await measure(config.label + "/running");
    await screenshot(config.label + "-running");
    await page.evaluate(() => window.completeFixture());
    await frames();
    await measure(config.label + "/completed");
    assert.equal(await page.locator(".cs-process-heading").getAttribute("aria-expanded"), "true");
    await screenshot(config.label + "-completed");
    const process = page.locator(".cs-process-heading");
    await process.click();
    assert.equal(await process.evaluate((node) => node.matches(":focus-visible")), false);
    await process.press("Space");
    await page.keyboard.press("Tab");
    const keyboard = await page.evaluate(() => {
      const node = document.activeElement;
      const style = window.getComputedStyle(node);
      return {
        label: node.textContent,
        visible: node.matches(":focus-visible"),
        outline: style.outline,
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
        shadow: style.boxShadow,
      };
    });
    focus.push({ configuration: config.label, ...keyboard });
    assert.ok(
      keyboard.visible &&
        ((keyboard.outlineStyle !== "none" && keyboard.outlineWidth > 0) ||
          /[1-9][0-9.]*px/.test(keyboard.shadow)),
      "Keyboard focus remains visible",
    );
    await page.locator("[data-owned-pane]").screenshot({
      path: path.join(output, config.label + "-keyboard.png"),
      animations: "disabled",
    });
  }
  for (const variant of ["main", "quickChat"]) {
    await page.setViewportSize({ width: 480, height: 360 });
    await mount({ lang: "zh", theme: "light", variant, paneWidth: 360, history: true });
    await trace(variant + "/tool-expand", "[data-tool-heading]", (header) => header.click());
    await trace(variant + "/complete", ".cs-process-heading", () =>
      page.evaluate(() => window.completeFixture()),
    );
    await trace(variant + "/process-collapse", ".cs-process-heading", (header) => header.click());
    await trace(variant + "/process-expand", ".cs-process-heading", (header) => header.click());
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} catch (error) {
  failure = error.stack;
  await page.screenshot({ path: path.join(output, "failure.png"), animations: "disabled" });
} finally {
  await browser.close();
}
const report = {
  result: failure ? "fail" : "pass",
  phase,
  desktop,
  measurements,
  focus,
  traces,
  errors,
  blocked,
  failure,
  output,
};
await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      result: report.result,
      measurements: measurements.length,
      traces: traces.map(({ samples, ...rest }) => ({ ...rest, frameCount: samples.length })),
      focus,
      errors,
      blocked,
      failure,
      output,
    },
    null,
    2,
  ),
);
if (failure) process.exitCode = 1;
