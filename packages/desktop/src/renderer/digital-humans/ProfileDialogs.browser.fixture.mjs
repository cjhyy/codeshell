/** Production Settings → Profile dialogs: owned bridge, no services, credentials or network.
 * node ProfileDialogs.browser.fixture.mjs [--source-desktop /path/to/packages/desktop] [--electron]
 */
/* global document, window, Event, getComputedStyle, requestAnimationFrame, innerWidth, innerHeight, HTMLInputElement, HTMLTextAreaElement, MutationObserver */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const ownDesktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-desktop");
const desktop = sourceIndex < 0 ? ownDesktop : path.resolve(process.argv[sourceIndex + 1]);
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(ownDesktop, "package.json"));
const { build } = require("esbuild");
const { chromium, _electron } = require("playwright");
const electronMode = process.argv.includes("--electron");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const output =
  process.env.CODESHELL_PROFILE_DIALOGS_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-profile-dialogs-")));
await mkdir(output, { recursive: true });
const source = `
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{SettingsPage}from'./settings/SettingsPage';import{DigitalHumansView}from'./digital-humans/DigitalHumansView';import{I18nProvider}from'./i18n/I18nProvider';import{DialogProvider}from'./ui/DialogProvider';import{ToastProvider}from'./ui/ToastProvider';import{saveUILanguage}from'./uiLanguage';import{saveTheme,applyTheme}from'./theme';import{saveProjects}from'./projects';
const root=createRoot(document.getElementById('root'));let generation=0;
function Fixture({projectScope}){const[view,setView]=React.useState('settings');return <div style={{position:'fixed',inset:0,overflow:'hidden'}}>{view==='settings'?<SettingsPage initialProjectPath={projectScope?'/owned/project':null} initialModule={projectScope?'digital-humans':undefined} activeProjectPath='/owned/project' projects={[{id:'owned',name:'Owned project',path:'/owned/project',roots:[],addedAt:0}]} sessionIndices={{}} onRestoreArchivedSession={()=>{}} onDeleteArchivedSession={()=>{}} isMac={false} isFullscreen={false} onBack={()=>{}} onOpenDigitalHumans={()=>setView('profiles')}/>:<DigitalHumansView configurationTarget={{projectId:'owned'}} projectName='Owned project' onUse={()=>window.calls.unsafe.push('onUse')} onOpenSettings={()=>setView('settings')}/>}</div>}
window.mountFixture=({language,theme="light",longNames=true,memoryFail=false,projectScope=false})=>{
localStorage.clear();saveProjects([{id:'owned',name:'Owned project',path:'/owned/project',roots:[{id:'owned-root',name:'Owned root',path:'/owned/project',addedAt:0}],primaryRootId:'owned-root',addedAt:0}]);saveUILanguage(language);saveTheme(theme);applyTheme(theme);window.calls={reads:[],unsafe:[],rejected:[]};window.fixture={hold:null,reject:null,holdRead:null,resolveRead:null};const label=longNames?'Owned_Profile_'.repeat(8):'Owned profile';window.profileLabel=label;
const profile={name:'owned-profile',label,description:'Owned profile description '+ 'long description '.repeat(20),basePreset:'general',mainInstruction:'Owned system instruction '+ 'readable line '.repeat(30),plugins:[],skills:[],mcp:[],agents:[],active:true,portableMemory:true};const profiles=[profile,{...profile,name:'owned-other',label:'Owned other',active:false}];
const settings={permissionMode:'default',modelConnections:[],credentials:[],defaults:{},pet:{}};
const ownedRead=(method,value)=>async(...args)=>{window.calls.reads.push({method,args});if(window.fixture.holdRead===method)await new Promise(resolve=>{window.fixture.resolveRead=resolve});if(method==='previewProfileRequirements'&&window.fixture.blockRequirements)return {needsInstall:false,willRun:[],warnings:[],blockers:['Owned unavailable external tool']};return structuredClone(value)};
const unsafe=method=>async()=>{window.calls.unsafe.push(method);throw Error('Forbidden real operation '+method)};
const rejected=method=>async(...args)=>{window.calls.rejected.push({method,args});const error=Error('Owned '+method+' failed '+ 'long_failure_context_'.repeat(20));if(window.fixture.hold===method)await new Promise((_,reject)=>{window.fixture.reject=()=>reject(error)});throw error};
const memory=Array.from({length:30},(_,index)=>({name:'Owned memory '+index,description:'Owned memory description '+ 'long text '.repeat(12),type:'user',fileName:'owned-'+index+'.md',scope:'user',level:'profile',id:'owned-'+index,origin:'manual',createdAt:'2026-10-15T01:00:00Z'}));let reads=0;
window.codeshell={getSettings:ownedRead('getSettings',settings),getConfigurationSettings:ownedRead('getConfigurationSettings',settings),getModelCatalog:ownedRead('getModelCatalog',[]),getCatalogOrigins:ownedRead('getCatalogOrigins',{}),getUpdaterStatus:ownedRead('getUpdaterStatus',{kind:'idle'}),onUpdaterStatus:()=>()=>{},getAppVersion:async()=>'profile-owned',
listProfiles:ownedRead('listProfiles',profiles),listSkills:ownedRead('listSkills',Array.from({length:20},(_,index)=>({name:'owned-skill-'+index,description:'Owned skill description '.repeat(10),source:'user',enabled:true}))),listProfileRepos:ownedRead('listProfileRepos',[]),listProfileCatalog:ownedRead('listProfileCatalog',[]),listDigitalHumanTeams:ownedRead('listDigitalHumanTeams',[]),previewProfileRequirements:ownedRead('previewProfileRequirements',{needsInstall:false,willRun:[],warnings:[],blockers:[]}),
previewProfileSwitch:ownedRead('previewProfileSwitch',{revision:'owned-r1',target:{kind:'project',projectId:'owned'},before:{name:profile.name,label,available:true},after:null,instruction:{changed:true,beforeLength:128,afterLength:0},memory:{before:profile.name,after:null},capabilities:Array.from({length:15},(_,index)=>({kind:'skill',name:'owned_capability_'+ 'long_segment_'.repeat(12)+index,before:true,after:false})),missingDeclarations:[],sources:{before:Array.from({length:10},(_,index)=>({sourceId:'owned-source-'+index,label:'Owned source '+ 'long_source_name_'.repeat(8),scopes:['project'],readPolicy:'ask',status:'ok'})),after:[]},exclusiveSkillsOnly:false}),
listMemory:async(...args)=>{window.calls.reads.push({method:'listMemory',args});if(window.fixture.rejectMemoryReadOnce){window.fixture.rejectMemoryReadOnce=false;throw Error('Owned memory read failed')};if(memoryFail&&reads++===0)throw Error('Owned memory read failed');return structuredClone(memory)},readMemory:async(...args)=>{window.calls.reads.push({method:'readMemory',args});return {...memory[0],content:Array.from({length:100},(_,i)=>'Owned content line '+i+' '+ 'body_segment_'.repeat(8)).join(String.fromCharCode(10))}},
saveProfile:rejected('saveProfile'),adoptProfileSwitch:rejected('adoptProfileSwitch'),saveMemory:rejected('saveMemory'),installProfileRequirements:unsafe('installProfileRequirements'),addProfileRepo:unsafe('addProfileRepo'),updateProfileRepo:unsafe('updateProfileRepo'),removeProfileRepo:unsafe('removeProfileRepo'),deleteProfile:unsafe('deleteProfile'),updateSettings:unsafe('updateSettings'),updateConfigurationSettings:unsafe('updateConfigurationSettings'),openExternal:unsafe('openExternal'),log:()=>{}};
flushSync(()=>root.render(<I18nProvider key={++generation}><DialogProvider><ToastProvider><Fixture projectScope={projectScope}/></ToastProvider></DialogProvider></I18nProvider>));};window.unmountFixture=()=>flushSync(()=>root.render(null));`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".webp": "empty", ".wav": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
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
let nativeContext;
let nativeZoom = 1;
if (electronMode) {
  const main = path.join(output, "owned-electron.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(output, "user-data"))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:800,height:600,useContentSize:true,frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.loadURL('about:blank');});`,
  );
  browser = await _electron.launch({ executablePath: require("electron"), args: [main] });
  nativeContext = browser.context();
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
const errors = [],
  blocked = [],
  reports = [];
let lastPage,
  completed = false;
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const focused = (locator) => locator.evaluate((node) => node === document.activeElement);
async function reachable(locator) {
  return locator.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, box.left);
        clip.right = Math.min(clip.right, box.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, box.top);
        clip.bottom = Math.min(clip.bottom, box.bottom);
      }
    }
    return {
      bounds: bounds.toJSON(),
      clip,
      full:
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.left >= clip.left - 1 &&
        bounds.right <= clip.right + 1 &&
        bounds.top >= clip.top - 1 &&
        bounds.bottom <= clip.bottom + 1,
      hit: node.contains(
        document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
      ),
    };
  });
}
async function assertReachable(locator, message) {
  const result = await reachable(locator);
  assert.equal(result.full && result.hit, true, `${message}: ${JSON.stringify(result)}`);
}
async function tabTo(page, target) {
  for (let index = 0; index < 100; index++) {
    if (await focused(target)) return;
    await page.keyboard.press("Tab");
  }
  assert.fail("The profile dialog opener must be reachable through native Tab navigation");
}
const text = (language) =>
  language === "zh"
    ? {
        module: "数字人",
        edit: "编辑",
        market: "打开数字人页",
        memory: "编辑长期记忆",
        switch: "取消项目默认",
        activate: "设为项目默认",
        close: "关闭",
        cancel: "取消",
        discard: "放弃修改",
        save: "保存数字人",
        refresh: "刷新",
        newMemory: "新建",
        navigation: "数字人编辑区域",
      }
    : {
        module: "Digital humans",
        edit: "Edit",
        market: "Open digital humans",
        memory: "Edit long-term memory",
        switch: "Clear project default",
        activate: "Set project default",
        close: "Close",
        cancel: "Cancel",
        discard: "Discard",
        save: "Save digital human",
        refresh: "Refresh",
        newMemory: "New",
        navigation: "Digital-human editor sections",
      };
