/** Production search/palette: owned bridge, real CSS, native wheel and keyboard.
 * node SearchDialog.browser.fixture.mjs [--source-desktop /path/packages/desktop] [--electron]
 */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-desktop");
const sourceDesktop = sourceIndex < 0 ? desktop : path.resolve(process.argv[sourceIndex + 1]);
const renderer = path.join(sourceDesktop, "src/renderer");
const nativeElectron = process.argv.includes("--electron");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium, _electron } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const output =
  process.env.CODESHELL_SEARCH_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-search-layout-")));
await mkdir(output, { recursive: true });
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {SessionSearchModal} from './shell/SessionSearchModal';import {CommandPalette} from './shell/CommandPalette';
import {I18nProvider} from './i18n/I18nProvider';import {saveUILanguage} from './uiLanguage';
import {saveTheme,applyTheme} from './theme';
const root=createRoot(document.getElementById('root'));let generation=0;
const sessions=Array.from({length:30},(_,i)=>({id:'session-'+i,title:'Owned conversation '+i,createdAt:1000-i,updatedAt:1000-i}));
window.codeshell={searchSessionContent:async term=>{window.calls.requests.push(term);if(window.resultMode==='error')throw new Error('Owned index failure');return {matches:[],truncated:false,scannedSessions:30}}};
function Fixture({surface}){const [open,setOpen]=React.useState(false);const close=()=>setOpen(false);
return <><button id='opener' onClick={()=>setOpen(true)}>Open owned surface</button><button id='outside'>Outside</button>
{surface==='search'?<SessionSearchModal open={open} onClose={close} projects={[]} sessions={{__no_repo__:{sessions,activeSessionId:null}}} activeProjectId={null} onPick={(...wire)=>window.calls.picks.push(wire)}/>
:<CommandPalette open={open} onClose={close} commands={Array.from({length:30},(_,i)=>({id:'command-'+i,label:'Owned command '+i,hint:'Ctrl+'+i,run:()=>window.calls.commands.push(i)}))}/>}</>}
window.mountFixture=({language,theme,surface})=>{localStorage.clear();saveUILanguage(language);saveTheme(theme);applyTheme(theme);window.resultMode='empty';window.calls={picks:[],commands:[],requests:[]};root.render(<React.StrictMode><I18nProvider key={++generation}><Fixture surface={surface}/></I18nProvider></React.StrictMode>);};
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
let browser;
let context;
let page;
const reports = [],
  errors = [],
  blocked = [];
