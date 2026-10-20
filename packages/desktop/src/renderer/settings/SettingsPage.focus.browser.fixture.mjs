/* Real-browser layout/navigation regression; bundles production SettingsPage and CSS in memory. */
/* global window, document, Event, CompositionEvent, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, _electron } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {flushSync} from 'react-dom';
  import {SettingsPage} from './settings/SettingsPage';
  import {I18nProvider} from './i18n/I18nProvider';
  import {DialogProvider} from './ui/DialogProvider';
  import {ToastProvider} from './ui/ToastProvider';
  import {saveUILanguage} from './uiLanguage';
  const root=createRoot(document.getElementById('root'));
  let generation=0;
  const settings={permissionMode:'default',modelConnections:[],credentials:[],defaults:{}};
  const nativeResizeObserver=window.ResizeObserver;
  window.fixture={unsafeCalls:0,holdResize:false,resizeCallbacks:[],
    flushResize(){const callbacks=this.resizeCallbacks.splice(0);this.holdResize=false;callbacks.forEach(callback=>callback());}};
  window.ResizeObserver=class extends nativeResizeObserver {
    constructor(callback){super((entries,observer)=>{
      if(window.fixture.holdResize)window.fixture.resizeCallbacks.push(()=>callback(entries,observer));
      else callback(entries,observer);
    });}
  };
  const unsafe=async()=>{window.fixture.unsafeCalls++;throw new Error('Unexpected native action');};
  window.codeshell={
    getSettings:async()=>structuredClone(settings),getConfigurationSettings:async()=>structuredClone(settings),
    getModelCatalog:async()=>[],getCatalogOrigins:async()=>({}),
    getUpdaterStatus:async()=>({kind:'idle'}),onUpdaterStatus:()=>()=>{},getAppVersion:async()=>'fixture',
    setSettings:unsafe,updateSettings:unsafe,restart:unsafe,
  };
  window.renderFixture=lang=>{
    localStorage.clear();saveUILanguage(lang);
    flushSync(()=>root.render(<React.StrictMode><I18nProvider key={++generation}><DialogProvider><ToastProvider>
      <SettingsPage activeProjectPath={null} projects={[]} sessionIndices={{}}
        onRestoreArchivedSession={()=>{}} onDeleteArchivedSession={()=>{}}
        isMac={false} isFullscreen={false} onBack={()=>{}}/>
    </ToastProvider></DialogProvider></I18nProvider></React.StrictMode>));
  };
  window.unmountFixture=()=>flushSync(()=>root.render(null));
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  // Unopened appearance/Markdown modules import media; their assets are irrelevant here.
  loader: { ".png": "empty", ".wav": "empty", ".css": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.argv.includes("--production") ? "production" : "development",
    ),
  },
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
  '<div id="root"></div><input aria-label="Outside input" style="position:fixed;bottom:0;right:0;width:80px;z-index:200"><div id="outside" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:200"></div>';
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const focused = (locator) => locator.evaluate((node) => node === document.activeElement);
const selection = (locator) =>
  locator.evaluate((node) => [node.selectionStart, node.selectionEnd, node.selectionDirection]);
const visibleSearch = (page) => page.getByRole("searchbox").filter({ visible: true });
const visibleNavigation = (page, label) =>
  page.getByRole("navigation", { name: label, exact: true }).filter({ visible: true });
const labels = (lang) =>
  lang === "zh"
    ? {
        general: "常规",
        shortcuts: "键盘快捷键",
        navigation: "设置导航",
        clear: "清除搜索",
        back: "返回应用",
      }
    : {
        general: "General",
        shortcuts: "Keyboard shortcuts",
        navigation: "Settings navigation",
        clear: "Clear search",
        back: "Back to app",
      };
async function render(page, lang) {
  await page.evaluate((lang) => window.renderFixture(lang), lang);
  await page.getByRole("heading", { level: 1, name: labels(lang).general, exact: true }).waitFor();
  await page.getByText("fixture", { exact: true }).waitFor();
}
async function clearAndChoose(page, lang, width) {
  const text = labels(lang);
  const search = visibleSearch(page);
  await search.fill("zzzz-no-matching-settings");
  const clear = visibleNavigation(page, text.navigation)
    .getByRole("button", { name: text.clear, exact: true })
    .filter({ hasText: text.clear });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await focused(clear), true, "Keyboard reaches the empty-state action");
  await page.keyboard.press("Enter");
  await settle(page);
  assert.equal(
    await focused(search),
    true,
    "Empty-state clear returns focus to the visible search",
  );
  assert.equal(await search.inputValue(), "");
  await page.keyboard.insertText("zzzz-no-matching-settings");
  await clear.click();
  assert.equal(await focused(search), true, "Pointer clear also resumes search");
  for (const choice of [text.general, text.shortcuts]) {
    await search.fill(choice);
    const result = visibleNavigation(page, text.navigation).getByRole("button", {
      name: choice,
      exact: true,
    });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await focused(result), true, "Search results are reachable by Tab");
    await page.keyboard.press("Enter");
    const heading = page.getByRole("heading", { level: 1, name: choice, exact: true });
    await heading.waitFor();
    await settle(page);
    assert.equal(
      await focused(width <= 720 ? heading : result),
      true,
      "Narrow results hand off to the mounted heading; wide navigation keeps its position",
    );
  }
}
async function responsiveFocus(page, lang) {
  const text = labels(lang);
  await render(page, lang);
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  const value = "fixture 中文 search long text";
  await visibleSearch(page).fill(value);
  await visibleSearch(page).evaluate((node) => node.setSelectionRange(3, 13, "backward"));
  for (const width of [390, 1000, 390, 1000]) {
    await page.setViewportSize({ width, height: 500 });
    await settle(page);
    const search = visibleSearch(page);
    assert.equal(await focused(search), true, `Search focus survives layout switch to ${width}`);
    assert.equal(await search.inputValue(), value);
    assert.deepEqual(await selection(search), [3, 13, "backward"]);
  }
  for (const width of [390, 1000, 390, 1000]) {
    await page.setViewportSize({ width, height: 500 });
  }
  await settle(page);
  assert.equal(
    await focused(visibleSearch(page)),
    true,
    "Rapid layout switches use the final layout",
  );
  assert.deepEqual(await selection(visibleSearch(page)), [3, 13, "backward"]);
  await page.keyboard.insertText("new");
  assert.equal(
    await visibleSearch(page).inputValue(),
    value.slice(0, 3) + "new" + value.slice(13),
    "Typing continues at the preserved selection",
  );
  await visibleSearch(page).fill("");
  await page
    .getByRole("navigation", { name: text.navigation, exact: true })
    .getByRole("button", { name: text.general, exact: true })
    .focus();
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  assert.equal(
    await focused(page.getByRole("combobox", { name: text.navigation, exact: true })),
    true,
    "Wide module focus moves to the narrow module picker",
  );
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  assert.equal(
    await focused(
      page
        .getByRole("navigation", { name: text.navigation, exact: true })
        .getByRole("button", { name: text.general, exact: true }),
    ),
    true,
    "Narrow picker focus moves to the selected wide module",
  );
  await page
    .getByRole("button", { name: text.back, exact: true })
    .filter({ visible: true })
    .focus();
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  assert.equal(
    await focused(
      page.getByRole("button", { name: text.back, exact: true }).filter({ visible: true }),
    ),
    true,
    "Back button has a visible equivalent",
  );
  await page.locator('[data-notification-action="open"]').filter({ visible: true }).focus();
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  assert.equal(
    await focused(page.locator('[data-notification-action="open"]').filter({ visible: true })),
    true,
    "Notification trigger has a visible equivalent",
  );
}
async function guards(page, lang) {
  await render(page, lang);
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  const contentButton = page.locator("main button").first();
  await contentButton.focus();
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  assert.equal(await focused(contentButton), true, "Resize preserves content focus");
  const outside = page.getByRole("textbox", { name: "Outside input" });
  await outside.focus();
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  assert.equal(await focused(outside), true, "Resize preserves external input focus");
  await visibleSearch(page).focus();
  await page.locator("#outside").click();
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  assert.equal(
    await page.evaluate(() => document.activeElement === document.body),
    true,
    "A nonfocusable outside pointer cancels remembered navigation focus",
  );
  await visibleSearch(page).focus();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  assert.equal(
    await page.evaluate(() => document.activeElement === document.body),
    true,
    "Inactive-window resize does not restore stale navigation focus",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator('[data-notification-action="open"]').filter({ visible: true }).click();
  const portal = page.getByRole("dialog");
  await portal.waitFor();
  const portalButton = portal.getByRole("button").filter({ visible: true }).last();
  await portalButton.focus();
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  assert.equal(
    await focused(portalButton),
    true,
    "Resize preserves focus inside the notification portal",
  );
  await page.keyboard.press("Escape");
  await portal.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(page.locator('[data-notification-action="open"]').filter({ visible: true })),
    true,
    "Closing the owned portal returns to the visible notification trigger",
  );
  await page.getByRole("combobox", { name: labels(lang).navigation, exact: true }).click();
  await page.getByRole("listbox").waitFor();
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(
      visibleNavigation(page, labels(lang).navigation).getByRole("button", {
        name: labels(lang).general,
        exact: true,
      }),
    ),
    true,
    "The picker auto-close on resize restores the selected wide module",
  );
  await page.locator('[data-notification-action="open"]').filter({ visible: true }).click();
  await portal.waitFor();
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  await page.locator("#outside").click();
  await portal.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await page.evaluate(() => document.activeElement === document.body),
    true,
    "Outside pointer dismissal cancels portal return focus even after a layout switch",
  );
  await page.locator('[data-notification-action="open"]').filter({ visible: true }).click();
  await portal.waitFor();
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  await outside.focus();
  await portal.waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(await focused(outside), true, "Portal close cannot steal newer external focus");
  await page.keyboard.press("ControlOrMeta+f");
  assert.equal(
    await focused(visibleSearch(page)),
    true,
    "Search shortcut continues to use the visible layout",
  );
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  const picker = page.getByRole("combobox", { name: labels(lang).navigation, exact: true });
  await picker.focus();
  await page.keyboard.press("Space");
  await page.getByRole("listbox").waitFor();
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  await settle(page);
  assert.equal(
    await focused(
      visibleNavigation(page, labels(lang).navigation).getByRole("button", {
        name: labels(lang).general,
        exact: true,
      }),
    ),
    true,
    "Keyboard-opened picker also returns to the selected wide module",
  );
}
async function compositionAndCleanup(page, lang) {
  await render(page, lang);
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  await visibleSearch(page).fill("中文 input");
  const previous = visibleSearch(page);
  await previous.evaluate((node) => {
    node.setSelectionRange(0, 2);
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中文" }));
  });
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  assert.equal(
    await focused(visibleSearch(page)),
    false,
    "Do not interrupt an active composition to transfer search focus",
  );
  await page
    .getByRole("searchbox", { includeHidden: true })
    .first()
    .evaluate((node) =>
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" })),
    );
  await settle(page);
  assert.equal(
    await focused(visibleSearch(page)),
    true,
    "Composition completion rechecks and restores the visible search",
  );
  assert.equal(await visibleSearch(page).inputValue(), "中文 input");
  assert.deepEqual((await selection(visibleSearch(page))).slice(0, 2), [0, 2]);
  await visibleSearch(page).evaluate((node) => {
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  await page.evaluate(() => {
    document
      .querySelectorAll('input[type="search"]')[1]
      .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    document.querySelector('[aria-label="Outside input"]').focus();
  });
  await settle(page);
  const outside = page.getByRole("textbox", { name: "Outside input" });
  assert.equal(
    await focused(outside),
    true,
    "Composition completion cannot steal newer external focus",
  );
  await visibleSearch(page).focus();
  await visibleSearch(page).evaluate((node) => {
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  await page.evaluate(() => {
    document
      .querySelector('input[type="search"]')
      .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    window.unmountFixture();
    document.querySelector('[aria-label="Outside input"]').focus();
  });
  await settle(page);
  assert.equal(await focused(outside), true, "Queued composition handoff cannot run after unmount");
  await render(page, lang);
  await visibleSearch(page).focus();
  // Hold real observer deliveries so stale callbacks can be exercised after cleanup.
  await page.evaluate(() => (window.fixture.holdResize = true));
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  await page.waitForFunction(() => window.fixture.resizeCallbacks.length > 0);
  await page.evaluate(() => window.unmountFixture());
  await outside.focus();
  await page.evaluate(() => window.fixture.flushResize());
  await settle(page);
  assert.equal(
    await focused(outside),
    true,
    "Disconnected observers cannot transfer focus after unmount",
  );
  await render(page, lang);
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page);
  await visibleSearch(page).fill("remount");
  await page.setViewportSize({ width: 1000, height: 500 });
  await settle(page);
  assert.equal(
    await focused(visibleSearch(page)),
    true,
    "StrictMode remount installs only live focus handling",
  );
}
async function inject(page) {
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}
if (!process.argv.includes("--electron-zoom")) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
  });
  try {
    for (const width of [1000, 390])
      for (const lang of ["zh", "en"])
        for (const scheme of ["light", "dark"]) {
          const page = await browser.newPage({
            viewport: { width, height: 500 },
            colorScheme: scheme,
          });
          page.setDefaultTimeout(5000);
          const errors = [],
            blocked = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/*", (route) => {
            if (route.request().url() === "http://settings.test/")
              return route.fulfill({ contentType: "text/html", body: html });
            blocked.push(route.request().url());
            return route.abort();
          });
          await page.goto("http://settings.test/");
          await inject(page);
          await page.evaluate(
            (scheme) => document.documentElement.classList.toggle("dark", scheme === "dark"),
            scheme,
          );
          await render(page, lang);
          await clearAndChoose(page, lang, width);
          await responsiveFocus(page, lang);
          await guards(page, lang);
          await compositionAndCleanup(page, lang);
          assert.equal(await page.evaluate(() => window.fixture.unsafeCalls), 0);
          assert.deepEqual(errors, []);
          assert.deepEqual(blocked, []);
          console.log(
            `PASS ${width}/${lang}/${scheme}: clear, choice, resize, focus guards, synthetic composition, StrictMode cleanup`,
          );
          await page.close();
        }
  } finally {
    await browser.close();
  }
} else {
  const { createServer } = await import("node:http");
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR || "/tmp", "codeshell-settings-focus-"),
  );
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(request.url === "/" ? html : "");
  });
  let app;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const entry = path.join(directory, "main.cjs");
    await writeFile(
      entry,
      `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',process.env.FIXTURE_USER_DATA);app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(details,callback)=>callback({cancel:new URL(details.url).origin!==process.env.FIXTURE_ORIGIN}));const window=new BrowserWindow({width:1000,height:600,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});window.loadURL(process.env.FIXTURE_ORIGIN);});`,
    );
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      timeout: 15000,
      env: {
        ...process.env,
        FIXTURE_ORIGIN: origin,
        FIXTURE_USER_DATA: path.join(directory, "user-data"),
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForLoadState("domcontentloaded");
    await inject(page);
    for (const lang of ["zh", "en"]) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
      );
      await render(page, lang);
      await visibleSearch(page).fill("fixture 中文 zoom");
      await visibleSearch(page).evaluate((node) => node.setSelectionRange(2, 9, "backward"));
      for (const zoom of [2, 1, 2]) {
        await app.evaluate(
          ({ BrowserWindow }, zoom) =>
            BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
          zoom,
        );
        await settle(page);
        assert.equal(
          await focused(visibleSearch(page)),
          true,
          `Native Electron zoom ${zoom} preserves search focus`,
        );
        assert.deepEqual(await selection(visibleSearch(page)), [2, 9, "backward"]);
      }
      await clearAndChoose(page, lang, 500);
      const notification = page
        .locator('[data-notification-action="open"]')
        .filter({ visible: true });
      await notification.click();
      const portal = page.getByRole("dialog");
      await portal.waitFor();
      const portalButton = portal.getByRole("button").filter({ visible: true }).last();
      await portalButton.focus();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
      );
      await settle(page);
      assert.equal(await focused(portalButton), true, "Native zoom preserves open portal focus");
      await page.keyboard.press("Escape");
      await portal.waitFor({ state: "hidden" });
      await settle(page);
      assert.equal(
        await focused(notification),
        true,
        "Native zoom portal close finds its visible trigger",
      );
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
      );
      await settle(page);
      await page.getByRole("combobox", { name: labels(lang).navigation, exact: true }).click();
      await page.getByRole("listbox").waitFor();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
      );
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await settle(page);
      const selectedModule = visibleNavigation(page, labels(lang).navigation).getByRole("button", {
        name: labels(lang).shortcuts,
        exact: true,
      });
      assert.equal(
        await focused(selectedModule),
        true,
        "Native zoom picker auto-close returns to the selected module",
      );
      const inScroller = await selectedModule.evaluate((node) => {
        const bounds = node.parentElement.parentElement.getBoundingClientRect();
        const target = node.getBoundingClientRect();
        return target.top >= bounds.top && target.bottom <= bounds.bottom;
      });
      assert.equal(inScroller, true, "Restored module is visible in the navigation scroller");
      assert.equal(await page.evaluate(() => window.fixture.unsafeCalls), 0);
      console.log(
        `PASS Electron/${lang}: native 100%↔200%, selection, clear, narrow choice, portal Escape and picker auto-close`,
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await new Promise((resolve) => server.close(resolve));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
