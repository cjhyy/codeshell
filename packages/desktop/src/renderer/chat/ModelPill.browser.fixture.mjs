/* Actual ChatView model picker, production CSS, strict owned bridge and exact-origin guard.
 * --development exercises StrictMode effects; --source-desktop=PATH checks an old implementation.
 * Composition/window blur assertions cover DOM events, not OS IME or screen-reader speech. */
/* global document, window, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, KeyboardEvent, Event */
import assert from "node:assert/strict";
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
const { chromium } = require("playwright");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-model-picker-"));
await mkdir(output, { recursive: true });
const source = String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ChatView} from './ChatView';import {catalogModelOptions} from './settings/textConnections';
import {I18nProvider} from './i18n/I18nProvider';import {saveUILanguage} from './uiLanguage';import {applyTheme} from './theme';
const noop=()=>{};window.unexpected=[];window.calls=[];window.composers=[];
window.codeshell=new Proxy({sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>noop,
 listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']}),log:noop},
 {get(target,key){if(key in target)return target[key];window.unexpected.push(String(key));throw new Error('Unexpected bridge '+String(key));}});
const longProvider=('提供方Provider_'.repeat(30)).slice(0,256),longLabel=('模型Model-name_'.repeat(30)).slice(0,250)+'_END29';
const catalog=[{id:'short',displayName:'Owned provider',tag:'text',adapterKind:'openai',description:'',defaultBaseUrl:'https://owned.invalid/v1',needsKey:false},
 {id:'long',displayName:longProvider,tag:'text',adapterKind:'openai',description:'',defaultBaseUrl:'https://owned.invalid/v1',needsKey:false,modelPresets:[{value:'long-model',label:longLabel}]}];
const models=catalogModelOptions(Array.from({length:30},(_,i)=>({id:'model-'+i,catalogId:i===29?'long':'short',tag:'text',model:i===29?'long-model':'Model '+i})),catalog);
window.models=models;
function Composer({index,variant}){
 const [state,patch]=React.useReducer((old,next)=>({...old,...next}),{models,active:'model-0',busy:false,draft:''});
 React.useLayoutEffect(()=>{window.composers[index]=patch;return()=>{delete window.composers[index]}},[index]);
 return <ChatView variant={variant} messages={[]} onSend={noop} onStop={noop} busy={state.busy}
 activeProjectId="project" permissionMode="plan" onPermissionChange={noop} goalEnabled={false} onGoalToggle={noop}
 modelOptions={state.models} activeModelKey={state.active} onModelChange={option=>{window.calls.push({index,key:option.key,same:models.includes(option)});patch({active:option.key})}}
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
const browser = await chromium.launch({
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
    key: document.activeElement.getAttribute("data-model-key"),
    label:
      document.activeElement.getAttribute("aria-label") ||
      document.activeElement.textContent.trim(),
  }));
let currentPage;
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    if (route.request().url() === "http://model-picker-owned.test/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;overflow:hidden}</style><div id="root"></div><input aria-label="Outside field" style="position:fixed;top:0;right:0;width:60px;z-index:999"><svg id="outside-svg" width="24" height="24" style="position:fixed;bottom:0;left:0;z-index:999"><rect width="24" height="24" fill="black"/></svg>',
      });
    blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  const accessibility = await context.newCDPSession(page);
  await accessibility.send("Accessibility.enable");
  currentPage = page;
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://model-picker-owned.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const trigger = (index = 0) =>
    page.locator(`[data-composer-index="${index}"] [data-active-model]`);
  const menu = () => page.getByRole("listbox");
  const option = (key) => menu().locator(`[data-model-key="${key}"]`);
  async function boot(width = 320, height = 360, lang = "en", extra = {}) {
    await page.setViewportSize({ width, height });
    await page.evaluate((props) => window.renderFixture(props), { lang, ...extra });
    await trigger().waitFor();
    await frames(page);
  }
  async function opened(index = 0, key = "model-0", keyboard = "Enter") {
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
  }
  async function association(index = 0) {
    const id = await trigger(index).getAttribute("aria-controls");
    assert.ok(id);
    assert.equal(await menu().getAttribute("id"), id);
    assert.equal(await page.locator(`[id="${id}"]`).count(), 1);
    assert.equal(await trigger(index).getAttribute("aria-expanded"), "true");
    const selected = await trigger(index).getAttribute("data-active-model");
    assert.equal(
      await menu().locator('[aria-selected="true"]').count(),
      selected && (await menu().locator(`[data-model-key="${selected}"]`).count()) ? 1 : 0,
    );
    if (selected && (await menu().locator(`[data-model-key="${selected}"]`).count()))
      assert.equal(await option(selected).getAttribute("aria-selected"), "true");
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
    const triggerId = await backend(`[data-composer-index="${index}"] [data-active-model]`);
    const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
    const axList = nodes.find((node) => node.backendDOMNodeId === listId);
    const axTrigger = nodes.find((node) => node.backendDOMNodeId === triggerId);
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
    if (selected && (await menu().locator(`[data-model-key="${selected}"]`).count())) {
      const selectedId = await backend(`[id="${id}"] [data-model-key="${selected}"]`);
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
  if (!onlyCase || onlyCase === "keyboard")
    for (const [width, height] of [
      [1280, 700],
      [390, 360],
      [320, 240],
    ])
      for (const lang of ["zh", "en"]) {
        await boot(width, height, lang);
        await opened();
        await association();
        assert.equal(await option("model-0").getAttribute("aria-selected"), "true");
        await page.keyboard.press("ArrowDown");
        await selectedFocus("model-1");
        assert.equal(await option("model-1").getAttribute("aria-selected"), "false");
        assert.equal(await trigger().getAttribute("data-active-model"), "model-0");
        await page.keyboard.press("End");
        await selectedFocus("model-29");
        await page.keyboard.press("Home");
        await selectedFocus("model-0");
        await page.keyboard.press("ArrowUp");
        await selectedFocus("model-0");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await closed();
        assert.deepEqual(await page.evaluate(() => window.calls), [
          { index: 0, key: "model-29", same: true },
        ]);
        assert.equal(await trigger().getAttribute("data-active-model"), "model-29");
        await opened(0, "model-29", "Space");
        await page.keyboard.press("Home");
        await page.keyboard.press("Space");
        await closed();
        assert.deepEqual(await page.evaluate(() => window.calls), [
          { index: 0, key: "model-29", same: true },
          { index: 0, key: "model-0", same: true },
        ]);
        await opened(0, "model-0", "ArrowDown");
        await page.keyboard.press("Escape");
        await closed();
        await opened(0, "model-0", "ArrowUp");
        await expectTab(1);
        await opened();
        await expectTab(-1);
        assert.equal(await page.evaluate(() => window.calls.length), 2);
        await record("keyboard", { lang });
      }
  if (!onlyCase || onlyCase === "long")
    for (const [width, height] of [
      [1280, 700],
      [390, 360],
      [320, 240],
    ])
      for (const lang of ["zh", "en"]) {
        await boot(width, height, lang);
        await trigger().click();
        await menu().waitFor();
        await frames(page);
        await option("model-29").scrollIntoViewIfNeeded();
        const full = await option("model-29").evaluate((node) => {
          const list = node.closest("[role=listbox]"),
            spans = node.querySelectorAll("span");
          return {
            popup: list.getBoundingClientRect().toJSON(),
            client: list.clientWidth,
            scroll: list.scrollWidth,
            provider: {
              text: spans[0].textContent,
              width: spans[0].clientWidth,
              scroll: spans[0].scrollWidth,
            },
            label: {
              text: spans[1].textContent,
              width: spans[1].clientWidth,
              scroll: spans[1].scrollWidth,
            },
          };
        });
        const names = await page.evaluate(() => ({
          provider: window.models[29].provider,
          label: window.models[29].label,
        }));
        assert.equal(full.provider.text, names.provider);
        assert.equal(full.label.text, names.label);
        assert.ok(full.label.width > 0, JSON.stringify(full));
        assert.ok(full.scroll <= full.client + 1, JSON.stringify(full));
        assert.ok(full.provider.scroll <= full.provider.width + 1);
        assert.ok(full.label.scroll <= full.label.width + 1);
        assert.ok(
          full.popup.left >= 9 &&
            full.popup.top >= 9 &&
            full.popup.right <= width - 9 &&
            full.popup.bottom <= height - 9,
          JSON.stringify(full),
        );
        await option("model-29").focus();
        await frames(page);
        await page.keyboard.press("Home");
        await page.keyboard.press("End");
        await frames(page);
        const seen = [new Set(), new Set()];
        let needed;
        for (let step = 0; step < 16; step++) {
          const glyphs = await option("model-29").evaluate((node) => {
            const list = node.closest("[role=listbox]"),
              clip = list.getBoundingClientRect();
            return [...node.querySelectorAll("span")].map((span) => {
              const text = span.firstChild,
                visible = [],
                required = [];
              for (let i = 0; i < text.length; i++) {
                if (/\s/.test(text.textContent[i])) continue;
                required.push(i);
                const range = document.createRange();
                range.setStart(text, i);
                range.setEnd(text, i + 1);
                const r = range.getBoundingClientRect();
                if (
                  r.width &&
                  r.top >= clip.top &&
                  r.bottom <= clip.bottom &&
                  r.left >= clip.left &&
                  r.right <= clip.right
                )
                  visible.push(i);
              }
              return { visible, required };
            });
          });
          needed = glyphs.map((item) => item.required.length);
          glyphs.forEach((item, i) => item.visible.forEach((offset) => seen[i].add(offset)));
          if (seen.every((set, i) => set.size === needed[i])) break;
          await menu().hover();
          await page.mouse.wheel(0, 70);
          await frames(page);
        }
        assert.deepEqual(
          seen.map((set) => set.size),
          needed,
          "Every non-whitespace provider/model glyph can be read by scrolling the actual popup",
        );
        await page.screenshot({ path: path.join(output, `long-${width}-${lang}.png`) });
        await page.keyboard.press("Escape");
        await closed();
        assert.equal(await page.evaluate(() => window.calls.length), 0);
        await record("full-names", { lang, full, glyphs: needed });
      }
  if (!onlyCase || onlyCase === "busy") {
    await boot();
    await trigger().click();
    await menu().waitFor();
    await page.evaluate(() => window.composers[0]({ busy: true }));
    await frames(page);
    await menu().waitFor({ state: "hidden" });
    assert.equal(await trigger().isDisabled(), true);
    assert.equal(await trigger().getAttribute("aria-expanded"), "false");
    assert.equal(await trigger().getAttribute("aria-controls"), null);
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await page.getByRole("textbox", { name: "Outside field", exact: true }).focus();
    await page.evaluate(() => window.composers[0]({ busy: false, active: "model-12" }));
    await frames(page);
    assert.equal((await active(page)).label, "Outside field");
    assert.equal(await menu().count(), 0);
    assert.equal(await trigger().getAttribute("data-active-model"), "model-12");
    await record("busy-closes-without-selection-or-reopen");
  }
  if (!onlyCase || onlyCase === "lifecycle") {
    await boot();
    await opened();
    await page.keyboard.press("ArrowDown");
    await page.evaluate(() => window.composers[0]({ active: "model-12" }));
    await frames(page);
    await selectedFocus("model-1");
    await association();
    assert.equal(await trigger().getAttribute("data-active-model"), "model-12");
    await page.keyboard.press("Escape");
    await closed();
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await opened(0, "model-12");
    await record("external-selection-does-not-write-back");
    await page.evaluate(() => window.composers[0]({ models: window.models.slice(0, 2) }));
    await frames(page);
    await selectedFocus("model-0");
    assert.equal(await menu().locator("[aria-selected=true]").count(), 0);
    await page.evaluate(() => window.composers[0]({ models: [] }));
    await frames(page);
    assert.equal(await menu().evaluate((node) => node === document.activeElement), true);
    assert.equal(await menu().getByRole("option").count(), 0);
    await page.keyboard.press("Escape");
    await closed();
    await record("shrinking-and-empty-options");
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
      assert.equal(await page.evaluate(() => window.calls.length), 0);
      await record("outside-handoff", { owner });
    }
    await boot();
    await opened();
    const ime = await option("model-0").evaluate((node) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(ime, true);
    assert.equal(await menu().count(), 1);
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await page.keyboard.press("Enter");
    await closed();
    assert.deepEqual(await page.evaluate(() => window.calls), [
      { index: 0, key: "model-0", same: true },
    ]);
    await record("composition-event-guard");
    await boot(1280, 700, "en", { multiple: true });
    await opened(0);
    const firstId = await menu().getAttribute("id");
    await page.keyboard.press("Escape");
    await opened(1);
    assert.notEqual(await menu().getAttribute("id"), firstId);
    assert.equal(await trigger(0).getAttribute("aria-controls"), null);
    await association(1);
    await page.keyboard.press("Escape");
    await closed(1);
    await record("multiple-composer-isolation");
    await boot(390, 360, "en", { variant: "quickChat" });
    await opened();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await closed();
    assert.deepEqual(await page.evaluate(() => window.calls), [
      { index: 0, key: "model-29", same: true },
    ]);
    await record("quick-chat-selection");
    await boot(1280, 700);
    await opened();
    await page.keyboard.press("End");
    await page.setViewportSize({ width: 320, height: 240 });
    await frames(page);
    await selectedFocus("model-29");
    const box = await menu().boundingBox();
    assert.ok(box.x >= 9 && box.y >= 9 && box.x + box.width <= 311 && box.y + box.height <= 231);
    await page.keyboard.press("Escape");
    await closed();
    await record("live-resize-selected-option");
    await opened();
    await page.evaluate(() => window.unmountFixture());
    await page.getByRole("textbox", { name: "Outside field", exact: true }).focus();
    await page.setViewportSize({ width: 390, height: 360 });
    await frames(page);
    assert.equal(await menu().count(), 0);
    assert.equal((await active(page)).label, "Outside field");
    await record("unmount-no-late-focus");
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await context.close();
} catch (cause) {
  if (currentPage)
    await currentPage.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw cause;
} finally {
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        sourceDesktop,
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