if (nativeElectron) {
  const main = path.join(output, "owned-electron.cjs");
  await writeFile(
    main,
    `const{app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(output, "user-data"))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:800,height:600,useContentSize:true,
frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.loadURL('about:blank');});`,
  );
  browser = await _electron.launch({ executablePath: require("electron"), args: [main] });
  context = browser.context();
  page = await browser.firstWindow();
} else {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin" &&
      existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
}
const routeOwned = (route) => {
  if (route.request().url() === "http://search-owned.test/")
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>',
    });
  blocked.push(route.request().url());
  return route.abort();
};
if (nativeElectron) await context.route("**/*", routeOwned);
const setViewport = async ({ width, height }) => {
  if (nativeElectron) {
    await browser.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
      { width, height },
    );
  } else await page.setViewportSize({ width, height });
  await page.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    { width, height },
  );
};
async function createPage({ width, height }) {
  if (nativeElectron) await setViewport({ width, height });
  else {
    if (context) await context.close();
    // Local headless Chrome 155 failed native wheel after an emulated viewport
    // transition, while fresh, headed and Electron windows scrolled. Layouts
    // start at their measured size; native resize still checks wheel separately.
    context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await context.route("**/*", routeOwned);
    page = await context.newPage();
  }
  page.setDefaultTimeout(5000);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://search-owned.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  assert.deepEqual(
    await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    { width, height },
  );
}
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const dialog = () => page.getByRole("dialog");
const input = () => dialog().getByRole("combobox");
const list = () => dialog().getByRole("listbox");
async function open() {
  await page.locator("#opener").click();
  await dialog().waitFor();
  await frames();
  assert.equal(await input().evaluate((node) => node === document.activeElement), true);
}
async function bounds(locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      box: box.toJSON(),
      hit: Boolean(target && node.contains(target)),
      client: node.clientHeight,
      scroll: node.scrollHeight,
    };
  });
}
async function inspect(label, config) {
  const d = await bounds(dialog()),
    l = await bounds(list()),
    i = await bounds(input());
  assert.ok(
    d.box.x >= 0 &&
      d.box.y >= 0 &&
      d.box.right <= config.width + 1 &&
      d.box.bottom <= config.height + 1,
    JSON.stringify(d),
  );
  assert.ok(
    l.client >= 72,
    `Results need at least one complete row: ${JSON.stringify({ label, config, l })}`,
  );
  assert.equal(i.hit, true);
  assert.deepEqual(
    await dialog().evaluate((node) => [node.scrollLeft, node.scrollTop]),
    [0, 0],
    "Only the results list scrolls",
  );
  assert.equal(
    await dialog().evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
    "No clipped horizontal content",
  );
  assert.ok(l.box.top >= d.box.top - 1 && l.box.bottom <= d.box.bottom + 1, JSON.stringify(l));
  assert.deepEqual(
    await dialog().evaluate((root) => {
      const nodes = [root, ...root.querySelectorAll("*")];
      for (let parent = root.parentElement; parent; parent = parent.parentElement)
        nodes.push(parent);
      return nodes.flatMap((node) => {
        if (!(node instanceof window.HTMLElement)) return [];
        const style = window.getComputedStyle(node);
        return (/(hidden|clip)/.test(style.overflowY) && node.scrollTop !== 0) ||
          (/(hidden|clip)/.test(style.overflowX) && node.scrollLeft !== 0)
          ? [{ tag: node.tagName, top: node.scrollTop, left: node.scrollLeft }]
          : [];
      });
    }),
    [],
    "Hidden ancestors must never be scrolled to expose content",
  );
  reports.push({ label, ...config, dialog: d, list: l });
}
async function dismiss() {
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "opener");
}
async function selectedVisible() {
  await page.waitForFunction(() => {
    const node = document.querySelector('[role="option"][aria-selected="true"]');
    if (!node) return false;
    const b = node.getBoundingClientRect(),
      list = node.closest('[role="listbox"]').getBoundingClientRect();
    return b.top >= list.top - 1 && b.bottom <= list.bottom + 1;
  });
}
try {
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const [width, height] of [
        [320, 240],
        [390, 360],
        [800, 480],
        [1280, 760],
      ])
        for (const surface of ["search", "palette"]) {
          const config = { language, theme, width, height, surface };
          await createPage({ width, height });
          await page.evaluate((config) => window.mountFixture(config), config);
          await open();
          await inspect("results", config);
          await input().fill(surface === "search" ? "Owned conversation" : "Owned command");
          await frames();
          const resultsBox = await list().boundingBox();
          await page.mouse.move(
            resultsBox.x + resultsBox.width / 2,
            resultsBox.y + resultsBox.height / 2,
          );
          await page.mouse.wheel(0, 160);
          await page.waitForFunction(
            () => document.querySelector('[role="listbox"]').scrollTop > 0,
          );
          await input().press("End");
          await selectedVisible();
          await input().dispatchEvent("keydown", {
            key: "Enter",
            code: "Enter",
            isComposing: true,
            bubbles: true,
          });
          assert.equal(await dialog().isVisible(), true, "IME confirmation cannot execute");
          await input().press("Enter");
          await dialog().waitFor({ state: "hidden" });
          assert.deepEqual(
            await page.evaluate(
              (surface) => (surface === "search" ? window.calls.picks : window.calls.commands),
              surface,
            ),
            surface === "search" ? [[null, "session-29"]] : [29],
          );
          await open();
          await input().fill("No owned match");
          await dialog().getByRole("status").waitFor();
          await inspect("empty", config);
          if (surface === "search") {
            await page.evaluate(() => (window.resultMode = "error"));
            await dialog()
              .getByRole("button", {
                name: language === "zh" ? "对话内容" : "Conversation content",
                exact: true,
              })
              .click();
            await input().fill("owned-query");
            const retry = dialog().getByRole("button", {
              name: language === "zh" ? "重试" : "Retry",
              exact: true,
            });
            await retry.waitFor();
            await frames();
            await inspect("error", config);
            const b = await list().boundingBox();
            await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
            await page.mouse.wheel(0, 800);
            await page.waitForFunction(() => {
              const node = document.querySelector('[role="status"] button');
              const b = node.getBoundingClientRect(),
                l = node.closest('[role="listbox"]').getBoundingClientRect();
              return b.top >= l.top - 1 && b.bottom <= l.bottom + 1;
            });
            assert.equal(
              (await bounds(retry)).hit,
              true,
              "Mouse wheel exposes Retry without moving focus",
            );
            await page.evaluate(() => (window.resultMode = "empty"));
            await retry.click();
            await retry.waitFor({ state: "hidden" });
            await dialog()
              .getByText(language === "zh" ? "未找到匹配内容" : "No matching content found", {
                exact: true,
              })
              .waitFor();
            await inspect("recovered", config);
            assert.equal(await page.evaluate(() => window.calls.requests.length), 2);
          }
          await page.screenshot({
            path: path.join(output, `${surface}-${language}-${theme}-${width}x${height}.png`),
          });
          await dismiss();
        }
  // Preserve a live query and focus through the actual short-window media breakpoint.
  await createPage({ width: 800, height: 600 });
  await page.evaluate(() =>
    window.mountFixture({ language: "en", theme: "light", surface: "search" }),
  );
  await open();
  await input().fill("Owned conversation");
  for (const [width, height] of [
    [320, 240],
    [390, 360],
    [800, 600],
  ]) {
    await setViewport({ width, height });
    await frames();
    assert.equal(await input().inputValue(), "Owned conversation");
    assert.equal(await input().evaluate((node) => node === document.activeElement), true);
    await inspect("resize", { width, height, surface: "search", language: "en", theme: "light" });
    if (nativeElectron) {
      await input().press("Home");
      await selectedVisible();
      const box = await list().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 160);
      await page.waitForFunction(() => document.querySelector('[role="listbox"]').scrollTop > 0);
      assert.equal(await input().evaluate((node) => node === document.activeElement), true);
    }
    await input().press("End");
    await selectedVisible();
    await inspect("resize-selected", {
      width,
      height,
      surface: "search",
      language: "en",
      theme: "light",
    });
  }
  await dismiss();
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify({ result: "pass", layouts: 32, observations: reports.length, output }),
  );
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { sourceDesktop, runtime: nativeElectron ? "electron" : "chrome", reports, errors, blocked },
      null,
      2,
    ),
  );
  await browser.close();
}
