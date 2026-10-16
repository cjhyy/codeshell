/* Actual new-chat ProjectPicker and App's local chooser/navigation hooks.
 * Owned bridge only. --development, --electron-zoom, --source-desktop=PATH.
 * IME and window-blur checks exercise DOM events, not OS input or screen-reader speech. */
/* global document, window, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, devicePixelRatio, KeyboardEvent, Event */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceDesktop =
  process.argv.find((arg) => arg.startsWith("--source-desktop="))?.slice(17) || desktop;
const renderer = path.join(sourceDesktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild"),
  { chromium, _electron } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node"),
  { Scanner } = tw("@tailwindcss/oxide");
const native = process.argv.includes("--electron-zoom");
const development = process.argv.includes("--development");
const baseline = process.argv.includes("--expect-baseline");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-project-picker-"));
await mkdir(output, { recursive: true });
const source = String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ChatView} from './ChatView';import {useSessionNavigation} from './app/useSessionNavigation';import {useNewProjectDialog} from './projects/NewProjectDialog';
import {initializeSessionPersistence,getSessionPersistenceIndices,flushSessionPersistence} from './sessionPersistence';
import {I18nProvider} from './i18n/I18nProvider';import {saveUILanguage} from './uiLanguage';import {applyTheme} from './theme';import {translate} from './i18n/translate';import {ToastProvider} from './ui/ToastProvider';
const noop=()=>{};window.unexpected=[];window.calls={select:[],add:[],picker:0,before:[]};window.composers=[];window.menu=new Set();window.pickerMode='cancel';
window.codeshell=new Proxy({sessionCatalog:null,sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>noop,listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']}),log:noop,onMenuEvent:fn=>{window.menu.add(fn);return()=>window.menu.delete(fn)},cloudAccount:{status:async()=>({state:'signed-out'}),onStatus:()=>noop},projectRegistry:{createFromPicker:async()=>{window.calls.picker++;if(window.pickerMode==='hold')return new Promise((resolve,reject)=>window.pendingPick={resolve,reject});if(window.pickerMode==='reject')throw Error('Owned picker rejected');return null}}},{get(target,key){if(key in target)return target[key];window.unexpected.push(String(key));throw Error('Unexpected bridge '+String(key))}});
const projects=Array.from({length:35},(_,i)=>({id:'owned-'+i,name:i===0?'Owned local project':('长项目名称Long_Project_'.repeat(18))+'_'+i,path:'/owned/projects/'+('long-path-'.repeat(12))+'/'+i,roots:[{id:'root-'+i,name:'root',path:'/owned/projects/'+i,addedAt:0}],primaryRootId:'root-'+i,addedAt:0}));window.projects=projects;
function Composer({index,variant}){const[state,patch]=React.useReducer((old,next)=>({...old,...next}),{projects,active:null,busy:false,draft:'Owned unsent draft'});const[indices,setIndices]=React.useState(getSessionPersistenceIndices);const bucket=React.useRef('none');
const nav=useSessionNavigation({projects:state.projects,setProjects:value=>patch({projects:typeof value==='function'?value(state.projects):value}),activeProjectId:state.active,setActiveProjectId:value=>patch({active:typeof value==='function'?value(state.active):value}),sessionIndices:indices,setSessionIndices:setIndices,setCollapsedProjects:noop,setUnreadBuckets:noop,setPermissionOverrides:noop,setModelOverrides:noop,setGoalOverrides:noop,panelByBucket:{},setPanelByBucket:noop,activeBucketRef:bucket,setView:noop,onOpenTrace:noop,beforeSelectLocalSession:async id=>{window.calls.before.push(id);return true}});
const[open,dialog]=useNewProjectDialog(nav.handleAddProject);React.useLayoutEffect(()=>{window.composers[index]={patch,state,indices};return()=>delete window.composers[index]},[state,indices,index]);
return <><ChatView variant={variant} messages={[]} onSend={noop} onStop={noop} busy={state.busy} activeProjectId={state.active} permissionMode='plan' onPermissionChange={noop} goalEnabled={false} onGoalToggle={noop} modelOptions={[{key:'owned-model',label:'Owned model',provider:'owned'}]} activeModelKey='owned-model' onModelChange={noop} contextTokens={0} projects={state.projects} onSelectProject={id=>{window.calls.select.push({index,id});nav.handleNewConversationForProject(id)}} onAddProject={()=>{window.calls.add.push(index);open()}} configurationTarget={{projectId:'owned-0'}} configurationAvailable conversationRoot='/owned' conversationRootId='root' draft={state.draft} onDraftChange={draft=>patch({draft})} attachments={[]} onAttachmentsChange={noop}/>{dialog}</>}
function Fixture({multiple=false,variant='main'}){return <main className='fixed inset-0 flex min-w-0 overflow-hidden bg-background'>{Array.from({length:multiple?2:1},(_,index)=><section key={index} data-composer-index={index} className='h-full min-w-0 flex-1 overflow-hidden'><Composer index={index} variant={variant}/></section>)}</main>}
const root=createRoot(document.getElementById('root'));let generation=0;window.flushSessionPersistence=flushSessionPersistence;window.renderFixture=async props=>{localStorage.clear();saveUILanguage(props.language);applyTheme(props.theme);window.calls={select:[],add:[],picker:0,before:[]};window.catalogWrites=[];window.pickerMode='cancel';let catalog={revision:1,indices:Object.fromEntries(projects.map(project=>[project.id,{sessions:[{id:'previous-'+project.id,title:'Previous conversation',createdAt:0,updatedAt:0}],activeSessionId:'previous-'+project.id}]))};window.codeshell.sessionCatalog={load:async()=>structuredClone(catalog),importLegacy:async indices=>{if(Object.keys(indices).length)throw Error('Unexpected legacy project data');return structuredClone(catalog)},apply:async patch=>{window.catalogWrites.push(structuredClone(patch));const index=catalog.indices[patch.projectKey];catalog={revision:catalog.revision+1,indices:{...catalog.indices,[patch.projectKey]:{...index,activeSessionId:patch.activeSessionId}}};return structuredClone(catalog)},onChanged:()=>noop,writeTranscript:async()=>{throw Error('Unexpected transcript write')},readTranscript:async()=>{throw Error('Unexpected transcript read')},deleteTranscript:async()=>{throw Error('Unexpected transcript delete')}};await initializeSessionPersistence();window.labels={search:translate(props.language,'chat.project.searchPlaceholder'),clear:translate(props.language,'chat.project.clearAria'),add:translate(props.language,'chat.project.addNew'),none:translate(props.language,'chat.project.none'),local:translate(props.language,'sidebar.thisComputer'),chooser:translate(props.language,'sidebar.addProject')};flushSync(()=>root.render(<React.StrictMode><I18nProvider key={++generation}><ToastProvider><Fixture {...props}/></ToastProvider></I18nProvider></React.StrictMode>));};window.unmountFixture=()=>flushSync(()=>root.render(null));`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
  loader: { ".css": "empty", ".png": "empty", ".webp": "empty", ".wav": "empty" },
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
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
const html =
  '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;overflow:hidden}</style><div id="root"></div><input aria-label="Outside field" style="position:fixed;right:0;top:0;width:60px;z-index:999"><svg id="outside-svg" width="24" height="24" style="position:fixed;left:0;top:0;z-index:999"><rect width="24" height="24" fill="black"/></svg>';
let browser,
  nativeContext,
  nativeZoom = 1;
if (native) {
  const main = path.join(output, "main.cjs");
  await writeFile(
    main,
    `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output, "data"))});app.whenReady().then(()=>{const win=new BrowserWindow({width:800,height:480,frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.loadURL('about:blank')});`,
  );
  browser = await _electron.launch({ executablePath: require("electron"), args: [main] });
  nativeContext = browser.context();
} else
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin" &&
      existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
const reports = [],
  errors = [],
  blocked = [];
let lastPage,
  completed = false;
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const isFocused = (locator) => locator.evaluate((node) => node === document.activeElement);
const trigger = (page, index = 0) =>
  page.locator(`[data-composer-index="${index}"] button[aria-haspopup="dialog"]`);
const popup = (page, names) => page.getByRole("dialog", { name: names.search, exact: true });
async function resize(page, width, height) {
  if (native) {
    await browser.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(size.width * size.zoom, size.height * size.zoom);
        win.webContents.setZoomFactor(size.zoom);
        win.show();
        win.focus();
      },
      { width, height, zoom: nativeZoom },
    );
    await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
      width,
      height,
    });
  } else await page.setViewportSize({ width, height });
  await frames(page);
}
async function capture(page, file) {
  if (!native) return page.screenshot({ path: file });
  const base64 = await browser.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
  );
  const buffer = Buffer.from(base64, "base64");
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  assert.equal(buffer.readUInt32BE(16), viewport.width * viewport.dpr);
  assert.equal(buffer.readUInt32BE(20), viewport.height * viewport.dpr);
  await writeFile(file, buffer);
}
async function visible(locator, label) {
  const data = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let p = node.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p),
        b = p.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, b.left);
        clip.right = Math.min(clip.right, b.right);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, b.top);
        clip.bottom = Math.min(clip.bottom, b.bottom);
      }
    }
    return {
      box: box.toJSON(),
      clip,
      full:
        box.width > 0 &&
        box.height > 0 &&
        box.left >= clip.left - 1 &&
        box.right <= clip.right + 1 &&
        box.top >= clip.top - 1 &&
        box.bottom <= clip.bottom + 1,
      hit: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
    };
  });
  assert.equal(data.full && data.hit, true, label + ": " + JSON.stringify(data));
}
async function inspect(page, config, label) {
  const data = await page.evaluate(() => {
    const menu = document.querySelector("[role=dialog]"),
      list = menu.querySelector("[role=listbox]");
    const box = (node) => ({
      ...node.getBoundingClientRect().toJSON(),
      scrollTop: node.scrollTop,
      scrollLeft: node.scrollLeft,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    });
    const nodes = [menu, ...menu.querySelectorAll("*")];
    for (let p = menu.parentElement; p; p = p.parentElement) nodes.push(p);
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      menu: box(menu),
      list: box(list),
      activeInside: menu.contains(document.activeElement),
      hiddenScroll: nodes
        .filter((node) => {
          const s = getComputedStyle(node);
          return (
            (/hidden|clip/.test(s.overflowY) && node.scrollTop !== 0) ||
            (/hidden|clip/.test(s.overflowX) && node.scrollLeft !== 0)
          );
        })
        .map((node) => ({ tag: node.tagName, top: node.scrollTop, left: node.scrollLeft })),
      calls: window.calls,
    };
  });
  if (native)
    data.native = await browser.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { bounds: win.getContentBounds(), zoom: win.webContents.getZoomFactor() };
    });
  reports.push({ ...config, label, ...data });
  assert.equal(data.width, config.width);
  assert.equal(data.height, config.height);
  assert.ok(
    data.menu.x >= 0 &&
      data.menu.y >= 0 &&
      data.menu.right <= config.width + 1 &&
      data.menu.bottom <= config.height + 1,
    JSON.stringify(data),
  );
  assert.ok(data.menu.scrollWidth <= data.menu.clientWidth + 1);
  assert.deepEqual(data.hiddenScroll, []);
  assert.equal(data.activeInside, true);
  if (native) {
    assert.equal(data.native.zoom, nativeZoom);
    assert.equal(data.native.bounds.width, config.width * nativeZoom);
    assert.equal(data.native.bounds.height, config.height * nativeZoom);
  }
  return data;
}
async function mount(page, config, extra = {}) {
  await page.evaluate((props) => window.renderFixture(props), { ...config, ...extra });
  await page.locator("textarea").first().waitFor();
  await frames(page);
  return page.evaluate(() => window.labels);
}
async function open(page, names, index = 0, key = "Enter") {
  await trigger(page, index).focus();
  await page.keyboard.press(key);
  const menu = popup(page, names);
  await menu.waitFor();
  await page.waitForFunction(
    (id) => document.getElementById(id)?.style.visibility === "visible",
    await trigger(page, index).getAttribute("aria-controls"),
  );
  await frames(page);
  assert.equal(await isFocused(menu.getByRole("textbox")), true);
  return menu;
}
async function tabTo(page, locator) {
  for (let i = 0; i < 8 && !(await isFocused(locator)); i++) await page.keyboard.press("Tab");
  assert.equal(await isFocused(locator), true, "Target reached through native Tab");
}
async function baselineExercise(page, config) {
  const names = await mount(page, config);
  const oldTrigger = () =>
    page
      .locator('[data-composer-index="0"]')
      .getByRole("button", { name: names.none, exact: true });
  const oldOpen = async () => {
    await oldTrigger().focus();
    await page.keyboard.press("Enter");
    await page.getByRole("listbox").waitFor();
    await frames(page);
  };
  await oldOpen();
  const search = page.getByRole("textbox", { name: names.search, exact: true });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await isFocused(search), true);
  assert.equal(await search.getAttribute("aria-activedescendant"), null);
  assert.deepEqual(await page.evaluate(() => window.calls.select), []);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  reports.push({ ...config, label: "baseline-arrow-no-selection-and-escape-body" });
  await oldOpen();
  await search.fill("_34");
  const row = page.getByRole("listbox").getByRole("option");
  await tabTo(page, row);
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.calls.select), [{ index: 0, id: "owned-34" }]);
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  reports.push({ ...config, label: "baseline-native-tab-selection-body" });
  await mount(page, config);
  await oldOpen();
  await search.fill("no-owned-match");
  await tabTo(page, page.getByRole("button", { name: names.clear, exact: true }));
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  reports.push({ ...config, label: "baseline-cleared-filter-body" });
  await page.keyboard.press("Escape");
  await oldOpen();
  await search.fill("no-owned-match");
  await tabTo(page, page.getByRole("button", { name: names.add, exact: true }));
  await page.keyboard.press("Enter");
  const chooser = page.getByRole("dialog", { name: names.chooser, exact: true });
  await chooser.waitFor();
  await page.keyboard.press("Escape");
  await chooser.waitFor({ state: "hidden" });
  await frames(page);
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  reports.push({ ...config, label: "baseline-chooser-return-body" });
  await capture(page, path.join(output, `baseline-${config.language}-${config.width}.png`));
}
async function exercise(page, config) {
  const names = await mount(page, config);
  let menu = await open(page, names);
  const search = menu.getByRole("textbox"),
    list = menu.getByRole("listbox");
  const options = list.getByRole("option");
  assert.equal(await options.count(), 35);
  assert.equal(await trigger(page).getAttribute("aria-haspopup"), "dialog");
  assert.equal(await search.getAttribute("aria-controls"), await list.getAttribute("id"));
  await visible(search, "Search is always visible");
  await visible(menu.getByRole("button", { name: names.add, exact: true }), "Add stays visible");
  await visible(
    menu.getByRole("button", { name: names.none, exact: true }),
    "No-project stays visible",
  );
  await inspect(page, config, "opened");
  await page.keyboard.press("ArrowDown");
  assert.equal(await isFocused(options.first()), true);
  await page.keyboard.press("End");
  assert.equal(await isFocused(options.last()), true);
  assert.equal(
    await options.last().textContent(),
    await page.evaluate(() => window.projects.at(-1).name),
  );
  await visible(options.last(), "End reaches long project completely");
  await inspect(page, config, "keyboard-end");
  await page.keyboard.press("Home");
  assert.equal(await isFocused(options.first()), true);
  await visible(options.first(), "Home reaches first project");
  const before = await list.evaluate((node) => node.scrollTop);
  const rowHeight = await options.first().evaluate((node) => node.getBoundingClientRect().height);
  const b = await list.boundingBox();
  await page.mouse.move(b.x + 3, b.y + b.height / 2);
  await page.mouse.wheel(0, 180);
  try {
    await page.waitForFunction(
      ({ id, before, rowHeight }) => document.getElementById(id).scrollTop >= before + rowHeight,
      {
        id: await list.getAttribute("id"),
        before,
        rowHeight,
      },
    );
    await list.evaluate(
      (node) =>
        new Promise((resolve) => {
          let previous = node.scrollTop,
            stable = 0;
          const frame = () => {
            const value = node.scrollTop;
            stable = value === previous ? stable + 1 : 0;
            previous = value;
            if (stable >= 8) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }),
    );
    assert.ok(
      (await list.evaluate((node) => node.scrollTop)) >= before + rowHeight,
      "User Wheel must remain scrolled past one real project row",
    );
  } catch (error) {
    await inspect(page, config, "wheel-failure");
    throw error;
  }
  await inspect(page, config, "real-wheel");
  await visible(search, "Search after Wheel");
  await visible(menu.getByRole("button", { name: names.add, exact: true }), "Add after Wheel");
  await visible(
    menu.getByRole("button", { name: names.none, exact: true }),
    "No-project after Wheel",
  );
  await capture(
    page,
    path.join(output, `${config.language}-${config.theme}-${config.width}x${config.height}.png`),
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  assert.equal(await isFocused(search), true);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await isFocused(trigger(page)), true);
  assert.deepEqual(await page.evaluate(() => window.calls.select), []);
  menu = await open(page, names);
  await menu.getByRole("textbox").fill("_34");
  assert.equal(await menu.getByRole("option").count(), 1);
  await tabTo(page, menu.getByRole("option"));
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await isFocused(trigger(page)), true);
  assert.deepEqual(await page.evaluate(() => window.calls.select), [{ index: 0, id: "owned-34" }]);
  assert.equal(await page.evaluate(() => window.composers[0].state.active), "owned-34");
  await page.evaluate(() => window.flushSessionPersistence());
  assert.deepEqual(await page.evaluate(() => window.catalogWrites), [
    { projectKey: "owned-34", activeSessionId: null },
  ]);
  assert.equal(
    await page.evaluate(() => window.composers[0].indices["owned-34"].activeSessionId),
    null,
  );
  assert.equal(await page.evaluate(() => window.composers[0].state.draft), "Owned unsent draft");
  menu = await open(page, names);
  assert.equal(await menu.getByRole("textbox").inputValue(), "");
  await page.keyboard.press("Escape");
  reports.push({ ...config, label: "exact-new-draft-selection" });
}
async function behaviors(page, config) {
  const names = await mount(page, config);
  let menu = await open(page, names);
  let search = menu.getByRole("textbox");
  await search.fill("not-an-owned-project");
  assert.equal(await menu.getByRole("option").count(), 0);
  await page.keyboard.press("Escape");
  menu = await open(page, names);
  assert.equal(await menu.getByRole("textbox").inputValue(), "not-an-owned-project");
  await tabTo(page, menu.getByRole("button", { name: names.clear, exact: true }));
  await page.keyboard.press("Enter");
  assert.equal(await isFocused(menu.getByRole("textbox")), true);
  assert.equal(await menu.getByRole("option").count(), 35);
  reports.push({ label: "filter-preserved-and-clear-owned" });
  search = menu.getByRole("textbox");
  await search.fill("no-owned-match");
  await tabTo(page, menu.getByRole("button", { name: names.add, exact: true }));
  await page.keyboard.press("Enter");
  const chooser = page.getByRole("dialog", { name: names.chooser, exact: true });
  await chooser.waitFor();
  await page.keyboard.press("Escape");
  await chooser.waitFor({ state: "hidden" });
  await frames(page);
  assert.equal(await isFocused(trigger(page)), true);
  assert.deepEqual(await page.evaluate(() => window.calls.add), [0]);
  assert.equal(await page.evaluate(() => window.calls.picker), 0);
  reports.push({ label: "chooser-cancel-returns-stable-project-trigger" });
  menu = await open(page, names);
  await menu.getByRole("button", { name: names.none, exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls.select), [{ index: 0, id: null }]);
  assert.equal(await isFocused(trigger(page)), true);
  assert.equal(await page.evaluate(() => window.composers[0].state.draft), "Owned unsent draft");
  reports.push({ label: "exact-no-project-wire" });
  await mount(page, config);
  menu = await open(page, names);
  await menu.getByRole("button", { name: names.add, exact: true }).click();
  await chooser.waitFor();
  const local = chooser.getByRole("button", { name: names.local, exact: true });
  await page.waitForFunction(
    (label) => document.activeElement?.getAttribute("aria-label") === label,
    names.local,
  );
  await page.evaluate(() => (window.pickerMode = "hold"));
  await local.evaluate((node) => {
    node.click();
    node.click();
  });
  assert.equal(await page.evaluate(() => window.calls.picker), 1);
  await page.evaluate(() => window.pendingPick.reject(Error("Owned picker rejected")));
  await chooser.getByRole("alert").waitFor();
  await frames(page);
  assert.equal(await isFocused(local), true);
  assert.equal(await trigger(page).getAttribute("aria-expanded"), "false");
  await page.evaluate(() => (window.pickerMode = "cancel"));
  await page.keyboard.press("Enter");
  await chooser.waitFor({ state: "hidden" });
  await frames(page);
  assert.equal(await isFocused(trigger(page)), true);
  assert.equal(await page.evaluate(() => window.calls.picker), 2);
  assert.deepEqual(await page.evaluate(() => window.calls.select), []);
  assert.deepEqual(await page.evaluate(() => window.calls.before), []);
  assert.equal(await page.evaluate(() => window.composers[0].state.active), null);
  assert.equal(await page.evaluate(() => window.composers[0].state.draft), "Owned unsent draft");
  reports.push({ label: "actual-local-picker-held-failure-retry-cancel" });
  for (const kind of ["focus", "pointer", "blur"]) {
    menu = await open(page, names);
    if (kind === "focus") await page.getByRole("textbox", { name: "Outside field" }).focus();
    else if (kind === "pointer") await page.locator("#outside-svg rect").click();
    else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await menu.waitFor({ state: "hidden" });
    await frames(page);
    assert.equal(await isFocused(trigger(page)), false);
    if (kind === "focus")
      assert.equal(await isFocused(page.getByRole("textbox", { name: "Outside field" })), true);
    reports.push({ label: "outside-does-not-restore", kind });
  }
  menu = await open(page, names);
  search = menu.getByRole("textbox");
  await search.evaluate((node) => {
    node.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    node.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    node.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(await menu.count(), 1);
  assert.equal(await isFocused(search), true);
  assert.deepEqual(await page.evaluate(() => window.calls.select), []);
  await search.evaluate((node) =>
    node.dispatchEvent(new Event("compositionend", { bubbles: true })),
  );
  await page.keyboard.press("ArrowDown");
  const first = menu.getByRole("option").first();
  assert.equal(await isFocused(first), true);
  await first.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(await menu.count(), 1);
  await page.keyboard.press("Escape");
  reports.push({ label: "composition-does-not-activate-or-close" });
  menu = await open(page, names);
  await menu
    .getByRole("textbox")
    .evaluate((node) => node.dispatchEvent(new Event("compositionstart", { bubbles: true })));
  await page.getByRole("textbox", { name: "Outside field" }).focus();
  await menu.waitFor({ state: "hidden" });
  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await menu.waitFor();
  await frames(page);
  assert.equal(await isFocused(menu.getByRole("textbox")), true);
  await page.keyboard.press("Escape");
  reports.push({ label: "composition-state-does-not-block-later-open" });
  menu = await open(page, names);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.evaluate(() => window.composers[0].patch({ projects: window.projects.slice(0, -1) }));
  await frames(page);
  assert.equal(await isFocused(menu.getByRole("textbox")), true);
  await page.keyboard.press("Escape");
  reports.push({ label: "removed-focused-project-recovers-search" });
  menu = await open(page, names);
  await page.evaluate(() => window.composers[0].patch({ busy: true }));
  await menu.waitFor({ state: "hidden" });
  assert.equal(await trigger(page).isDisabled(), true);
  await page.getByRole("textbox", { name: "Outside field" }).focus();
  await page.evaluate(() => window.composers[0].patch({ busy: false }));
  await frames(page);
  assert.equal(await menu.count(), 0);
  assert.equal(await isFocused(page.getByRole("textbox", { name: "Outside field" })), true);
  reports.push({ label: "disabled-closes-without-reopen-or-steal" });
  menu = await open(page, names);
  await page.keyboard.press("Shift+Tab");
  await frames(page);
  assert.equal(await menu.count(), 0);
  assert.equal(await isFocused(trigger(page)), true);
  reports.push({ label: "shift-tab-leaves-nonmodal-menu" });
  menu = await open(page, names);
  await page.evaluate(() => {
    const anchor = document.querySelector(
      '[data-composer-index="0"] button[aria-haspopup="dialog"]',
    );
    const controls = [
      ...document.querySelectorAll("button,input,textarea,select,a[href],[tabindex]"),
    ].filter(
      (node) =>
        node.tabIndex >= 0 &&
        !node.matches(":disabled") &&
        node.getClientRects().length &&
        !node.closest('[role="dialog"]'),
    );
    window.expectedNext = controls[controls.indexOf(anchor) + 1];
  });
  await tabTo(page, menu.getByRole("button", { name: names.none, exact: true }));
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement === window.expectedNext), true);
  await visible(page.locator(":focus"), "Forward Tab reaches a usable composer neighbor");
  reports.push({ label: "last-tab-continues-from-composer-trigger" });
  menu = await open(page, names);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  for (const [width, height] of [
    [320, 240],
    [390, 360],
    [760, 480],
  ]) {
    await resize(page, width, height);
    await frames(page);
    await visible(menu.locator(":focus"), "Resize keeps actual focused option visible");
    await visible(
      menu.getByRole("button", { name: names.add, exact: true }),
      "Resize keeps Add visible",
    );
    await visible(
      menu.getByRole("button", { name: names.none, exact: true }),
      "Resize keeps No-project visible",
    );
    await inspect(page, { ...config, width, height }, "live-resize");
  }
  await page.keyboard.press("Escape");
  await mount(page, config, { multiple: true });
  await open(page, names, 0);
  const firstId = await trigger(page, 0).getAttribute("aria-controls");
  await trigger(page, 1).focus();
  await page.keyboard.press("Enter");
  menu = popup(page, names);
  await menu.waitFor();
  const secondId = await trigger(page, 1).getAttribute("aria-controls");
  assert.notEqual(firstId, secondId);
  assert.equal(await trigger(page, 0).getAttribute("aria-expanded"), "false");
  assert.equal(await menu.count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await isFocused(trigger(page, 1)), true);
  reports.push({ label: "multiple-picker-ids-and-close-owner" });
  await mount(page, config, { variant: "quickChat" });
  assert.equal(await trigger(page).count(), 0);
  reports.push({ label: "quick-chat-has-no-project-picker" });
  await mount(page, config);
  menu = await open(page, names);
  await page.evaluate(() => window.unmountFixture());
  await frames(page);
  assert.equal(await menu.count(), 0);
  await page.getByRole("textbox", { name: "Outside field" }).focus();
  await frames(page);
  assert.equal(await isFocused(page.getByRole("textbox", { name: "Outside field" })), true);
  reports.push({ label: "unmount-has-no-late-focus" });
}
try {
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const [width, height] of [
        [320, 240],
        [390, 360],
        [760, 480],
        [1280, 720],
      ]) {
        if (baseline && (theme === "dark" || width === 320 || width === 760)) continue;
        const config = { language, theme, width, height };
        nativeZoom = native && theme === "dark" && width <= 390 ? 2 : 1;
        const context = native
          ? nativeContext
          : await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
        if (!native || reports.length === 0)
          await context.route("**/*", (route) => {
            if (route.request().url() === "http://project-picker-owned.test/")
              return route.fulfill({ contentType: "text/html", body: html });
            blocked.push(route.request().url());
            return route.abort();
          });
        const page = (lastPage = native ? await browser.firstWindow() : await context.newPage());
        if (!native || reports.length === 0)
          page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(6000);
        await page.goto("http://project-picker-owned.test/");
        if (native) await resize(page, width, height);
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: built.outputFiles[0].text });
        if (baseline) await baselineExercise(page, config);
        else await exercise(page, config);
        if (!baseline && width === 760 && theme === "light") await behaviors(page, config);
        assert.deepEqual(await page.evaluate(() => window.unexpected), []);
        if (!native) await context.close();
      }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  completed = true;
  console.log(
    JSON.stringify({
      output,
      native,
      development,
      layouts: baseline ? 4 : 16,
      observations: reports.length,
      errors,
      blocked,
    }),
  );
} finally {
  if (!completed && lastPage && !lastPage.isClosed())
    await capture(lastPage, path.join(output, "failure.png")).catch(() => {});
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { sourceDesktop, native, development, baseline, reports, errors, blocked },
      null,
      2,
    ),
  );
  await browser.close();
}
