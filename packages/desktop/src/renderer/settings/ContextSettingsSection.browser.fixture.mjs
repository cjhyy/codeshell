/* Production SettingsPage, ContextSettingsSection, toasts and CSS; every Host method is fixture-owned. */
/* global window, document, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");

const renderer = path.join(desktop, "src/renderer");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  "/tmp/codeshell-context-settings-qa";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsPage} from './settings/SettingsPage';
import {I18nProvider} from './i18n/I18nProvider';
import {DialogProvider} from './ui/DialogProvider';
import {ToastProvider} from './ui/ToastProvider';
import {saveUILanguage} from './uiLanguage';
import {saveTheme,applyTheme} from './theme';
import {Slider} from './components/ui/slider';
const initial={context:{microcompactFloorRatio:0.67,compactAtRatio:0.83,summarizeAtRatio:0.94}};
let settings,readMode,reads=[],writes=[],logs=[],pendingWrite;
window.fixture={get reads(){return reads.map(({id})=>id)},get writes(){return writes},get logs(){return logs},
  setReadMode(mode){readMode=mode},
  rejectRead(id){reads.find(read=>read.id===id).reject(new Error('Fixture read denied'))},
  resolveRead(id,context){const read=reads.find(read=>read.id===id);read.resolve({context})},
  finishWrite(success){const op=pendingWrite;pendingWrite=undefined;if(!op)throw new Error('No pending write');
    if(success){for(const [key,value] of Object.entries(op.patch.context)){if(value===null)delete settings.context[key];else settings.context[key]=value}op.resolve()}
    else op.reject(new Error('Fixture write denied'));}};
window.codeshell={
  getSettings:()=>{const id=reads.length;return new Promise((resolve,reject)=>{reads.push({id,resolve,reject});
    if(readMode==='reject')reject(new Error('Fixture read denied'));else if(readMode==='ready')resolve(structuredClone(settings));})},
  updateSettings:(scope,patch)=>{if(scope!=='user'||!patch.context)throw new Error('Unexpected settings write');
    writes.push(structuredClone({scope,patch}));return new Promise((resolve,reject)=>{if(pendingWrite)throw new Error('Duplicate write');pendingWrite={resolve,reject,patch}})},
  log:(event,value)=>logs.push({event,value}),
};
const root=createRoot(document.getElementById('root'));let generation=0;
function SliderContract(){const [value,setValue]=React.useState([45]);return <div className='p-4'><span id='fixture-slider-label'>Linked percentage</span><span id='fixture-slider-description'>Fixture linked description</span><Slider id='fixture-slider-root' aria-label='Fallback percentage' aria-labelledby='fixture-slider-label' aria-describedby='fixture-slider-description' aria-invalid value={value} onValueChange={setValue}/></div>}
window.renderSliderContract=()=>root.render(<SliderContract/>);
window.renderFixture=async({lang='zh',mode='light',read='ready'}={})=>{
localStorage.clear();saveUILanguage(lang);saveTheme(mode);applyTheme(mode);
settings=structuredClone(initial);reads=[];writes=[];logs=[];pendingWrite=undefined;readMode=read;const current=++generation;
root.render(<React.StrictMode><I18nProvider key={current}><DialogProvider><ToastProvider><div data-fixture-generation={current} className='h-full'>
<SettingsPage activeProjectPath={null} initialProjectPath={null} initialModule='context' projects={[]} sessionIndices={{}} onRestoreArchivedSession={()=>{}} onDeleteArchivedSession={()=>{}} isMac={false} isFullscreen={false} onBack={()=>{}}/>
</div></ToastProvider></DialogProvider></I18nProvider></React.StrictMode>);return current;};
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "empty", ".wav": "empty", ".css": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
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
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const errors = [],
  blocked = [],
  reports = [];
async function mount({
  width = 1000,
  height = 620,
  lang = "zh",
  mode = "light",
  read = "ready",
} = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: mode,
    serviceWorkers: "block",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://settings-fixture.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://settings-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const generation = await page.evaluate((options) => window.renderFixture(options), {
    lang,
    mode,
    read,
  });
  await page.locator('[data-fixture-generation="' + generation + '"]').waitFor();
  await page
    .getByRole("heading", { level: 1, name: lang === "zh" ? "上下文" : "Context", exact: true })
    .waitFor();
  if (read === "ready") await page.getByRole("spinbutton").first().waitFor();
  return page;
}
const values = (page) =>
  page.getByRole("spinbutton").evaluateAll((elements) => elements.map((el) => el.value));
const save = (page) => page.getByRole("button", { name: "保存上下文设置", exact: true });
const reset = (page) => page.getByRole("button", { name: "恢复默认", exact: true });
const fields = (page) => page.getByRole("spinbutton");
async function settleToast(page) {
  await page
    .locator(".pointer-events-auto")
    .last()
    .evaluate(async (el) => {
      await Promise.all(
        el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
      );
    });
}
async function enter(page, index, value) {
  await fields(page).nth(index).fill(value);
}
async function navigate(page, name) {
  const search = page.getByRole("searchbox").filter({ visible: true });
  await search.fill(name);
  await page
    .getByRole("navigation")
    .filter({ visible: true })
    .getByRole("button", { name, exact: true })
    .click();
  await page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
}
async function finish(page, success) {
  await page.evaluate((value) => window.fixture.finishWrite(value), success);
  await page.waitForFunction(() => !document.querySelector('input[type="number"]')?.disabled);
  await page
    .getByText(success ? "上下文设置已保存" : "保存失败: Fixture write denied", { exact: true })
    .last()
    .waitFor();
  await settleToast(page);
}
try {
  const failed = await mount({ width: 390, height: 360, read: "reject" });
  await failed.getByRole("alert").filter({ hasText: "Fixture read denied" }).waitFor();
  assert.equal(await fields(failed).count(), 0);
  assert.equal(await save(failed).count(), 0);
  assert.deepEqual(await failed.evaluate(() => window.fixture.writes), []);
  await failed.getByRole("alert").locator("..").scrollIntoViewIfNeeded();
  await failed.screenshot({ path: path.join(output, "load-failed-390x360.png") });
  await failed.evaluate(() => window.fixture.setReadMode("hold"));
  let retry = failed.getByRole("button", { name: "重新读取", exact: true });
  await retry.focus();
  await failed.keyboard.press("Enter");
  await failed.getByRole("status").filter({ hasText: "正在读取上下文设置" }).waitFor();
  await failed.evaluate(() => window.fixture.rejectRead(2));
  await failed.getByRole("alert").filter({ hasText: "Fixture read denied" }).waitFor();
  retry = failed.getByRole("button", { name: "重新读取", exact: true });
  await failed.waitForFunction(() => document.activeElement?.textContent === "重新读取");
  await failed.evaluate(() => window.fixture.setReadMode("ready"));
  await retry.focus();
  await failed.keyboard.press("Enter");
  await fields(failed).first().waitFor();
  assert.deepEqual(await values(failed), ["67", "83", "94"]);
  await failed.waitForFunction(
    () => document.activeElement === document.querySelector('input[type="number"]'),
  );
  await failed.close();

  const outside = await mount({ read: "reject" });
  await outside.getByRole("alert").filter({ hasText: "Fixture read denied" }).waitFor();
  await outside.evaluate(() => window.fixture.setReadMode("hold"));
  await outside.getByRole("button", { name: "重新读取", exact: true }).click();
  await outside.getByRole("status").filter({ hasText: "正在读取上下文设置" }).waitFor();
  const search = outside.getByRole("searchbox").filter({ visible: true });
  await search.focus();
  await outside.evaluate(() =>
    window.fixture.resolveRead(2, {
      microcompactFloorRatio: 0.67,
      compactAtRatio: 0.83,
      summarizeAtRatio: 0.94,
    }),
  );
  await fields(outside).first().waitFor();
  assert.equal(await search.evaluate((el) => el === document.activeElement), true);
  await outside.close();

  const page = await mount();
  for (const name of ["Microcompact 下限", "开始压缩", "紧急压缩"]) {
    assert.equal(await page.getByRole("spinbutton", { name, exact: true }).count(), 1);
    assert.equal(await page.getByRole("slider", { name, exact: true }).count(), 1);
  }
  await page.getByRole("slider", { name: "Microcompact 下限", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await fields(page).first().inputValue(), "68");
  await enter(page, 0, "");
  assert.equal(await fields(page).first().inputValue(), "");
  await fields(page).first().pressSequentially("80");
  assert.equal(await fields(page).first().inputValue(), "80");
  await enter(page, 0, "");
  await fields(page).first().press("Enter");
  await page.getByRole("alert").filter({ hasText: "10 到 95" }).waitFor();
  assert.equal(await fields(page).first().getAttribute("aria-invalid"), "true");
  assert.equal(
    await fields(page)
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.writes), []);
  await enter(page, 0, "96");
  await save(page).click();
  assert.equal(await fields(page).first().getAttribute("aria-invalid"), "true");
  await enter(page, 0, "70.5");
  await save(page).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.writes), []);
  await enter(page, 0, "95");
  await enter(page, 1, "75");
  await enter(page, 2, "50");
  await save(page).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.fixture.writes.length === 1);
  await page.locator("form").evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  assert.equal(await page.evaluate(() => window.fixture.writes.length), 1);
  assert.deepEqual(await values(page), ["95", "75", "50"]);
  assert.equal(await fields(page).first().isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.fixture.writes[0]), {
    scope: "user",
    patch: {
      context: { microcompactFloorRatio: 0.75, compactAtRatio: 0.75, summarizeAtRatio: 0.75 },
    },
  });
  await finish(page, false);
  assert.deepEqual(await values(page), ["95", "75", "50"]);
  assert.equal(await save(page).evaluate((el) => el === document.activeElement), true);
  await save(page).click();
  await finish(page, true);
  assert.deepEqual(await values(page), ["75", "75", "75"]);
  await enter(page, 0, "80");
  await enter(page, 1, "88");
  await enter(page, 2, "96");
  await reset(page).focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await values(page), ["80", "88", "96"]);
  await finish(page, false);
  assert.deepEqual(await values(page), ["80", "88", "96"]);
  assert.equal(await reset(page).evaluate((el) => el === document.activeElement), true);
  await page.screenshot({ path: path.join(output, "reset-rejected-draft-and-focus.png") });
  await reset(page).click();
  await finish(page, true);
  assert.deepEqual(await values(page), ["70", "85", "92"]);
  assert.deepEqual(await page.evaluate(() => window.fixture.writes.at(-1).patch.context), {
    microcompactFloorRatio: null,
    compactAtRatio: null,
    summarizeAtRatio: null,
  });
  // The component can unmount while a Host write finishes; feedback belongs to its mounted owner.
  const previousLogs = await page.evaluate(() => window.fixture.logs.length);
  await save(page).click();
  await navigate(page, "键盘快捷键");
  await page.evaluate(() => window.fixture.finishWrite(false));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.evaluate(() => window.fixture.logs.length), previousLogs);
  await page.close();

  // Two StrictMode reads from an old module, and the first read from the new mount, finish late.
  const delayed = await mount({ read: "hold" });
  await delayed.getByRole("status").filter({ hasText: "正在读取上下文设置" }).waitFor();
  assert.equal(await fields(delayed).count(), 0);
  await navigate(delayed, "键盘快捷键");
  await navigate(delayed, "上下文");
  await delayed.waitForFunction(() => window.fixture.reads.length === 4);
  await delayed.evaluate(() =>
    window.fixture.resolveRead(3, {
      microcompactFloorRatio: 0.67,
      compactAtRatio: 0.83,
      summarizeAtRatio: 0.94,
    }),
  );
  await fields(delayed).first().waitFor();
  await enter(delayed, 0, "80");
  await delayed.evaluate(() => {
    for (const id of [0, 1, 2])
      window.fixture.resolveRead(id, {
        microcompactFloorRatio: 0.12,
        compactAtRatio: 0.23,
        summarizeAtRatio: 0.34,
      });
  });
  await delayed.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.deepEqual(await values(delayed), ["80", "83", "94"]);
  await delayed.close();

  for (const width of [320, 390, 760, 1000])
    for (const lang of ["zh", "en"])
      for (const mode of ["light", "dark"]) {
        const height = width < 760 ? 360 : 620;
        const visual = await mount({ width, height, lang, mode });
        const input = fields(visual).first();
        await input.fill("");
        await input.press("Tab");
        assert.equal(await input.getAttribute("aria-invalid"), "true");
        assert.ok((await input.getAttribute("aria-describedby")).includes("-error"));
        await visual.locator("form > .grid > div").first().scrollIntoViewIfNeeded();
        const metrics = await visual.locator("main").evaluate((el) => ({
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          bodyWidth: document.documentElement.scrollWidth,
          bodyHeight: document.documentElement.scrollHeight,
        }));
        assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1);
        assert.ok(metrics.bodyWidth <= width);
        assert.ok(metrics.bodyHeight <= height);
        reports.push({ width, height, lang, mode, ...metrics });
        await visual.screenshot({
          path: path.join(output, `context-${width}-${lang}-${mode}.png`),
        });
        await visual.close();
      }
  const contract = await mount();
  await contract.evaluate(() => window.renderSliderContract());
  const thumb = contract.getByRole("slider", { name: "Linked percentage", exact: true });
  await thumb.waitFor();
  assert.equal(await contract.locator("#fixture-slider-root").count(), 1);
  assert.equal(await thumb.getAttribute("aria-describedby"), "fixture-slider-description");
  assert.equal(await thumb.getAttribute("aria-invalid"), "true");
  assert.equal(await contract.locator("#fixture-slider-root").getAttribute("aria-label"), null);
  await writeFile(path.join(output, "slider-accessibility.yaml"), await thumb.ariaSnapshot());
  await thumb.focus();
  await contract.keyboard.press("ArrowRight");
  assert.equal(await thumb.getAttribute("aria-valuenow"), "46");
  await contract.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        reports,
        readFailureBlocksWrite: true,
        retry: true,
        editableDrafts: true,
        validation: true,
        normalization: true,
        failedWritesPreserveDraft: true,
        keyboardFocus: true,
        unmountedFeedbackSuppressed: true,
        lateReadsIgnored: true,
        errors,
        blocked,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS Context settings real entry: owned read/retry/write lifecycle, numeric draft/validation, normalization, keyboard focus, stale reads/unmount and 16 visual layouts. Evidence: " +
      output,
  );
} finally {
  await browser.close();
}
