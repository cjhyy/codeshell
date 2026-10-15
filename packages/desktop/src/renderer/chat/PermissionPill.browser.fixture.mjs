/* Actual ChatView permission picker, production CSS, strict owned bridge and exact-origin guard.
 * --development exercises StrictMode effects; --source-desktop=PATH checks an old implementation.
 * Composition/window blur assertions cover DOM events, not OS IME or screen-reader speech. */
/* global document, window, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, KeyboardEvent, Event */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceDesktop =
  process.argv.find((arg) => arg.startsWith("--source-desktop="))?.slice(17) || desktop;
const renderer = path.join(sourceDesktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium, _electron } = require("playwright");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-permission-picker-"));
await mkdir(output, { recursive: true });
const source = String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ChatView} from './ChatView';import {toCorePermissionMode,toExternalRuntimePermission} from './chat/PermissionPill';
import {I18nProvider} from './i18n/I18nProvider';import {saveUILanguage} from './uiLanguage';import {applyTheme} from './theme';
const noop=()=>{};window.unexpected=[];window.calls=[];window.composers=[];
window.codeshell=new Proxy({sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>noop,
 listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']}),log:noop},
 {get(target,key){if(key in target)return target[key];window.unexpected.push(String(key));throw new Error('Unexpected bridge '+String(key));}});
const models=[{key:'owned',label:'Owned model',provider:'Owned provider'}];
function Composer({index,variant}){
 const [state,patch]=React.useReducer((old,next)=>({...old,...next}),{permission:'default',busy:false,draft:''});
 React.useLayoutEffect(()=>{window.composers[index]=patch;return()=>{delete window.composers[index]}},[index]);
 return <ChatView variant={variant} messages={[]} onSend={noop} onStop={noop} busy={state.busy}
 activeProjectId="project" permissionMode={state.permission} onPermissionChange={mode=>{const core=toCorePermissionMode(mode);
 window.calls.push({index,mode,core,external:toExternalRuntimePermission(core)});patch({permission:mode});window.afterSelection?.()}} goalEnabled={false} onGoalToggle={noop}
 modelOptions={models} activeModelKey="owned" onModelChange={noop}
 contextTokens={0} projects={[]} onSelectProject={noop} onAddProject={noop} configurationTarget={{projectId:'project'}} configurationAvailable
 conversationRoot="/owned" conversationRootId="root" draft={state.draft} onDraftChange={draft=>patch({draft})} attachments={[]} onAttachmentsChange={noop}/>;
}
function Fixture({multiple=false,variant='main'}){return <main className="fixed inset-0 flex min-w-0 overflow-hidden bg-background">
 {Array.from({length:multiple?2:1},(_,index)=><section key={index} data-composer-index={index} className="h-full min-w-0 flex-1 overflow-hidden"><Composer index={index} variant={variant}/></section>)}
 </main>}
const root=createRoot(document.getElementById('root'));let generation=0;
window.renderFixture=props=>{localStorage.clear();saveUILanguage(props.lang);applyTheme(props.theme||'light');window.calls=[];
 flushSync(()=>root.render(<React.StrictMode><I18nProvider key={++generation}><Fixture {...props}/></I18nProvider></React.StrictMode>));};
window.unmountFixture=()=>flushSync(()=>root.render(null));
`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  // Character-theme media imported by applyTheme is not used by this fixture.
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.argv.includes("--development") ? "development" : "production",
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
const native = process.argv.includes("--electron-zoom");
const html =
  '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;overflow:hidden}</style><div id="root"></div><input aria-label="Outside field" style="position:fixed;top:0;right:0;width:60px;z-index:999"><svg id="outside-svg" width="24" height="24" style="position:fixed;bottom:0;left:0;z-index:999"><rect width="24" height="24" fill="black"/></svg>';
let app, server, browser;
let origin = "http://permission-picker-owned.test";
if (native) {
  server = createServer((request, response) => {
    response.writeHead(request.url === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(request.url === "/" ? html : "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const entry = path.join(output, "main.cjs");
  await writeFile(
    entry,
    `const {app,BrowserWindow,session}=require('electron');global.blocked=[];
    app.setPath('userData',process.env.FIXTURE_USER_DATA);
    app.on('window-all-closed',()=>app.quit());
    app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(details,callback)=>{
      const blocked=new URL(details.url).origin!==process.env.FIXTURE_ORIGIN;
      if(blocked)global.blocked.push(details.url);callback({cancel:blocked});});
      const window=new BrowserWindow({width:800,height:480,frame:false,show:false,
        webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
      window.loadURL(process.env.FIXTURE_ORIGIN);});`,
  );
  try {
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      timeout: 15000,
      env: { ...process.env, FIXTURE_ORIGIN: origin, FIXTURE_USER_DATA: path.join(output, "data") },
    });
  } catch (cause) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw cause;
  }
} else
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
  });

const onlyCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const reports = [],
  errors = [],
  blocked = [];
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const active = (page) =>
  page.evaluate(() => ({
    tag: document.activeElement.tagName,
    role: document.activeElement.getAttribute("role"),
    key: document.activeElement.getAttribute("id")?.split("-").at(-1) || null,
    label:
      document.activeElement.getAttribute("aria-label") ||
      document.activeElement.textContent.trim(),
  }));
let currentPage;
try {
  const context = app ? app.context() : await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    if (route.request().url() === origin + "/")
      return route.fulfill({
        contentType: "text/html",
        body: html,
      });
    blocked.push(route.request().url());
    return route.abort();
  });
  const page = app ? await app.firstWindow() : await context.newPage();
  const accessibility = await context.newCDPSession(page);
  await accessibility.send("Accessibility.enable");
  currentPage = page;
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const trigger = (index = 0) =>
    page
      .locator(`[data-composer-index="${index}"]`)
      .getByRole("button", { name: /^Conversation permission:|^当前对话权限：/ });
  const menu = () => page.getByRole("listbox");
  const option = (key) => menu().locator(`[id$="-${key}"]`);
  async function resize(width, height) {
    if (app) {
      await app.evaluate(
        ({ BrowserWindow }, { width, height }) => {
          const window = BrowserWindow.getAllWindows()[0];
          const zoom = width < 500 ? 2 : 1;
          window.webContents.setZoomFactor(zoom);
          window.setContentSize(width * zoom, height * zoom);
        },
        { width, height },
      );
      await page.waitForFunction(
        ({ width, height }) => innerWidth === width && innerHeight === height,
        { width, height },
      );
    } else await page.setViewportSize({ width, height });
    await frames(page);
  }
  async function boot(width = 320, height = 360, lang = "en", extra = {}) {
    await resize(width, height);
    await page.evaluate((props) => window.renderFixture(props), { lang, ...extra });
    await trigger().waitFor();
    await frames(page);
  }
  async function opened(index = 0, key = "default", keyboard = "Enter") {
    await trigger(index).focus();
    await page.keyboard.press(keyboard);
    await menu().waitFor();
    await frames(page);
    await selectedFocus(key);
  }
  async function selectedFocus(key) {
    assert.equal((await active(page)).key, key);
    assert.equal(await option(key).getAttribute("tabindex"), "0");
    assert.equal(await menu().locator('[role=option][tabindex="0"]').count(), 1);
    const visible = await option(key).evaluate((node) => {
      const list = node.closest("[role=listbox]"),
        box = node.getBoundingClientRect(),
        clip = list.getBoundingClientRect();
      const hidden = [];
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (
          ancestor.hidden ||
          ancestor.inert ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        )
          hidden.push(ancestor.tagName);
      }
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        hidden,
        hit: node === hit || node.contains(hit),
        box: box.toJSON(),
        clip: clip.toJSON(),
      };
    });
    assert.deepEqual(visible.hidden, []);
    assert.equal(visible.hit, true, JSON.stringify(visible));
    assert.ok(
      visible.box.width > 0 &&
        visible.box.height > 0 &&
        visible.box.left >= visible.clip.left &&
        visible.box.right <= visible.clip.right + 1 &&
        visible.box.top >= visible.clip.top &&
        visible.box.bottom <= visible.clip.bottom + 1,
      JSON.stringify(visible),
    );
  }
  async function association(index = 0, selected = "default") {
    const id = await trigger(index).getAttribute("aria-controls");
    assert.ok(id);
    assert.equal(await menu().getAttribute("id"), id);
    assert.equal(await page.locator(`[id="${id}"]`).count(), 1);
    assert.equal(await trigger(index).getAttribute("aria-expanded"), "true");
    assert.equal(await menu().locator('[aria-selected="true"]').count(), selected ? 1 : 0);
    if (selected) assert.equal(await option(selected).getAttribute("aria-selected"), "true");
    assert.equal(await menu().getByRole("option").count(), 4);
    const ids = await menu()
      .getByRole("option")
      .evaluateAll((nodes) => nodes.map((node) => node.id));
    assert.equal(new Set(ids).size, 4);
    assert.equal(ids.filter(Boolean).length, 4);
    const { root } = await accessibility.send("DOM.getDocument");
    const backend = async (selector) => {
      const { nodeId } = await accessibility.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });
      const { node } = await accessibility.send("DOM.describeNode", { nodeId });
      return node.backendNodeId;
    };
    const listId = await backend(`[id="${id}"]`);
    const triggerId = await backend(`[aria-controls="${id}"]`);
    const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
    const axList = nodes.find((node) => node.backendDOMNodeId === listId);
    const axTrigger = nodes.find((node) => node.backendDOMNodeId === triggerId);
    const focusedId = await page.evaluate(() => document.activeElement.id);
    const focusedBackend = await backend(`[id="${focusedId}"]`);
    const axFocused = nodes.find((node) => node.backendDOMNodeId === focusedBackend);
    assert.equal(axFocused.role.value, "option");
    assert.equal(
      axFocused.properties.find((property) => property.name === "focused")?.value.value,
      true,
    );
    assert.equal(axList.role.value.toLowerCase(), "listbox");
    assert.equal(axTrigger.role.value, "button");
    assert.equal(
      axTrigger.properties.find((property) => property.name === "expanded")?.value.value,
      true,
    );
    assert.ok(
      axTrigger.properties
        .find((property) => property.name === "controls")
        ?.value.relatedNodes.some((node) => node.backendDOMNodeId === listId),
    );
    if (selected) {
      const selectedId = await backend(`[id="${id}"] [id$="-${selected}"]`);
      const axOption = nodes.find((node) => node.backendDOMNodeId === selectedId);
      assert.equal(axOption.role.value, "option");
      assert.equal(
        axOption.properties.find((property) => property.name === "selected")?.value.value,
        true,
      );
    }
  }
  async function closed(index = 0, focused = true) {
    await menu().waitFor({ state: "hidden" });
    await frames(page);
    assert.equal(await trigger(index).getAttribute("aria-expanded"), "false");
    assert.equal(await trigger(index).getAttribute("aria-controls"), null);
    if (focused)
      assert.equal(await trigger(index).evaluate((node) => node === document.activeElement), true);
  }
  async function record(kind, extra = {}) {
    const bounds = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    }));
    assert.ok(bounds.width <= bounds.viewportWidth + 1, JSON.stringify(bounds));
    assert.ok(bounds.height <= bounds.viewportHeight + 1, JSON.stringify(bounds));
    assert.deepEqual(await page.evaluate(() => window.unexpected), []);
    reports.push({
      kind,
      viewport: page.viewportSize(),
      active: await active(page),
      bounds,
      ...(app
        ? {
            zoom: await app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
            ),
          }
        : {}),
      ...extra,
    });
  }
  async function expectTab(direction) {
    await trigger().evaluate((anchor, direction) => {
      const candidates = [
        ...document.querySelectorAll("button,input,select,textarea,a[href],[tabindex]"),
      ].filter(
        (node) =>
          node.tabIndex >= 0 &&
          !node.matches(":disabled") &&
          !node.closest("[hidden],[inert],[role=listbox]") &&
          node.getClientRects().length &&
          getComputedStyle(node).visibility !== "hidden",
      );
      window.expectedTabTarget = candidates[candidates.indexOf(anchor) + direction];
    }, direction);
    await page.keyboard.press(direction === 1 ? "Tab" : "Shift+Tab");
    await menu().waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.activeElement === window.expectedTabTarget),
      true,
    );
  }
  const call = (mode, index = 0) => ({
    index,
    mode,
    core: mode === "accept_edits" ? "acceptEdits" : mode === "bypass" ? "bypassPermissions" : mode,
    external: {
      permissionMode:
        mode === "plan"
          ? "default"
          : mode === "accept_edits"
            ? "acceptEdits"
            : mode === "bypass"
              ? "bypassPermissions"
              : mode,
      planMode: mode === "plan",
    },
  });
  if (!onlyCase || onlyCase === "keyboard")
    for (const [width, height] of [
      [1280, 700],
      [390, 360],
      [320, 240],
    ])
      for (const lang of ["zh", "en"])
        for (const theme of ["light", "dark"]) {
          await boot(width, height, lang, { theme });
          await opened();
          const popupId = await menu().getAttribute("id");
          await association();
          assert.equal(await option("default").getAttribute("aria-selected"), "true");
          await page.keyboard.press("ArrowDown");
          await selectedFocus("accept_edits");
          assert.equal(await option("accept_edits").getAttribute("aria-selected"), "false");
          assert.equal(await option("default").getAttribute("aria-selected"), "true");
          await page.keyboard.press("End");
          await selectedFocus("bypass");
          await page.keyboard.press("Home");
          await selectedFocus("plan");
          await page.keyboard.press("ArrowUp");
          await selectedFocus("plan");
          await page.keyboard.press("End");
          await page.keyboard.press("ArrowDown");
          await selectedFocus("bypass");
          await page.keyboard.press("Enter");
          await closed();
          assert.deepEqual(await page.evaluate(() => window.calls), [call("bypass")]);
          await opened(0, "bypass", "Space");
          assert.equal(await menu().getAttribute("id"), popupId);
          await page.keyboard.press("Home");
          await page.keyboard.press("Space");
          await closed();
          assert.deepEqual(await page.evaluate(() => window.calls), [call("bypass"), call("plan")]);
          await opened(0, "plan", "ArrowDown");
          await page.keyboard.press("Escape");
          await closed();
          await opened(0, "plan", "ArrowUp");
          await expectTab(1);
          await opened(0, "plan");
          await expectTab(-1);
          assert.equal(await page.evaluate(() => window.calls.length), 2);
          await opened(0, "plan");
          const full = await menu().evaluate((node) => ({
            box: node.getBoundingClientRect().toJSON(),
            client: node.clientWidth,
            scroll: node.scrollWidth,
            options: [...node.querySelectorAll("[role=option]")].map((option) => ({
              text: option.textContent,
              client: option.clientWidth,
              scroll: option.scrollWidth,
            })),
          }));
          assert.ok(
            full.box.left >= 9 &&
              full.box.top >= 9 &&
              full.box.right <= width - 9 &&
              full.box.bottom <= height - 9,
            JSON.stringify(full),
          );
          assert.ok(full.scroll <= full.client + 1, JSON.stringify(full));
          assert.equal(full.options.length, 4);
          assert.deepEqual(
            full.options.map((row) => row.text),
            lang === "zh"
              ? ["计划模式", "默认权限", "接受编辑", "完全访问权限"]
              : ["Plan mode", "Default permissions", "Accept edits", "Full access"],
          );
          full.options.forEach((row) =>
            assert.ok(row.client > 0 && row.scroll <= row.client + 1, JSON.stringify(row)),
          );
          await page.screenshot({
            path: path.join(output, `permission-${width}-${lang}-${theme}.png`),
          });
          await page.keyboard.press("Escape");
          await closed();
          await record("keyboard", { lang, theme, full });
        }
  if (!onlyCase || onlyCase === "busy")
    for (const permission of ["default", "bypass", null]) {
      await boot();
      await page.evaluate((permission) => window.composers[0]({ permission }), permission);
      await opened(0, permission || "default");
      await page.evaluate(() => window.composers[0]({ busy: true }));
      await frames(page);
      await menu().waitFor({ state: "hidden" });
      assert.equal(await trigger().isDisabled(), true);
      assert.equal(await trigger().getAttribute("aria-expanded"), "false");
      assert.equal(await trigger().getAttribute("aria-controls"), null);
      assert.deepEqual(await page.evaluate(() => window.calls), []);
      await page.getByRole("textbox", { name: "Outside field", exact: true }).focus();
      await page.evaluate(() => window.composers[0]({ busy: false, permission: "accept_edits" }));
      await frames(page);
      assert.equal((await active(page)).label, "Outside field");
      assert.equal(await menu().count(), 0);
      await opened(0, "accept_edits");
      await association(0, "accept_edits");
      await page.keyboard.press("Escape");
      await closed();
      await record("busy-closes-without-selection-or-reopen", { permission });
    }
  if (!onlyCase || onlyCase === "lifecycle") {
    await boot();
    await opened();
    await page.keyboard.press("ArrowDown");
    await page.evaluate(() => window.composers[0]({ permission: "bypass" }));
    await frames(page);
    await selectedFocus("accept_edits");
    await association(0, "bypass");
    assert.equal(await option("bypass").getAttribute("aria-selected"), "true");
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await page.keyboard.press("Escape");
    await closed();
    await opened(0, "bypass");
    await page.keyboard.press("Escape");
    await closed();
    await record("external-selection-does-not-write-back");
    for (const owner of ["field", "svg", "window-blur-event"]) {
      await boot();
      await opened();
      if (owner === "field")
        await page.getByRole("textbox", { name: "Outside field", exact: true }).focus();
      if (owner === "svg") await page.locator("#outside-svg rect").click();
      if (owner === "window-blur-event")
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await menu().waitFor({ state: "hidden" });
      await frames(page);
      assert.equal(await trigger().evaluate((node) => node === document.activeElement), false);
      const before = await active(page);
      await page.keyboard.press("Escape");
      await frames(page);
      assert.deepEqual(await active(page), before);
      assert.deepEqual(await page.evaluate(() => window.calls), []);
      await record("outside-handoff", { owner });
    }
    await boot();
    await opened();
    await expectTab(1);
    const outside = page.getByRole("textbox", { name: "Outside field", exact: true });
    let tabs = 0;
    while (!(await outside.evaluate((node) => node === document.activeElement))) {
      assert.ok(tabs++ < 40);
      await page.keyboard.press("Tab");
    }
    await page.keyboard.type("Still outside");
    await page.keyboard.press("Escape");
    assert.equal((await active(page)).label, "Outside field");
    assert.equal(await outside.inputValue(), "Still outside");
    await record("native-tab-outside-escape-preserves-owner", { tabs });
    await boot();
    await opened();
    for (const key of ["Enter", " ", "Escape", "ArrowDown"]) {
      const prevented = await option("default").evaluate((node, key) => {
        const event = new KeyboardEvent("keydown", {
          key,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      }, key);
      assert.equal(prevented, true);
      await selectedFocus("default");
      assert.equal(await menu().count(), 1);
      assert.deepEqual(await page.evaluate(() => window.calls), []);
    }
    const prevented = await option("default").evaluate((node) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, true);
    await page.keyboard.press("Enter");
    await closed();
    assert.deepEqual(await page.evaluate(() => window.calls), [call("default")]);
    await record("composition-dom-event-guards");
    for (const handoff of ["field", "unmount"]) {
      await boot();
      await opened();
      await page.evaluate((handoff) => {
        window.afterSelection = () => {
          window.afterSelection = null;
          if (handoff === "unmount") window.unmountFixture();
          document.querySelector('[aria-label="Outside field"]').focus();
        };
      }, handoff);
      await option("bypass").click();
      await frames(page);
      assert.equal(await menu().count(), 0);
      assert.equal((await active(page)).label, "Outside field");
      assert.deepEqual(await page.evaluate(() => window.calls), [call("bypass")]);
      await record("callback-handoff-is-not-reclaimed", { handoff });
    }
    await boot(1280, 700, "en", { multiple: true });
    await opened(0);
    const firstId = await menu().getAttribute("id");
    await expectTab(1);
    let moves = 0;
    while (!(await trigger(1).evaluate((node) => node === document.activeElement))) {
      assert.ok(moves++ < 40);
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    await frames(page);
    await selectedFocus("default");
    assert.equal(await menu().count(), 1);
    assert.notEqual(await menu().getAttribute("id"), firstId);
    assert.equal(await trigger(0).getAttribute("aria-controls"), null);
    await association(1);
    await option("accept_edits").click();
    await closed(1);
    assert.deepEqual(await page.evaluate(() => window.calls), [call("accept_edits", 1)]);
    await record("multiple-composer-isolation", { moves });
    await boot(390, 360, "zh", { variant: "quickChat" });
    await opened();
    await option("accept_edits").click();
    await closed();
    assert.deepEqual(await page.evaluate(() => window.calls), [call("accept_edits")]);
    await record("quick-chat-pointer-selection");
    await boot(1280, 700);
    await opened();
    await page.keyboard.press("End");
    await resize(320, 240);
    await frames(page);
    await selectedFocus("bypass");
    const box = await menu().boundingBox();
    assert.ok(box.x >= 9 && box.y >= 9 && box.x + box.width <= 311 && box.y + box.height <= 231);
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await association();
    await page.keyboard.press("Escape");
    await closed();
    await record("live-resize-current-option");
    await opened();
    await page.evaluate(() => window.unmountFixture());
    await outside.focus();
    await resize(390, 360);
    await frames(page);
    assert.equal(await menu().count(), 0);
    assert.equal((await active(page)).label, "Outside field");
    await page.keyboard.press("Escape");
    assert.equal((await active(page)).label, "Outside field");
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await record("unmount-no-late-focus");
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  if (app) assert.deepEqual(await app.evaluate(() => globalThis.blocked), []);
  else await context.close();
} catch (cause) {
  if (currentPage)
    await currentPage.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw cause;
} finally {
  try {
    if (app) await app.close();
    else await browser?.close();
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        sourceDesktop,
        native,
        development: process.argv.includes("--development"),
        reports,
        errors,
        blocked,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, observations: reports.length, errors, blocked }));
}
