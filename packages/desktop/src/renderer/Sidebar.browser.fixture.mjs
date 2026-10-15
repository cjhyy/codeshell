/** Real production Desktop Sidebar: owned bridge, no network or model calls.
 * node Sidebar.browser.fixture.mjs [--source-desktop /path/to/packages/desktop] [--electron-zoom]
 */
/* global document,window,getComputedStyle,requestAnimationFrame,innerWidth,innerHeight */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const ownDesktop = fileURLToPath(new URL("../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-desktop");
const desktop = sourceIndex < 0 ? ownDesktop : path.resolve(process.argv[sourceIndex + 1]);
const require = createRequire(path.join(ownDesktop, "package.json"));
const { build } = require("esbuild");
const { chromium, _electron } = require("playwright");
const electronZoom = process.argv.includes("--electron-zoom");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const renderer = path.join(desktop, "src/renderer");
const output =
  process.env.CODESHELL_SIDEBAR_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-desktop-sidebar-")));
await mkdir(output, { recursive: true });
const source = `
import React from 'react';import{createRoot}from'react-dom/client';import{Sidebar}from'./Sidebar';import{ResponsiveSidebar}from'./app/ResponsiveSidebar';import{useResponsiveSidebar}from'./app/useResponsiveSidebar';import{I18nProvider}from'./i18n/I18nProvider';import{saveUILanguage}from'./uiLanguage';import{applyTheme,saveTheme}from'./theme';import{DialogProvider}from'./ui/DialogProvider';import{ToastProvider}from'./ui/ToastProvider';import{bucketKey}from'./transcripts';
const root=createRoot(document.getElementById('root'));let generation=0;
window.calls=[];window.codeshell={cloudAccount:{status:async()=>({state:'signed-out'}),onStatus:()=>()=>{}},getUpdaterStatus:async()=>({state:'idle'}),onUpdaterStatus:()=>()=>{},getAppVersion:async()=>'0.9.43',onWorkspaceChanged:()=>()=>{},onThemesChanged:()=>()=>{},getProjectGitStatus:async()=>({branch:'main'}),getSessionWorkspace:async()=>({kind:'project',projectPath:'/owned/project'}),getSessionGitStatus:async()=>({branch:'main'}),getTrust:async()=>'trusted',log:()=>{},revealInFinder:async()=>{window.calls.push('reveal')},copyText:async text=>{window.calls.push('copy')},projectRegistry:{}};
function Fixture({config}){const[collapsed,setCollapsed]=React.useState(false);const navigation=useResponsiveSidebar(collapsed,()=>setCollapsed(value=>!value));const trigger=React.useRef(null);const[groups,setGroups]=React.useState(new Set());const[active,setActive]=React.useState('s0');
const title=config.language==='zh'?'这是一个非常长的中文会话标题用于确认选中运行状态与完整名称可读取':'A very long English conversation title to confirm selected running unread status remains available';
const all=Array.from({length:config.count??80},(_,index)=>({id:'s'+index,title:title+' '+index,createdAt:Date.now()-index*60000,updatedAt:Date.now()-index*60000,engineSessionId:'engine-'+index,pinned:index===0,source:index===2?'automation':undefined,teamId:index===0?'owned-team':undefined,teamRole:index===0?'lead':undefined}));
const projects=config.empty?[]:[{id:'owned',name:config.language==='zh'?'很长很长的项目名称包含多个工作目录':'A very long owned project with multiple workspace roots',path:'/owned/project',roots:[{id:'root',name:'root',path:'/owned/project',addedAt:0}],primaryRootId:'root',addedAt:0}];
const statuses=Object.fromEntries(all.map((session,index)=>[bucketKey('owned',session.id),['running','asking','unread'][index%3]]));
return <div data-generation={config.id} className='fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground'><header className='h-11 shrink-0 border-b border-border flex items-center gap-2 px-2'><button ref={trigger} aria-label='Toggle navigation' onClick={navigation.toggle}>☰</button><button aria-label='Outside focus'>Outside</button><span>CodeShell</span></header><div className='flex min-h-0 flex-1'><ResponsiveSidebar narrow={navigation.narrow} open={navigation.visible} onClose={navigation.close} onAfterClose={navigation.afterClose} toggleRef={trigger}><Sidebar projects={projects} sessions={config.empty?{}:{owned:{sessions:all,activeSessionId:active}}} activeProjectId='owned' activeSessionId={active} collapsedProjects={groups} sessionStatuses={statuses} petPendingCount={3} petRunningCount={2} petWidgetVisible={false} sessionHistoryLoading={false} hasMoreSessionHistory={!config.empty} viewMode='chat' activeProjectPath='/owned/project'
 onSelectProject={()=>{}} onSelectSession={(project,id)=>navigation.navigate(()=>{setActive(id);window.calls.push(['select',id])})} onToggleProject={id=>setGroups(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next})}
 onAddProject={()=>window.calls.push('add')} onRemoveProject={()=>{}} onPinProject={()=>{}} onRenameProject={()=>{}} onArchiveAllSessions={()=>{}} onNewConversationForProject={()=>window.calls.push('new-project')} onNewConversation={()=>navigation.navigate(()=>window.calls.push('new'))} onOpenSearch={()=>navigation.navigate(()=>window.calls.push('search'))} onNavigate={mode=>navigation.navigate(()=>window.calls.push(mode))} onOpenProjectConfig={()=>{}} onOpenSettingsPage={()=>{}} onOpenPetPage={()=>navigation.navigate(()=>window.calls.push('pet'))} onTogglePetWidget={()=>{}} onLoadMoreSessionHistory={()=>window.calls.push('load')} onRenameSession={()=>{}} onPinSession={()=>{}} onArchiveSession={()=>{}} onDeleteSession={()=>{}}/></ResponsiveSidebar><div className='flex-1 min-w-0'>Owned workspace</div></div></div>;
}
window.mountFixture=config=>{saveUILanguage(config.language);saveTheme(config.theme);applyTheme(config.theme);const id=++generation;root.render(<I18nProvider key={id}><ToastProvider><DialogProvider><Fixture config={{...config,id}}/></DialogProvider></ToastProvider></I18nProvider>);return id;};`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "dataurl", ".webp": "dataurl", ".wav": "empty" },
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
let context;
if (electronZoom) {
  const main = path.join(output, "owned-electron.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(output, "user-data"))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:1280,height:720,useContentSize:true,
frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.loadURL('about:blank');});`,
  );
  browser = await _electron.launch({ executablePath: require("electron"), args: [main] });
  context = browser.context();
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
  context = await browser.newContext({
    viewport: { width: 800, height: 360 },
    serviceWorkers: "block",
  });
}
const errors = [],
  blocked = [],
  reports = [];
await context.route("**/*", (route) => {
  if (route.request().url() === "http://sidebar-owned.test/")
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>',
    });
  blocked.push(route.request().url());
  return route.abort();
});
const page = electronZoom ? await browser.firstWindow() : await context.newPage();
page.setDefaultTimeout(4000);
page.on("pageerror", (error) => errors.push(error.message));
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function mount(config) {
  const id = await page.evaluate((config) => window.mountFixture(config), config);
  await page.locator('[data-generation="' + id + '"]').waitFor();
  await frames();
  if (await page.evaluate(() => innerWidth < 640)) {
    await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    await page.locator("aside").waitFor();
    await frames();
  }
}
const setViewport = async ({ width, height }) => {
  if (electronZoom) {
    await browser.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size.width * 2, size.height * 2),
      { width, height },
    );
    await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
      width,
      height,
    });
  } else await page.setViewportSize({ width, height });
};
const viewport = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
const assertUsable = async (locator) => {
  const value = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const center = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const clips = [];
    const hiddenScrolls = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        clips.push({ top: bounds.top, bottom: bounds.bottom, overflow: style.overflowY });
      }
      if (/(hidden|clip)/.test(style.overflowY) && parent.scrollTop !== 0) {
        hiddenScrolls.push({ tag: parent.tagName, scrollTop: parent.scrollTop });
      }
    }
    return {
      tag: node.tagName,
      label: node.getAttribute("aria-label") || node.textContent.trim(),
      box: box.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
      hit: Boolean(center && node.contains(center)),
      clips,
      hiddenScrolls,
    };
  });
  assert.ok(value.box.width > 0 && value.box.height > 0, JSON.stringify(value));
  assert.ok(
    value.box.top >= -1 && value.box.bottom <= value.viewport.height + 1,
    JSON.stringify(value),
  );
  assert.ok(
    value.box.left >= -1 && value.box.right <= value.viewport.width + 1,
    JSON.stringify(value),
  );
  for (const clip of value.clips) {
    assert.ok(
      value.box.top >= clip.top - 1 && value.box.bottom <= clip.bottom + 1,
      JSON.stringify(value),
    );
  }
  assert.equal(value.hit, true, JSON.stringify(value));
  assert.deepEqual(
    value.hiddenScrolls,
    [],
    "Clipped ancestors must never be scrolled to make a test pass",
  );
  return value;
};
const focusCycle = async () => {
  const narrow = await page.evaluate(() => innerWidth < 640);
  const first = narrow
    ? page.locator("#codeshell-sidebar-navigation button").first()
    : page.getByRole("button", { name: "Toggle navigation", exact: true });
  await first.focus();
  await frames();
  await page.evaluate(() => {
    window.ownedFocusSeen = new Set([document.activeElement]);
  });
  const stops = [await assertUsable(first)];
  for (let count = 0; count < 100; count++) {
    await page.keyboard.press("Tab");
    await frames();
    const focused = page.locator(":focus");
    stops.push(await assertUsable(focused));
    if (["Sign in to CodeShell", "登录账号"].includes(stops.at(-1).label)) return stops;
    const repeated = await page.evaluate(() => {
      const node = document.activeElement;
      const seen = window.ownedFocusSeen.has(node);
      window.ownedFocusSeen.add(node);
      return seen;
    });
    if (repeated) return stops;
  }
  assert.fail("Sidebar keyboard focus must complete its finite cycle");
};
const scroller = () => page.locator('aside [role="region"]');
const project = () =>
  page.locator("aside button[aria-expanded]").filter({ hasText: /owned project|项目名称/ });
const account = () =>
  page.locator("aside").getByRole("button", { name: /Sign in to CodeShell|登录账号/, exact: true });
const session = (index) =>
  page
    .locator("aside li > button:has(span.truncate)")
    .filter({ hasText: new RegExp(" " + index + "$") });
const wheelToEnd = async () => {
  const box = await scroller().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 20000);
  await page.waitForFunction(() => {
    const node = document.querySelector('aside [role="region"]');
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
  });
  await page.mouse.move((await viewport()).width - 3, 3);
  await frames();
};
try {
  await page.goto("http://sidebar-owned.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  if (electronZoom) {
    await browser.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
    );
    assert.equal(
      await browser.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      ),
      2,
    );
  }
  const sizes = electronZoom
    ? [
        [640, 360],
        [640, 240],
        [390, 360],
        [320, 240],
      ]
    : [
        [800, 360],
        [1280, 720],
        [800, 240],
        [390, 360],
        [320, 240],
      ];
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const [width, height] of sizes) {
        await setViewport({ width, height });
        await mount({ language, theme });
        const footerBefore = await account().boundingBox();
        const stops = await focusCycle();
        assert.ok(stops.some((stop) => stop.label === (language === "zh" ? "搜索" : "Search")));
        assert.ok(
          stops.some((stop) =>
            stop.label.includes(language === "zh" ? "会话标题" : "conversation title"),
          ),
        );
        assert.ok(
          stops.some((stop) =>
            stop.label.includes(language === "zh" ? "历史 Session" : "session history"),
          ),
        );
        assert.ok(
          stops.some((stop) => stop.label.includes(language === "zh" ? "登录账号" : "Sign in")),
        );
        await wheelToEnd();
        assert.ok(
          await scroller().evaluate(
            (node) => node.scrollHeight <= node.clientHeight + 1 || node.scrollTop > 0,
          ),
        );
        assert.deepEqual(await account().boundingBox(), footerBefore);
        await assertUsable(account());
        await page.screenshot({
          path: path.join(output, `sidebar-${language}-${theme}-${width}x${height}.png`),
        });
        reports.push({
          kind: "layout",
          language,
          theme,
          width,
          height,
          stops: stops.length,
          footerBefore,
        });
      }
  if (!electronZoom) {
    for (const language of ["zh", "en"]) {
      await setViewport({ width: 320, height: 240 });
      await mount({ language, theme: "dark", empty: true });
      const stops = await focusCycle();
      assert.ok(
        stops.some(
          (stop) => stop.label === (language === "zh" ? "直接新建对话" : "Start without a project"),
        ),
      );
      reports.push({ kind: "empty-keyboard", language, stops: stops.length });
    }
    await setViewport({ width: 800, height: 600 });
    await mount({ language: "en", theme: "light" });
    const active = page.locator('aside li > button:has(span.truncate)[aria-current="page"]');
    await active.focus();
    await frames();
    await assertUsable(active);
    const title = await active.locator("span.truncate").innerText();
    assert.ok((await active.ariaSnapshot()).includes(title));
    for (let index = 0; index < 3; index++) {
      const row = session(index);
      await row.focus();
      await frames();
      await assertUsable(row);
      const indicator = row.locator("[aria-label]").last();
      const box = await indicator.boundingBox();
      assert.ok(box.width > 0 && box.height > 0);
      assert.match(await indicator.getAttribute("aria-label"), /running|Awaiting input|Unread/i);
    }
    await active.focus();
    await setViewport({ width: 800, height: 240 });
    await frames();
    await frames();
    assert.equal(await active.evaluate((node) => node === document.activeElement), true);
    reports.push({ kind: "resize-preserves-focused-session", focused: await assertUsable(active) });
    const outside = page.getByRole("button", { name: "Outside focus", exact: true });
    await outside.focus();
    await setViewport({ width: 800, height: 360 });
    await frames();
    assert.equal(await outside.evaluate((node) => node === document.activeElement), true);
    reports.push({ kind: "resize-preserves-outside-focus" });
    await setViewport({ width: 800, height: 360 });
    await mount({ language: "en", theme: "dark", count: 1000 });
    assert.equal(await page.locator("aside li > button:has(span.truncate)").count(), 5);
    await wheelToEnd();
    let more = page.locator("aside").getByRole("button", { name: /^Show more/ });
    await assertUsable(more);
    await more.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelectorAll("aside li > button:has(span.truncate)").length === 60,
    );
    await wheelToEnd();
    more = page.locator("aside").getByRole("button", { name: /^Show more/ });
    await assertUsable(more);
    await more.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () => document.querySelectorAll("aside li > button:has(span.truncate)").length === 120,
    );
    await project().focus();
    await frames();
    await assertUsable(project());
    assert.equal(await project().getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Enter");
    assert.equal(await project().getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("aside li > button:has(span.truncate)").count(), 0);
    assert.match(await project().ariaSnapshot(), /A very long owned project/);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("aside li > button:has(span.truncate)").count(), 5);
    reports.push({ kind: "thousand-session-pagination-collapse", pages: [5, 60, 120, 0, 5] });
    for (const width of [800, 390]) {
      await setViewport({ width, height: 600 });
      await mount({ language: "en", theme: "light" });
      const opener = page
        .locator("aside")
        .getByRole("button", { name: "More", exact: true })
        .first();
      await opener.focus();
      await frames();
      await assertUsable(opener);
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu").filter({ hasText: "Edit project folders" });
      await menu.waitFor();
      await page.keyboard.press("End");
      await frames();
      await assertUsable(menu.getByRole("menuitem").last());
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await frames();
      assert.equal(await opener.evaluate((node) => node === document.activeElement), true);
      await assertUsable(opener);
      const accountOpener = account();
      await accountOpener.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await frames();
      assert.equal(await accountOpener.evaluate((node) => node === document.activeElement), true);
      await assertUsable(accountOpener);
      if (width < 640) {
        await page.keyboard.press("Escape");
        await page.locator("aside").waitFor({ state: "hidden" });
        await frames();
        await frames();
        assert.equal(
          await page
            .getByRole("button", { name: "Toggle navigation", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
      }
      reports.push({ kind: "menus-return-focus", width });
    }
  } else {
    await setViewport({ width: 640, height: 360 });
    await mount({ language: "en", theme: "light" });
    const focused = page.locator('aside li > button[aria-current="page"]');
    await focused.focus();
    await frames();
    await assertUsable(focused);
    await setViewport({ width: 640, height: 240 });
    await frames();
    await frames();
    assert.equal(await focused.evaluate((node) => node === document.activeElement), true);
    reports.push({
      kind: "native-200-percent-resize",
      focused: await assertUsable(focused),
      zoom: await browser.evaluate(({ BrowserWindow }) => ({
        factor: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
        bounds: BrowserWindow.getAllWindows()[0].getContentBounds(),
      })),
      viewport: await viewport(),
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify(
      {
        output,
        desktop,
        layouts: reports.filter((report) => report.kind === "layout").length,
        cases: reports.filter((report) => report.kind !== "layout"),
        errors,
        blocked,
      },
      null,
      2,
    ),
  );
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        desktop,
        runtime: electronZoom ? "electron-native-200-percent" : "chrome",
        reports,
        errors,
        blocked,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