const animate = (dialog) =>
  dialog.evaluate((node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
    ),
  );
async function resizeNative(width, height) {
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
  assert.equal(
    await browser.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
    nativeZoom,
  );
  const page = await browser.firstWindow();
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
    width,
    height,
  });
}
async function mountSettings(page, config) {
  await page.evaluate((config) => window.mountFixture(config), config);
  await page.getByText("profile-owned", { exact: true }).waitFor();
  const search = page.getByRole("searchbox").filter({ visible: true });
  await search.fill(text(config.language).module);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const module = page
    .getByRole("button", { name: text(config.language).module, exact: true })
    .filter({ visible: true });
  assert.equal(await focused(module), true);
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { name: text(config.language).module, exact: true, level: 1 })
    .waitFor();
  await page
    .getByRole("button", { name: text(config.language).edit, exact: true })
    .first()
    .waitFor();
}
async function openEditor(page, config) {
  const opener = page
    .getByRole("button", { name: text(config.language).edit, exact: true })
    .first();
  await tabTo(page, opener);
  await assertReachable(opener, "Settings editor opener");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  return { opener, dialog };
}
async function enterMarket(page, config) {
  const market = page.getByRole("button", { name: text(config.language).market, exact: true });
  await tabTo(page, market);
  await assertReachable(market, "Settings to digital-human page");
  await page.keyboard.press("Enter");
  await page.locator('[data-digital-human-card="owned-profile"]').waitFor();
}
async function openMenuDialog(page, config, surface, waitForDialog = true, other = false) {
  const label = other ? "Owned other" : await page.evaluate(() => window.profileLabel);
  const opener = page.getByRole("button", {
    name:
      config.language === "zh" ? "「" + label + "」的更多操作" : "More actions for “" + label + "”",
    exact: true,
  });
  await tabTo(page, opener);
  await assertReachable(opener, "Stable profile More trigger");
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", { name: text(config.language)[surface], exact: true });
  await item.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  if (waitForDialog) {
    await dialog.waitFor();
    await animate(dialog);
  }
  return { opener, dialog };
}
async function inspect(page, config, surface, phase) {
  const result = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]'),
      active = document.activeElement;
    const box = (node) =>
      node
        ? {
            ...node.getBoundingClientRect().toJSON(),
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            scrollTop: node.scrollTop,
            scrollLeft: node.scrollLeft,
          }
        : null;
    const nodes = [dialog, ...dialog.querySelectorAll("*")];
    for (let node = dialog.parentElement; node; node = node.parentElement) nodes.push(node);
    return {
      width: innerWidth,
      height: innerHeight,
      dialog: box(dialog),
      activeInside: dialog.contains(active),
      activeTag: active.tagName,
      body: box(dialog.querySelector('[role="region"]')),
      hiddenScroll: nodes
        .filter((node) => {
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return false;
          const style = getComputedStyle(node);
          return (
            (/hidden|clip/.test(style.overflowY) && node.scrollTop !== 0) ||
            (/hidden|clip/.test(style.overflowX) && node.scrollLeft !== 0)
          );
        })
        .map((node) => ({ tag: node.tagName, top: node.scrollTop, left: node.scrollLeft })),
    };
  });
  reports.push({ ...config, surface, phase, ...result });
  assert.equal(result.width, config.width);
  assert.equal(result.height, config.height);
  assert.ok(
    result.dialog.x >= 0 &&
      result.dialog.y >= 0 &&
      result.dialog.right <= config.width + 1 &&
      result.dialog.bottom <= config.height + 1,
    JSON.stringify(result),
  );
  assert.ok(
    result.dialog.scrollWidth <= result.dialog.clientWidth + 1,
    "Long text cannot expand the modal",
  );
  assert.equal(result.dialog.scrollTop, 0);
  assert.deepEqual(result.hiddenScroll, [], "Hidden/clip containers cannot be scrolled to pass");
  assert.equal(result.activeInside, true, "Keyboard focus remains inside the modal");
  return result;
}
async function activeHit(page) {
  const value = await page.evaluate(() => {
    const node = document.activeElement,
      box = node.getBoundingClientRect(),
      hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      style = getComputedStyle(node);
    return {
      tag: node.tagName,
      id: node.id,
      box: box.toJSON(),
      min: style.minHeight,
      max: style.maxHeight,
      hit: node.contains(hit),
      hitTag: hit?.tagName,
      hitClass: hit?.className,
    };
  });
  assert.equal(value.hit, true, `Focused control center must be visible: ${JSON.stringify(value)}`);
}
async function scrollBody(page, dialog) {
  const body = dialog.getByRole("region");
  await body.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const node = document.querySelector('[role="dialog"] [role="region"]');
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  await body.evaluate(
    (node) =>
      new Promise((resolve) => {
        let previous = node.scrollTop,
          stable = 0;
        const frame = () => {
          const current = node.scrollTop;
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          if (stable >= 8) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  await page.keyboard.press("Home");
  try {
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"] [role="region"]').scrollTop === 0,
    );
  } catch (error) {
    console.error(
      await page.evaluate(() => ({
        active: document.activeElement.tagName,
        id: document.activeElement.id,
        body: document.querySelector('[role="region"]').getBoundingClientRect().toJSON(),
        top: document.querySelector('[role="region"]').scrollTop,
        height: document.querySelector('[role="region"]').clientHeight,
        total: document.querySelector('[role="region"]').scrollHeight,
      })),
    );
    throw error;
  }
  await body.evaluate(
    (node) =>
      new Promise((resolve) => {
        let previous = node.scrollTop,
          stable = 0;
        const frame = () => {
          const current = node.scrollTop;
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          if (stable >= 8) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  const bounds = await body.boundingBox();
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 180);
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"] [role="region"]').scrollTop > 0,
  );
}
async function closeThreeWays(page, config, { opener, dialog }) {
  const close = dialog.getByRole("button", { name: text(config.language).close, exact: true });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "Escape returns to the exact stable opener");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await close.click();
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "Close returns to the exact editor button");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await animate(dialog);
  await page.mouse.click(1, 1);
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "Overlay returns to the exact editor button");
}
async function exercise(page, config, surface) {
  const opened =
    surface === "editor"
      ? await openEditor(page, config)
      : await openMenuDialog(page, config, surface);
  const { dialog, opener } = opened,
    close = dialog.getByRole("button", { name: text(config.language).close, exact: true });
  assert.ok(await dialog.getAttribute("aria-labelledby"));
  await inspect(page, config, surface, "open");
  await assertReachable(close, "Close is visible initially");
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press(index < 8 ? "Tab" : "Shift+Tab");
    await settle(page);
    await inspect(page, config, surface, "tab-" + index);
    await activeHit(page);
    await assertReachable(close, "Close remains visible during keyboard navigation");
  }
  if (surface === "editor") {
    const nav = dialog.getByRole("navigation", { name: text(config.language).navigation });
    for (const section of [
      /System Prompt/,
      /配置 Skills|Configure Skills/,
      /运行设置|Runtime settings/,
      /身份|Identity/,
    ]) {
      const button = nav.getByRole("button", { name: section });
      await button.focus();
      await page.keyboard.press("Enter");
      await settle(page);
      if (section.source.includes("System")) {
        assert.equal(
          await dialog.locator("#digital-human-instruction").inputValue(),
          "Owned system instruction " + "readable line ".repeat(30),
        );
        await dialog.locator("#digital-human-instruction").focus();
        await activeHit(page);
      }
      await inspect(page, config, surface, "section-" + section.source);
      await assertReachable(close, "Close survives section changes");
    }
    assert.equal(
      await dialog.locator("#digital-human-label").inputValue(),
      await page.evaluate(() => window.profileLabel),
    );
  }
  if (surface === "memory") {
    assert.equal(await dialog.getByRole("button", { name: /^Owned memory / }).count(), 30);
    const entry = dialog.getByRole("button", { name: /^Owned memory 0 / });
    await entry.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      window.calls.reads.some((call) => call.method === "readMemory"),
    );
    assert.ok((await dialog.textContent()).includes("Owned content line 99"));
  }
  if (surface === "switch") {
    assert.ok(
      (await dialog.textContent()).includes(
        "owned_capability_" + "long_segment_".repeat(12) + "14",
      ),
    );
    await assertReachable(
      dialog.getByRole("button", { name: text(config.language).cancel, exact: true }),
      "Cancel remains in the footer",
    );
    await assertReachable(
      dialog.getByRole("button", {
        name: config.language === "zh" ? "确认采用" : "Apply reviewed change",
        exact: true,
      }),
      "Review action remains in the footer",
    );
  }
  await scrollBody(page, dialog);
  await close.focus();
  await inspect(page, config, surface, "scrolled");
  await assertReachable(close, "Close survives body keyboard and real Wheel scrolling");
  await page.screenshot({
    path: path.join(
      output,
      `${surface}-${config.language}-${config.theme}-${config.width}x${config.height}.png`,
    ),
  });
  if (electronMode && config.width === 760) {
    for (const [width, height] of [
      [320, 240],
      [390, 360],
      [760, 360],
    ]) {
      await resizeNative(width, height);
      await settle(page);
      await animate(dialog);
      assert.equal(await focused(close), true);
      await inspect(page, { ...config, width, height }, surface, "native-resize");
      await assertReachable(close, "Native resize preserves the focused close action");
    }
  }
  if (surface === "editor") await closeThreeWays(page, config, opened);
  else {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await settle(page);
    assert.equal(await focused(opener), true, "Menu dialogs return to their stable More trigger");
    const reopened = await openMenuDialog(page, config, surface);
    await reopened.dialog
      .getByRole("button", { name: text(config.language).close, exact: true })
      .click();
    await reopened.dialog.waitFor({ state: "hidden" });
    await settle(page);
    assert.equal(await focused(opener), true, "Close restores the same More trigger");
    await openMenuDialog(page, config, surface);
    await page.mouse.click(1, 1);
    await dialog.waitFor({ state: "hidden" });
    await settle(page);
    assert.equal(await focused(opener), true, "Overlay restores the same More trigger");
  }
}
async function behaviors(page, config) {
  await mountSettings(page, config);
  let { dialog, opener } = await openEditor(page, config);
  await dialog.locator("#digital-human-label").fill("Owned changed draft");
  await page.keyboard.press("Escape");
  const confirm = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: /放弃未保存|Discard unsaved/ }) });
  await confirm.waitFor();
  await confirm.getByRole("button", { name: text(config.language).cancel, exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  assert.equal(await dialog.locator("#digital-human-label").inputValue(), "Owned changed draft");
  await dialog.getByRole("button", { name: text(config.language).close, exact: true }).click();
  await confirm.waitFor();
  await confirm.getByRole("button", { name: text(config.language).discard, exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(opener),
    true,
    "Discard child confirmation retains the original return owner",
  );
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  await page.evaluate(() => {
    window.fixture.hold = "saveProfile";
  });
  const save = dialog.locator('button[type="submit"]');
  await save.click();
  await page.waitForFunction(() => window.calls.rejected.length === 1);
  await inspect(page, config, "editor", "pending-save");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 1, "Pending save keeps the dialog open");
  const pendingClose = dialog.getByRole("button", {
    name: text(config.language).close,
    exact: true,
  });
  await assertReachable(pendingClose, "Pending Close remains visible");
  const pendingBox = await pendingClose.boundingBox();
  await page.mouse.click(pendingBox.x + pendingBox.width / 2, pendingBox.y + pendingBox.height / 2);
  assert.equal(await dialog.count(), 1);
  assert.equal((await page.evaluate(() => window.calls.rejected)).length, 1);
  await page.evaluate(() => {
    window.fixture.hold = null;
    window.fixture.reject();
  });
  await page.getByRole("status").filter({ hasText: "Owned saveProfile failed" }).waitFor();
  await settle(page);
  assert.equal(await save.isEnabled(), true);
  assert.equal(
    await dialog.locator("#digital-human-label").inputValue(),
    await page.evaluate(() => window.profileLabel),
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true);
  const toastDismiss = page.getByRole("status").getByRole("button");
  for (let index = await toastDismiss.count(); index > 0; index--)
    await toastDismiss.first().click();
  await enterMarket(page, config);
  ({ dialog, opener } = await openMenuDialog(page, config, "switch"));
  await page.evaluate(() => {
    window.fixture.hold = "adoptProfileSwitch";
  });
  const apply = dialog.getByRole("button", {
    name: config.language === "zh" ? "确认采用" : "Apply reviewed change",
    exact: true,
  });
  await apply.click();
  await page.waitForFunction(() => window.calls.rejected.length === 2);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 1, "Pending adoption cannot dismiss");
  await page.evaluate(() => {
    window.fixture.hold = null;
    window.fixture.reject();
  });
  await dialog.getByRole("alert").filter({ hasText: "Owned adoptProfileSwitch failed" }).waitFor();
  await inspect(page, config, "switch", "failure");
  await assertReachable(apply, "Failed adoption remains retryable");
  await apply.click();
  await page.waitForFunction(() => window.calls.rejected.length === 3);
  await settle(page);
  const calls = await page.evaluate(() => window.calls.rejected);
  assert.deepEqual(calls[1].args, calls[2].args, "Retry keeps target/name/revision exact");
  assert.deepEqual(calls[1].args, [{ projectId: "owned" }, null, "owned-r1"]);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true);
  reports.push({
    ...config,
    behavior: "dirty-confirm-held-save-adoption-exact-wire",
    bridge: await page.evaluate(() => window.calls),
  });
  ({ dialog, opener } = await openMenuDialog(page, config, "memory"));
  await dialog.getByRole("button", { name: text(config.language).newMemory, exact: true }).click();
  const memoryName = dialog.getByRole("textbox", {
    name: config.language === "zh" ? "记忆名称" : "Memory name",
    exact: true,
  });
  await memoryName.fill("Owned unsaved memory");
  const type = dialog.getByRole("combobox");
  await type.focus();
  await activeHit(page);
  await page.keyboard.press("Enter");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox");
  assert.equal(await focused(type), true, "Owned Select returns to its real trigger");
  await activeHit(page);
  await dialog.getByRole("button", { name: text(config.language).cancel, exact: true }).click();
  const memoryConfirm = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: /放弃记忆修改|Discard memory changes/ }) });
  await memoryConfirm.waitFor();
  await memoryConfirm
    .getByRole("button", { name: text(config.language).cancel, exact: true })
    .click();
  await memoryConfirm.waitFor({ state: "hidden" });
  assert.equal(await memoryName.inputValue(), "Owned unsaved memory");
  await dialog.getByRole("button", { name: text(config.language).close, exact: true }).click();
  await memoryConfirm.waitFor();
  await memoryConfirm
    .getByRole("button", {
      name: config.language === "zh" ? "放弃修改" : "Discard changes",
      exact: true,
    })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(opener),
    true,
    "Memory internal and parent confirms preserve More ownership",
  );

  // A second, actual profile must receive the return, not the previous server's opener.
  ({ dialog, opener } = await openMenuDialog(page, config, "memory", true, true));
  assert.ok((await dialog.getByRole("heading").textContent()).includes("Owned other"));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "Another profile retains its own exact More identity");

  ({ dialog, opener } = await openMenuDialog(page, config, "memory"));
  const refreshMemory = dialog.getByRole("button", {
    name: text(config.language).refresh,
    exact: true,
  });
  await page.evaluate(() => {
    window.fixture.rejectMemoryReadOnce = true;
  });
  await refreshMemory.click();
  await dialog.getByText("Owned memory read failed", { exact: true }).waitFor();
  await refreshMemory.click();
  await dialog.getByText("Owned memory read failed", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await dialog.getByRole("button", { name: /^Owned memory / }).count(), 30);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(opener),
    true,
    "A failed owned read remains retryable and preserves the opener",
  );

  ({ dialog, opener } = await openMenuDialog(page, config, "memory"));
  await dialog.evaluate((node) => {
    const observer = new MutationObserver(() => {
      if (node.isConnected) return;
      observer.disconnect();
      window.fixture.closingFocus = document.activeElement.tagName;
      window.dispatchEvent(new Event("blur"));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await page.evaluate(() => window.fixture.closingFocus), "BODY");
  assert.equal(
    await focused(opener),
    false,
    "A blur before FocusScope's delayed return permanently cancels ownership",
  );

  for (const kind of ["external-focus", "external-pointer", "window-blur"]) {
    ({ dialog, opener } = await openMenuDialog(page, config, "memory"));
    if (kind === "external-focus")
      await page.evaluate(() => document.querySelector("#outside").focus());
    if (kind === "external-pointer") await page.mouse.click(config.width - 2, config.height - 2);
    if (kind === "window-blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (await dialog.count()) {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }
    await settle(page);
    assert.equal(
      await focused(opener),
      false,
      kind + " permanently relinquishes modal return ownership",
    );
  }
  ({ dialog, opener } = await openMenuDialog(page, config, "memory"));
  await dialog.getByRole("button", { name: text(config.language).newMemory, exact: true }).click();
  await dialog
    .getByRole("textbox", {
      name: config.language === "zh" ? "记忆名称" : "Memory name",
      exact: true,
    })
    .fill("Owned child confirmation draft");
  await dialog.getByRole("button", { name: text(config.language).close, exact: true }).click();
  await memoryConfirm.waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await memoryConfirm
    .getByRole("button", {
      name: config.language === "zh" ? "放弃修改" : "Discard changes",
      exact: true,
    })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(opener),
    false,
    "External intent in a child confirmation remains cancelled when the parent closes",
  );

  for (const kind of ["unchanged", "external-focus", "external-pointer", "window-blur"]) {
    await page.evaluate(() => {
      window.fixture.holdRead = "previewProfileSwitch";
      window.fixture.resolveRead = null;
    });
    ({ dialog, opener } = await openMenuDialog(page, config, "switch", false));
    await page.waitForFunction(() => typeof window.fixture.resolveRead === "function");
    const before = await page.evaluate(() =>
      window.calls.reads.filter((call) => call.method === "previewProfileSwitch"),
    );
    if (kind === "external-focus")
      await page.evaluate(() => document.querySelector("#outside").focus());
    if (kind === "external-pointer") await page.mouse.click(config.width - 2, config.height - 2);
    if (kind === "window-blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.evaluate(() => {
      window.fixture.holdRead = null;
      window.fixture.resolveRead();
    });
    await dialog.waitFor();
    await animate(dialog);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await settle(page);
    assert.equal(
      await focused(opener),
      kind === "unchanged",
      "Held preview preserves the original UI intent: " + kind,
    );
    assert.deepEqual(before.at(-1).args, [{ projectId: "owned" }, null]);
    reports.push({ ...config, behavior: "held-preview-" + kind, request: before.at(-1) });
  }
  for (const accepted of [true, false]) {
    const previewCount = await page.evaluate(
      () => window.calls.reads.filter((call) => call.method === "previewProfileSwitch").length,
    );
    await page.evaluate(() => {
      window.fixture.blockRequirements = true;
      window.fixture.holdRead = "previewProfileRequirements";
      window.fixture.resolveRead = null;
    });
    ({ opener } = await openMenuDialog(page, config, "activate", false, true));
    await page.waitForFunction(() => typeof window.fixture.resolveRead === "function");
    await settle(page);
    await page.evaluate(() => {
      window.fixture.holdRead = null;
      window.fixture.resolveRead();
    });
    const requirements = page.getByRole("dialog", {
      name: config.language === "zh" ? "缺少外部依赖" : "Missing external dependencies",
      exact: true,
    });
    await requirements.waitFor();
    await animate(requirements);
    await requirements
      .getByRole("button", {
        name: accepted
          ? config.language === "zh"
            ? "确认"
            : "Confirm"
          : text(config.language).cancel,
        exact: true,
      })
      .click();
    await requirements.waitFor({ state: "hidden" });
    if (accepted) {
      dialog = page.getByTestId("profile-switch-preview");
      await dialog.waitFor();
      await animate(dialog);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await settle(page);
      assert.equal(
        await focused(opener),
        true,
        "A held owned requirements confirmation keeps normal return ownership",
      );
    }
    const previews = await page.evaluate(() =>
      window.calls.reads.filter((call) => call.method === "previewProfileSwitch"),
    );
    assert.equal(previews.length, previewCount + Number(accepted));
    if (accepted) assert.deepEqual(previews.at(-1).args, [{ projectId: "owned" }, "owned-other"]);
    await page.evaluate(() => {
      window.fixture.blockRequirements = false;
    });
    reports.push({ ...config, behavior: "held-requirements-confirm-" + accepted });
  }
  await openMenuDialog(page, config, "memory");
  await page.evaluate(() => {
    window.unmountFixture();
    document.querySelector("#outside").focus();
  });
  await settle(page);
  assert.equal(
    await focused(page.locator("#outside")),
    true,
    "Unmounted target cannot steal external focus",
  );
  assert.deepEqual((await page.evaluate(() => window.calls)).unsafe, []);
  reports.push({
    ...config,
    behavior: "memory-dirty-portal-profile-identity-external-intent-unmount",
    bridge: await page.evaluate(() => window.calls),
  });

  await page.evaluate((config) => window.mountFixture({ ...config, projectScope: true }), config);
  await page
    .getByRole("heading", { name: text(config.language).module, exact: true, level: 1 })
    .waitFor();
  opener = page
    .getByRole("button", { name: text(config.language).switch, exact: true })
    .filter({ visible: true });
  await tabTo(page, opener);
  await assertReachable(opener, "Actual project Settings default-profile trigger");
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await animate(dialog);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(opener),
    true,
    "Project Settings switch review restores its own source button",
  );
  assert.deepEqual(
    (
      await page.evaluate(() =>
        window.calls.reads.filter((call) => call.method === "previewProfileSwitch"),
      )
    ).at(-1).args,
    [{ projectId: "owned" }, null],
  );
  reports.push({
    ...config,
    behavior: "project-settings-default-profile-entry",
    bridge: await page.evaluate(() => window.calls),
  });
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await animate(dialog);
  const next = page
    .getByRole("button", {
      name: config.language === "zh" ? "设为项目默认" : "Set as project default",
      exact: true,
      includeHidden: true,
    })
    .filter({ visible: true });
  await next.evaluate((button) => {
    const previous = document.querySelector('[data-testid="profile-switch-preview"]');
    let opened = false;
    const observer = new MutationObserver(() => {
      if (!opened && !previous.isConnected) {
        opened = true;
        button.focus();
        button.click();
      }
      const current = document.querySelector('[data-testid="profile-switch-preview"]');
      if (!opened || !current || current === previous) return;
      observer.disconnect();
      window.fixture.rapidReopened = true;
      window.dispatchEvent(new Event("blur"));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.fixture.rapidReopened === true);
  await dialog.waitFor();
  await animate(dialog);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(next),
    false,
    "A previous closing Dialog cannot consume a rapid successor's cancelled lease",
  );
  assert.deepEqual(
    (
      await page.evaluate(() =>
        window.calls.reads.filter((call) => call.method === "previewProfileSwitch"),
      )
    ).at(-1).args,
    [{ projectId: "owned" }, "owned-other"],
  );
  reports.push({
    ...config,
    behavior: "rapid-project-default-review-ownership",
    bridge: await page.evaluate(() => window.calls),
  });
}
try {
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const [width, height] of [
        [320, 240],
        [390, 360],
        [760, 360],
        [1280, 720],
      ]) {
        const config = {
          language,
          theme,
          width,
          height,
          zoom: electronMode && theme === "dark" && width <= 760 ? 2 : 1,
        };
        nativeZoom = config.zoom;
        const context = electronMode
          ? nativeContext
          : await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
        if (!electronMode || reports.length === 0)
          await context.route("**/*", (route) => {
            if (route.request().url() === "http://profiles-owned.test/")
              return route.fulfill({
                contentType: "text/html",
                body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><button id="outside" style="position:fixed;right:0;bottom:0;z-index:200;pointer-events:auto">Outside focus</button>',
              });
            blocked.push(route.request().url());
            return route.abort();
          });
        const page = (lastPage = electronMode
          ? await browser.firstWindow()
          : await context.newPage());
        if (electronMode) await resizeNative(width, height);
        if (!electronMode || reports.length === 0)
          page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(5000);
        await page.goto("http://profiles-owned.test/");
        // Electron resets per-origin zoom at navigation; apply and verify it
        // after loading, with a correspondingly sized native content window.
        if (electronMode) await resizeNative(width, height);
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: built.outputFiles[0].text });
        await mountSettings(page, config);
        await exercise(page, config, "editor");
        await enterMarket(page, config);
        await exercise(page, config, "memory");
        await exercise(page, config, "switch");
        if (width === 320 && theme === "light") await behaviors(page, config);
        const calls = await page.evaluate(() => window.calls);
        assert.deepEqual(calls.unsafe, []);
        reports.push({ ...config, bridge: calls });
        if (!electronMode) await context.close();
      }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  completed = true;
  console.log(
    JSON.stringify({
      output,
      electronMode,
      layouts: 16,
      observations: reports.length,
      errors,
      blocked,
    }),
  );
} finally {
  if (!completed && lastPage && !lastPage.isClosed())
    await lastPage.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ desktop, electronMode, reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
