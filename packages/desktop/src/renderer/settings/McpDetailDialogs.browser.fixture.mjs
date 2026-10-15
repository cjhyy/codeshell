/** Production Settings → MCP details: owned bridge, no services, credentials or network.
 * node McpDetailDialogs.browser.fixture.mjs [--source-desktop /path/to/packages/desktop] [--electron]
 */
/* global document, window, Event, getComputedStyle, requestAnimationFrame, innerWidth, innerHeight */
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
  process.env.CODESHELL_MCP_DETAILS_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-mcp-details-")));
await mkdir(output, { recursive: true });
const source = `
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{SettingsPage}from'./settings/SettingsPage';import{I18nProvider}from'./i18n/I18nProvider';import{DialogProvider}from'./ui/DialogProvider';import{ToastProvider}from'./ui/ToastProvider';import{saveUILanguage}from'./uiLanguage';import{applyTheme,saveTheme}from'./theme';
const root=createRoot(document.getElementById('root'));let generation=0;const clone=value=>structuredClone(value);
window.mountFixture=({language,theme="light",longNames=true,empty=false})=>{
 localStorage.clear();saveUILanguage(language);saveTheme(theme);applyTheme(theme);const suffix=longNames?'_workspace_resource'.repeat(12):'';const toolsName='owned-tools'+suffix,errorName='owned-error'+suffix;
 const servers={[toolsName]:{command:'owned-not-executed',args:[],source:'settings',editable:true},[errorName]:{command:'owned-not-executed',args:[],source:'settings',editable:true}};
 const settings={permissionMode:'default',modelConnections:[],credentials:[],defaults:{},mcpServers:servers};window.calls={reads:[],merged:[],probes:[],unsafe:[]};
 const unsafe=method=>async()=>{window.calls.unsafe.push(method);throw new Error('Forbidden owned bridge mutation: '+method)};
 window.codeshell={getSettings:async scope=>{window.calls.reads.push(scope);return clone(settings)},getConfigurationSettings:async()=>clone(settings),getModelCatalog:async()=>[],getCatalogOrigins:async()=>({}),getUpdaterStatus:async()=>({kind:'idle'}),onUpdaterStatus:()=>()=>{},getAppVersion:async()=>'0.9.43-owned',
 listMergedMcpServers:async(...args)=>{window.calls.merged.push(args);return clone(servers)},listPluginMcpTrust:async()=>[],probeMcpServers:async(inputs,force)=>{window.calls.probes.push({inputs,force});return inputs.map(({name})=>name===toolsName?{name,status:'ok',toolCount:empty?0:30,tools:Array.from({length:empty?0:30},(_,index)=>({name:'mcp__owned_resource_'+'long_tool_name_'.repeat(15)+index,description:'Owned description '+('https://owned.invalid/resource_segment_').repeat(12)}))}:{name,status:'error',errorMessage:'Owned MCP failure '+'error_context_'.repeat(40),errorDetail:Array.from({length:80},(_,index)=>'Owned raw diagnostic '+index+' '+ 'unbroken_trace_segment_'.repeat(15)).join(String.fromCharCode(10))})},
 updateSettings:unsafe('updateSettings'),setSettings:unsafe('setSettings'),updateConfigurationSettings:unsafe('updateConfigurationSettings'),approvePluginMcp:unsafe('approvePluginMcp'),revokePluginMcp:unsafe('revokePluginMcp'),openExternal:unsafe('openExternal'),credentials:{list:unsafe('credentials.list')},log:()=>{}};
 const id=++generation;flushSync(()=>root.render(<I18nProvider key={id}><DialogProvider><ToastProvider><div data-generation={id} style={{position:'fixed',inset:0,overflow:'hidden'}}><SettingsPage activeProjectPath={null} projects={[]} sessionIndices={{}} onRestoreArchivedSession={()=>{}} onDeleteArchivedSession={()=>{}} isMac={false} isFullscreen={false} onBack={()=>{}}/></div></ToastProvider></DialogProvider></I18nProvider>));return id;
};window.unmountFixture=()=>flushSync(()=>root.render(null));`;

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
const labels = (language) =>
  language === "zh"
    ? {
        mcp: "MCP 服务器",
        close: "关闭",
        detail: "查看详情",
        general: "常规",
        empty: "服务器未返回任何 tool",
      }
    : {
        mcp: "MCP servers",
        close: "Close",
        detail: "View details",
        general: "General",
        empty: "Server returned no tools",
      };

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
  assert.fail("The MCP detail opener must be reachable through native Tab navigation");
}
async function mount(page, config) {
  const id = await page.evaluate((config) => window.mountFixture(config), config);
  await page.locator(`[data-generation="${id}"]`).waitFor();
  await page.getByText("0.9.43-owned", { exact: true }).waitFor();
  const search = page.getByRole("searchbox").filter({ visible: true });
  await search.fill("MCP");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const text = labels(config.language);
  const module = page
    .getByRole("button", { name: text.mcp, exact: true })
    .filter({ visible: true });
  assert.equal(await focused(module), true);
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: text.mcp, exact: true, level: 1 }).waitFor();
  await page
    .getByRole("button", { name: config.empty ? "0 tools" : "30 tools", exact: true })
    .waitFor();
  await settle(page);
}
async function inspect(page, config, surface, phase) {
  const value = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const title = dialog?.querySelector("h2"),
      close = dialog?.querySelector("button");
    const region = dialog?.querySelector('[role="region"]'),
      raw = dialog?.querySelector("pre");
    const nodes = dialog ? [...dialog.querySelectorAll("*"), dialog] : [];
    for (let node = dialog?.parentElement; node; node = node.parentElement) nodes.push(node);
    const geometry = (node) =>
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
    return {
      width: innerWidth,
      height: innerHeight,
      dialog: geometry(dialog),
      title: geometry(title),
      close: geometry(close),
      region: geometry(region),
      raw: geometry(raw),
      tools: dialog?.querySelectorAll("li").length ?? 0,
      activeInside: !!dialog?.contains(document.activeElement),
      hiddenScroll: nodes
        .filter((node) => {
          const style = getComputedStyle(node);
          return (
            (/hidden|clip/.test(style.overflowY) && node.scrollTop !== 0) ||
            (/hidden|clip/.test(style.overflowX) && node.scrollLeft !== 0)
          );
        })
        .map((node) => ({ tag: node.tagName, top: node.scrollTop, left: node.scrollLeft })),
    };
  });
  reports.push({ ...config, surface, phase, ...value });
  assert.equal(value.width, config.width);
  assert.equal(value.height, config.height);
  assert.deepEqual(
    value.hiddenScroll,
    [],
    "No hidden/clip ancestor can be programmatically scrolled to pass",
  );
  assert.ok(
    value.dialog &&
      value.dialog.x >= 0 &&
      value.dialog.right <= config.width + 1 &&
      value.dialog.y >= 0 &&
      value.dialog.bottom <= config.height + 1,
  );
  assert.equal(
    value.dialog.scrollWidth <= value.dialog.clientWidth + 1,
    true,
    "Dialog content cannot widen its shell",
  );
  assert.equal(
    value.region.scrollWidth <= value.region.clientWidth + 1,
    true,
    "Only the raw diagnostic may scroll horizontally",
  );
  assert.equal(value.activeInside, true);
  return value;
}
async function resizeNative(width, height) {
  await browser.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(size.width, size.height);
      win.show();
      win.focus();
    },
    { width, height },
  );
  const page = await browser.firstWindow();
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
    width,
    height,
  });
}
async function resizeOpenDetails(page, config) {
  const opener = page.getByRole("button", { name: "30 tools", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.evaluate((node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
    ),
  );
  const close = dialog.getByRole("button", { name: labels(config.language).close, exact: true });
  for (const [width, height] of [
    [320, 240],
    [390, 360],
    [760, 360],
  ]) {
    await resizeNative(width, height);
    await settle(page);
    await dialog.evaluate((node) =>
      Promise.all(
        node
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    assert.equal(
      await focused(close),
      true,
      "Native live resize preserves the focused close action",
    );
    await inspect(page, { ...config, width, height }, "tools", "native-live-resize");
    await assertReachable(close, "Close remains fully visible after actual native resize");
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "A resized modal still returns to its original opener");
}
async function exercise(page, config, surface) {
  const text = labels(config.language);
  const opener = page.getByRole("button", {
    name: surface === "tools" ? (config.empty ? "0 tools" : "30 tools") : text.detail,
    exact: true,
  });
  await tabTo(page, opener);
  await assertReachable(opener, "Keyboard opener must be visible before opening");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.evaluate((node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
    ),
  );
  const close = dialog.getByRole("button", { name: text.close, exact: true });
  assert.equal(await focused(close), true, "Initial focus is the visible close action");
  await assertReachable(close, "Close remains inside the bounded header");
  assert.ok(
    (await dialog.getAttribute("aria-labelledby")) &&
      (await dialog.getByRole("heading", { level: 2 }).textContent()),
  );
  const opened = await inspect(page, config, surface, "open");
  assert.equal(opened.tools, surface === "tools" && !config.empty ? 30 : 0);
  await page.screenshot({
    path: path.join(
      output,
      `${surface}-open-${config.language}-${config.theme}-${config.width}x${config.height}${config.empty ? "-empty" : ""}.png`,
    ),
  });
  if (config.empty) assert.equal(await dialog.getByRole("region").textContent(), text.empty);
  for (let step = 0; step < 16; step++) {
    await page.keyboard.press(step < 8 ? "Tab" : "Shift+Tab");
    assert.equal(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      true,
      "Tab/Shift+Tab stay in the modal",
    );
  }
  const title = dialog.getByRole("heading", { level: 2 });
  await title.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const node = document.querySelector('[role="dialog"] h2');
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  await settle(page);
  const titleScrolled = await title.evaluate((node) => ({
    top: node.scrollTop,
    height: node.clientHeight,
    total: node.scrollHeight,
  }));
  if (titleScrolled.total > titleScrolled.height + 1)
    assert.ok(titleScrolled.top > 0, "The complete long title is keyboard scrollable");
  await assertReachable(close, "Scrolling the title keeps Close visible");
  const region = dialog.getByRole("region");
  await region.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const node = document.querySelector('[role="dialog"] [role="region"]');
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  await settle(page);
  if (surface === "tools" && !config.empty) {
    assert.deepEqual(
      await dialog.locator("li code").allTextContents(),
      Array.from(
        { length: 30 },
        (_, index) => "mcp__owned_resource_" + "long_tool_name_".repeat(15) + index,
      ),
      "Every complete tool name is retained",
    );
    const end = await region.evaluate((node) => {
      const last = node.querySelector("li:last-child span").lastChild;
      const range = document.createRange();
      range.setStart(last, last.length - 1);
      range.setEnd(last, last.length);
      const box = range.getBoundingClientRect(),
        bounds = node.getBoundingClientRect();
      return {
        top: node.scrollTop,
        box: box.toJSON(),
        bounds: bounds.toJSON(),
        height: node.clientHeight,
        fullHeight: node.scrollHeight,
        visible: box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
      };
    });
    assert.ok(
      end.top > 0 && end.visible,
      `Keyboard End exposes the final tool description: ${JSON.stringify(end)}`,
    );
    await page.keyboard.press("Home");
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"] [role="region"]').scrollTop === 0,
    );
    const bounds = await region.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 180);
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"] [role="region"]').scrollTop > 0,
    );
    await settle(page);
  } else if (surface === "error") {
    const raw = dialog.locator("pre");
    await raw.focus();
    assert.equal(
      await raw.textContent(),
      Array.from(
        { length: 80 },
        (_, index) => "Owned raw diagnostic " + index + " " + "unbroken_trace_segment_".repeat(15),
      ).join("\n"),
      "Raw diagnostic is retained without truncation",
    );
    await page.keyboard.press("End");
    await page.waitForFunction(() => {
      const node = document.querySelector('[role="dialog"] pre');
      return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    });
    await settle(page);
    await assertReachable(raw, "Raw diagnostic viewport is fully reachable");
    const rawBox = await raw.boundingBox();
    await page.mouse.move(rawBox.x + rawBox.width / 2, rawBox.y + rawBox.height / 2);
    await page.mouse.wheel(320, 0);
    await page.waitForFunction(() => document.querySelector('[role="dialog"] pre').scrollLeft > 0);
    await settle(page);
    const rawScrolled = await raw.evaluate((node) => ({
      top: node.scrollTop,
      left: node.scrollLeft,
      height: node.clientHeight,
      total: node.scrollHeight,
      width: node.clientWidth,
      fullWidth: node.scrollWidth,
    }));
    assert.ok(
      rawScrolled.top > 0 && rawScrolled.left > 0,
      `Raw diagnostic scrolls on both axes: ${JSON.stringify(rawScrolled)}`,
    );
  }
  await close.focus();
  await inspect(page, config, surface, "scrolled");
  await assertReachable(close, "Close survives all content scrolling");
  await page.screenshot({
    path: path.join(
      output,
      `${surface}-${config.language}-${config.theme}-${config.width}x${config.height}${config.empty ? "-empty" : ""}.png`,
    ),
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "Escape returns focus to the exact opener");
  await assertReachable(opener, "Restored opener remains reachable");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await close.click();
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(opener), true, "Click Close returns focus to the exact opener");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await dialog.evaluate((node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await settle(page);
  await page.mouse.click(1, 1);
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(opener),
    true,
    "Clicking the overlay returns focus to the exact opener",
  );
}

try {
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"]) {
      for (const [width, height] of [
        [320, 240],
        [390, 360],
        [760, 360],
        [1280, 720],
      ]) {
        const config = { language, theme, width, height };
        // A fresh viewport avoids the observed local Chrome headless viewport-transition wheel failure.
        const context = electronMode
          ? nativeContext
          : await browser.newContext({
              viewport: { width, height },
              serviceWorkers: "block",
            });
        if (!electronMode || reports.length === 0)
          await context.route("**/*", (route) => {
            if (route.request().url() === "http://mcp-owned.test/")
              return route.fulfill({
                contentType: "text/html",
                body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><button id="outside" style="position:fixed;right:0;bottom:0;z-index:200;pointer-events:auto">Outside focus</button>',
              });
            blocked.push(route.request().url());
            return route.abort();
          });
        const page = electronMode ? await browser.firstWindow() : await context.newPage();
        if (electronMode) {
          await resizeNative(width, height);
          if (reports.length === 0) page.on("pageerror", (error) => errors.push(error.message));
        } else page.on("pageerror", (error) => errors.push(error.message));
        lastPage = page;
        page.setDefaultTimeout(5000);
        await page.goto("http://mcp-owned.test/");
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: built.outputFiles[0].text });
        await mount(page, config);
        await exercise(page, config, "tools");
        await exercise(page, config, "error");
        if (electronMode && width === 760) await resizeOpenDetails(page, config);
        if (width === 320 && theme === "light") {
          await mount(page, { ...config, empty: true });
          await exercise(page, { ...config, empty: true }, "tools");
          const opener = page.getByRole("button", { name: "0 tools", exact: true });
          await opener.focus();
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").waitFor();
          await page.evaluate(() => window.dispatchEvent(new Event("blur")));
          await page.keyboard.press("Escape");
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          await settle(page);
          assert.equal(
            await focused(opener),
            false,
            "Window blur relinquishes return-focus ownership even if focus later becomes BODY",
          );
          await opener.focus();
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").waitFor();
          await settle(page);
          await page.locator("#outside").click();
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          await settle(page);
          assert.equal(
            await focused(page.locator("#outside")),
            true,
            "An actual external pointer/focus keeps its own target",
          );
          await opener.focus();
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").waitFor();
          await page.evaluate(() => {
            window.unmountFixture();
            document.querySelector("#outside").focus();
          });
          await settle(page);
          assert.equal(
            await focused(page.locator("#outside")),
            true,
            "Unmounted target cannot steal outside focus",
          );
        }
        const calls = await page.evaluate(() => window.calls);
        assert.deepEqual(calls.unsafe, []);
        assert.ok(calls.merged.length > 0 && calls.probes.length > 0);
        assert.ok(
          calls.probes.every((call) => call.force === false),
          "Only owned initial fake probes were read",
        );
        reports.push({ ...config, bridge: calls });
        if (!electronMode) await context.close();
      }
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
