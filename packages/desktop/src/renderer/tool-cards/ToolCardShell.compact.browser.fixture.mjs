/** Focused real tool records, production Tailwind and MessageStream scroll hook.
 * node scripts/run-isolated-node-smoke.mjs <fixture> [--phase before|after]
 *   [--source-desktop /absolute/path/to/packages/desktop] [--output /absolute/path]
 * Only data, clipboard and host callbacks are mocked. No engine or network.
 */
/* global window, document, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
assert.ok(process.env.CODE_SHELL_TEST_HOME, "Use scripts/run-isolated-node-smoke.mjs");
const phase = option("--phase") || "after";
assert.ok(["before", "after"].includes(phase));
const ownDesktop = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = option("--source-desktop") || ownDesktop;
const renderer = path.join(desktop, "src/renderer");
const output = option("--output") || "/tmp/codeshell-compact-tool-records-qa/" + phase;
await mkdir(output, { recursive: true });
const require = createRequire(path.join(ownDesktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const command = "printf 'first line\\nsecond 😀\\n'\n# preserve trailing spaces  ";
const stdout = "first line\nsecond 😀\nSTDERR:\nwarning with trailing spaces  \nExit code: 1\n";
const mcpName = "mcp__workspace_assets__" + "selected_design_preview_".repeat(7);
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ToolCard} from './tool-cards';import {ToolCardShell} from './tool-cards/ToolCardShell';
import {SandboxBadge} from './tool-cards/SandboxBadge';import {ToolGroupCard} from './messages/ToolGroupCard';
import {MessageStream} from './MessageStream';import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';import {applyTheme,saveTheme} from './theme';
const command=${JSON.stringify(command)},stdout=${JSON.stringify(stdout)},mcpName=${JSON.stringify(mcpName)};
const sandbox={backend:'seatbelt',network:'deny'};
const records=[
 {kind:'tool',id:'bash-a',toolName:'Bash',args:JSON.stringify({command,cwd:'/owned/project'}),status:'succeeded',durationMs:1200,summary:'Checked local configuration and preserved the exact output.',result:stdout,sandbox},
 {kind:'tool',id:'bash-b',toolName:'Bash',args:JSON.stringify({command:'bun run build:renderer'}),status:'succeeded',durationMs:3200,summary:'Renderer build completed successfully.',result:'Build completed.\\n',sandbox:{backend:'off'}},
 {kind:'tool',id:'read-a',toolName:'Read',args:JSON.stringify({file_path:'/owned/project/packages/desktop/package.json'}),status:'succeeded',durationMs:400,summary:'Read the project package configuration.',result:'{"name":"owned-fixture","private":true}\\n'},
];
function LazyDetails(){React.useEffect(()=>{window.calls.mounts++;return()=>window.calls.unmounts++},[]);return <p data-lazy-details>Lazy owned details</p>}
function StreamFixture({variant}){
 const [extra,setExtra]=React.useState('');window.appendStream=()=>setExtra(value=>value+'\\n\\n'+('Later streaming output. ').repeat(30));
 return <div data-chat-variant={variant} className="fixed inset-0 flex min-h-0 min-w-0 flex-col bg-background text-foreground"><MessageStream messages={[
 {kind:'user',id:'old-user',text:'Review the previous result.'},
 {kind:'assistant',id:'old-answer',done:true,text:Array.from({length:18},(_,i)=>'Previous paragraph '+i+': the reader keeps the same position while inspecting a tool record.').join('\\n\\n')},
 {kind:'user',id:'current-user',text:'Inspect the command output.'},
 records[0],
 {kind:'assistant',id:'current-answer',done:false,text:'The result remains below the selected tool record.'+extra}
 ]} liveTurnActive turnEpoch={0} engineSessionId="compact-owned" readOnly/></div>
}
const root=createRoot(document.getElementById('root'));let generation=0;
window.renderFixture=({lang='zh',theme='light',variant='main',surface='records'}={})=>{
 saveUILanguage(lang);saveTheme(theme);applyTheme(theme);window.calls={copies:[],actions:0,selections:0,mounts:0,unmounts:0};
 window.codeshell={log:()=>{}};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.calls.copies.push(text)}});
 const id=++generation;
 root.render(<I18nProvider key={id}><main data-generation={id} data-chat-variant={surface==='stream'?undefined:variant} className="min-w-0 bg-background p-3 text-foreground">
 {surface==='stream'?<StreamFixture variant={variant}/>:<div className="cs-chat-transcript flex min-w-0 flex-col gap-5">
 <section aria-label="User example" data-record-list className="flex min-w-0 flex-col gap-1">{records.map(record=><div key={record.id} data-owned-row={record.id}><ToolCard message={record}/></div>)}</section>
 <section aria-label="Tool group" data-owned-group><ToolGroupCard group={{kind:'tool_group',id:'owned-group',items:records}}/></section>
 <section aria-label="Long tool metadata" data-owned-long><ToolCardShell message={{...records[0],id:'long-tool',toolName:mcpName,status:'failed',summary:'Long tool result summary'}} summary={'/owned/'+ 'long_path_segment_'.repeat(18)} details={<LazyDetails/>}
 headerBadge={<span data-owned-badge><SandboxBadge sandbox={sandbox}/></span>}
 headerAction={<button data-owned-action type="button" aria-label="Owned action" className="size-6" onClick={e=>{e.stopPropagation();window.calls.actions++}}>↗</button>} onSelect={()=>window.calls.selections++}/></section>
 <section aria-label="Summary only" data-owned-summary><ToolCardShell message={{...records[2],id:'summary-only',summary:'Summary-only result remains reachable.'}} selected summary="Owned summary-only record"/></section>
 <section aria-label="States and preview" className="flex min-w-0 flex-col gap-1">{['running','failed','denied'].map(status=><div key={status} data-owned-status={status}><ToolCardShell message={{...records[0],id:'state-'+status,status}} summary={status+' owned command'} details={<p>Owned {status} details</p>}/></div>)}
 <div data-owned-preview><ToolCardShell message={{...records[2],id:'preview'}} summary="Owned preview" preview={<p>Important visible result preview.</p>} details={<p>Owned preview details</p>}/></div></section>
 </div>}</main></I18nProvider>);return id;
};
window.streamScroll=()=>document.querySelector('.cs-chat-transcript').parentElement;
window.streamHeader=()=>document.querySelector('[data-message-kind="tool"] button[aria-expanded]');
window.beginTrace=()=>{const frames=[];const begin=performance.now();window.traceDone=new Promise(resolve=>{const tick=()=>{const s=window.streamScroll(),h=window.streamHeader();frames.push({elapsed:performance.now()-begin,top:s.scrollTop,header:h.getBoundingClientRect().top,expanded:h.getAttribute('aria-expanded')});if(performance.now()-begin<700)requestAnimationFrame(tick);else resolve(frames)};tick()})};
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
  viewport: { width: 640, height: 800 },
});
const blocked = [],
  errors = [],
  measurements = [],
  cases = [],
  traces = [];
await context.route("**/*", (route) =>
  route.request().url() === "https://compact-tool-owned.test/"
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
  const generation = await page.evaluate((props) => window.renderFixture(props), config);
  await page.locator(`[data-generation="${generation}"]`).waitFor();
  await frames();
}
const toggle = (root) => root.locator("button[aria-expanded]").first();
async function measure(label) {
  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-owned-row]")].map((row) => {
      const header = row.querySelector("button[aria-expanded]");
      return {
        id: row.getAttribute("data-owned-row"),
        row: row.getBoundingClientRect().toJSON(),
        header: header.getBoundingClientRect().toJSON(),
      };
    });
    const list = document.querySelector("[data-record-list]");
    const long = document.querySelector("[data-owned-long]");
    const group = document.querySelector("[data-owned-group]");
    return {
      width: window.innerWidth,
      document: document.documentElement.scrollWidth,
      rows,
      total: list.getBoundingClientRect().height,
      gap: window.getComputedStyle(list).gap,
      group: group.getBoundingClientRect().height,
      long: { width: long.clientWidth, scroll: long.scrollWidth },
    };
  });
  measurements.push({ label, ...result });
  if (phase === "after") {
    assert.ok(result.document <= result.width + 1, label + ": document overflow");
    assert.ok(result.long.scroll <= result.long.width + 1, label + ": long MCP name overflow");
    for (const row of result.rows)
      assert.ok(row.row.height >= 32 && row.row.height <= 36, JSON.stringify(row));
    assert.ok(result.group >= 30 && result.group <= 34, label + ": group height " + result.group);
    assert.equal(result.gap, "4px");
  }
  return result;
}
async function hitTest(locator) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const card = node.closest("section").getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      box: box.toJSON(),
      card: card.toJSON(),
      hit: !!hit && (node.contains(hit) || hit.contains(node)),
    };
  });
  assert.ok(
    result.hit &&
      result.box.width > 0 &&
      result.box.left >= result.card.left - 1 &&
      result.box.right <= result.card.right + 1,
    JSON.stringify(result),
  );
}
let failure;
try {
  await page.goto("https://compact-tool-owned.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const configurations =
    phase === "before"
      ? [
          {
            label: "main-zh-light-desktop",
            width: 640,
            lang: "zh",
            theme: "light",
            variant: "main",
          },
          {
            label: "main-zh-light-narrow",
            width: 320,
            lang: "zh",
            theme: "light",
            variant: "main",
          },
        ]
      : [
          {
            label: "main-zh-light-desktop",
            width: 640,
            lang: "zh",
            theme: "light",
            variant: "main",
          },
          { label: "main-en-dark-narrow", width: 320, lang: "en", theme: "dark", variant: "main" },
          {
            label: "quick-zh-light-narrow",
            width: 320,
            lang: "zh",
            theme: "light",
            variant: "quickChat",
          },
          {
            label: "quick-en-dark-desktop",
            width: 640,
            lang: "en",
            theme: "dark",
            variant: "quickChat",
          },
        ];
  for (const config of configurations) {
    await page.setViewportSize({ width: config.width, height: 800 });
    await mount(config);
    await measure(config.label);
    await page.locator("[data-record-list]").screenshot({
      path: path.join(output, config.label + "-three-records.png"),
      animations: "disabled",
    });
    if (phase === "before") continue;
    const first = page.locator('[data-owned-row="bash-a"]');
    assert.equal(
      await first.locator("[data-tool-output]").count(),
      0,
      "Collapsed details stay lazy",
    );
    assert.equal(
      await first.getByText("Checked local configuration and preserved the exact output.").count(),
      0,
    );
    await toggle(first).focus();
    await toggle(first).press("Enter");
    assert.equal(await toggle(first).getAttribute("aria-expanded"), "true");
    assert.equal(
      await first.getByText("Checked local configuration and preserved the exact output.").count(),
      1,
    );
    for (const [name, text] of [
      ["command", command],
      ["stdout", stdout],
    ]) {
      const block = first.locator(`[data-tool-output="${name}"]`);
      assert.equal(await block.locator("pre").textContent(), text);
      await block.locator("button").first().click();
      assert.equal(await page.evaluate(() => window.calls.copies.at(-1)), text);
    }
    await toggle(first).press("Space");
    assert.equal(await first.locator("[data-tool-output]").count(), 0);
    const only = page.locator("[data-owned-summary]");
    assert.equal(await only.getByText("Summary-only result remains reachable.").count(), 0);
    await toggle(only).click();
    assert.equal(await only.getByText("Summary-only result remains reachable.").count(), 1);
    assert.equal(await toggle(only).getAttribute("aria-expanded"), "true");
    const controlledId = await toggle(only).getAttribute("aria-controls");
    assert.ok(controlledId && (await page.locator(`[id="${controlledId}"]`).count()) === 1);
    const long = page.locator("[data-owned-long]");
    await hitTest(long.locator("[data-owned-badge]"));
    await hitTest(long.locator("[data-owned-action]"));
    await hitTest(long.getByText("1.2s", { exact: true }));
    await hitTest(long.getByText("error", { exact: true }));
    const selectedBackground = await only
      .locator("[data-tool-card]")
      .evaluate((node) => window.getComputedStyle(node).backgroundColor);
    const plainBackground = await first
      .locator("[data-tool-card]")
      .evaluate((node) => window.getComputedStyle(node).backgroundColor);
    assert.notEqual(
      selectedBackground,
      plainBackground,
      "Selected tool preserves its accent background",
    );
    await long.locator("[data-owned-action]").click();
    assert.equal(await page.evaluate(() => window.calls.actions), 1);
    assert.equal(await toggle(long).getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => window.calls.mounts), 0);
    await toggle(long).click();
    await page.locator("[data-lazy-details]").waitFor();
    assert.equal(await page.evaluate(() => window.calls.mounts), 1);
    await toggle(long).click();
    assert.equal(await page.locator("[data-lazy-details]").count(), 0);
    const group = page.locator("[data-owned-group]");
    assert.equal(await group.locator('[data-message-kind="tool"]').count(), 0);
    await toggle(group).click();
    assert.equal(await group.locator('[data-message-kind="tool"]').count(), 3);
    await toggle(group).click();
    for (const status of ["running", "failed", "denied"])
      assert.ok(await page.locator(`[data-owned-status="${status}"] .status-dot`).isVisible());
    assert.equal(
      await page
        .locator("[data-owned-preview]")
        .getByText("Important visible result preview.")
        .count(),
      1,
    );
    await page.locator('[data-owned-status="running"]').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(output, config.label + "-states.png"),
      animations: "disabled",
    });
    cases.push(
      config.label + ": compact/lazy/summary-only/copy/group/metadata/actions/status/preview",
    );
  }
  if (phase === "after") {
    for (const variant of ["main", "quickChat"]) {
      await page.setViewportSize({ width: variant === "main" ? 640 : 320, height: 420 });
      await mount({ surface: "stream", variant, lang: "zh", theme: "light" });
      const process = page.locator(".cs-process-heading");
      if ((await process.count()) && (await process.getAttribute("aria-expanded")) === "false")
        await process.click();
      const header = page.locator('[data-message-kind="tool"] button[aria-expanded]').first();
      await header.waitFor();
      await header.scrollIntoViewIfNeeded();
      await frames();
      await page.evaluate(() => window.beginTrace());
      await header.click();
      const framesResult = await page.evaluate(() => window.traceDone);
      const range = (key) =>
        Math.max(...framesResult.map((f) => f[key])) - Math.min(...framesResult.map((f) => f[key]));
      const result = {
        variant,
        headerRange: range("header"),
        scrollRange: range("top"),
        frames: framesResult,
      };
      traces.push(result);
      assert.ok(
        result.headerRange <= 2,
        variant + ": every-frame tool header anchor " + result.headerRange,
      );
      assert.equal(await header.getAttribute("aria-expanded"), "true");
      await page.evaluate(() => window.appendStream());
      await page.waitForTimeout(200);
      assert.equal(await header.getAttribute("aria-expanded"), "true");
      await page.screenshot({
        path: path.join(output, variant + "-real-stream-expanded.png"),
        animations: "disabled",
      });
      cases.push(variant + ": real MessageStream disclosure anchor remains stable");
    }
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
  cases,
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
      ...report,
      traces: traces.map(({ frames, ...rest }) => ({ ...rest, frameCount: frames.length })),
    },
    null,
    2,
  ),
);
if (failure) process.exitCode = 1;
