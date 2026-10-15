/** Real SettingsPage connection recovery and responsive cards; only owned bridge state, no network. */
/* global document, window, requestAnimationFrame, getComputedStyle, Event */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-desktop");
const sourceDesktop = sourceIndex < 0 ? desktop : path.resolve(process.argv[sourceIndex + 1]);
const renderer = path.join(sourceDesktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const out =
  process.env.CODESHELL_CONNECTIONS_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-connections-ui-")));
await mkdir(out, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsPage} from './settings/SettingsPage';
import {I18nProvider} from './i18n/I18nProvider';
import {DialogProvider} from './ui/DialogProvider';
import {ToastProvider} from './ui/ToastProvider';
import {saveUILanguage} from './uiLanguage';
import {saveProjects} from './projects';
const project={id:'fixture-project',path:'/fixture-project',name:'Fixture project',addedAt:1,primaryRootId:'fixture-root',roots:[{id:'fixture-root',path:'/fixture-project',name:'Fixture root',addedAt:1}]};saveProjects([project]);
let stored={permissionMode:'default', modelConnections:[
{id:'text-'+('connection_'.repeat(15)),catalogId:'fixture-text',tag:'text',model:'model-'+('long_model_'.repeat(12))},
{id:'speech-'+('connection_'.repeat(15)),catalogId:'fixture-speech',tag:'speech',model:'voice-one'},
],credentials:[],defaults:{text:'text-'+('connection_'.repeat(15)),speech:'speech-'+('connection_'.repeat(15))},
search:{provider:'serper',providers:{serper:{apiKey:'synthetic-serper-saved'},tavily:{apiKey:'synthetic-tavily-saved'},searxng:{baseUrl:'https://owned.invalid'}}}};
if(window.initialLegacy)stored.search={provider:'tavily',apiKey:'synthetic-legacy-key',baseUrl:'https://owned-legacy.invalid'};
for(const tag of ['image','video','audio']){stored.modelConnections.push({id:tag+'-'+('connection_'.repeat(15)),catalogId:'fixture-'+tag,tag,model:'fixture-'+tag+'-one'});stored.defaults[tag]=tag+'-'+('connection_'.repeat(15));}
const catalog=[
{id:'fixture-text',tag:'text',displayName:'Fixture text '+('provider_'.repeat(12)),needsKey:false,modelPresets:[{value:'model-'+('long_model_'.repeat(12))}]},
{id:'fixture-speech',tag:'speech',displayName:'Fixture speech '+('provider_'.repeat(12)),needsKey:false,modelPresets:[{value:'voice-one'}]}];
for(const tag of ['image','video','audio'])catalog.push({id:'fixture-'+tag,tag,displayName:'Fixture '+tag+' provider',needsKey:false,modelPresets:[{value:'fixture-'+tag+'-one'}]});
window.fixture={writes:[],writeTargets:[],readTargets:[],reads:0,holdWrite:false,failWrite:false,failRead:window.initialReadFailure??false,holdRead:false,heldReads:[],held:[],unsafeCalls:0,probeCalls:[],holdProbe:false,probeResult:null,
releaseReads(){const held=this.heldReads.splice(0);held.forEach(x=>x());},
releaseProbe(){this.probeResolve?.();},
stored:()=>structuredClone(stored),
resolve(){const held=this.held.splice(0);held.forEach(x=>{stored={...stored,...x.patch};x.resolve();});},
reject(){const held=this.held.splice(0);held.forEach(x=>x.reject(new Error('Owned write rejection')));}};
const unsafe=async()=>{window.fixture.unsafeCalls++;throw new Error('Unexpected native action');};
const write=async(patch,target)=>{window.fixture.writes.push(structuredClone(patch));window.fixture.writeTargets.push(target);
if(window.fixture.failWrite)throw new Error('Owned write rejection');
if(window.fixture.holdWrite)return new Promise((resolve,reject)=>window.fixture.held.push({patch,resolve,reject}));
stored={...stored,...structuredClone(patch)};};
window.codeshell={
getSettings:async()=>{window.fixture.reads++;if(window.fixture.failRead)throw new Error('Owned read rejection');const snapshot=structuredClone(stored);if(window.fixture.holdRead)await new Promise(resolve=>window.fixture.heldReads.push(resolve));return snapshot;},
getConfigurationSettings:async target=>{window.fixture.readTargets.push(structuredClone(target));if(target.projectId!=='fixture-project')throw new Error('Unexpected project target');return structuredClone(stored);},
getModelCatalog:async()=>structuredClone(catalog),getCatalogOrigins:async()=>({}),
getUpdaterStatus:async()=>({kind:'idle'}),onUpdaterStatus:()=>()=>{},getAppVersion:async()=>'fixture',
updateSettings:async(scope,patch)=>{if(scope!=='user')throw new Error('Unexpected settings scope');return write(patch,'user');},
updateConfigurationSettings:async(target,patch)=>{if(target.projectId!=='fixture-project')throw new Error('Unexpected project target');return write(patch,structuredClone(target));},
probeSearch:async input=>{window.fixture.probeCalls.push(structuredClone(input));if(window.fixture.holdProbe)await new Promise(resolve=>window.fixture.probeResolve=resolve);return window.fixture.probeResult??{status:'error',errorMessage:'Owned synthetic failure '+('long_error_'.repeat(50)),lastProbedAt:new Date().toISOString()};},
sttDescribe:async()=>({source:'configured'}),openExternal:unsafe,
};
const root=createRoot(document.getElementById('root'));let generation=0;
window.renderFixture=(lang,initialModule='general',projectScope=false)=>{localStorage.clear();saveUILanguage(lang);
root.render(<I18nProvider key={++generation}><DialogProvider><ToastProvider>
<SettingsPage initialModule={initialModule} activeProjectPath={null} initialProjectPath={projectScope?project.path:null} projects={[project]} sessionIndices={{}}
onRestoreArchivedSession={()=>{}} onDeleteArchivedSession={()=>{}} isMac={false} isFullscreen={false} onBack={()=>{}}/>
</ToastProvider></DialogProvider></I18nProvider>);};
window.unmountFixture=()=>root.render(null);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "empty", ".wav": "empty", ".css": "empty" },
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
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || chromium.executablePath(),
});
const reports = [],
  errors = [],
  blocked = [];
let diagnosticPage;
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const labels = (lang) =>
  lang === "zh"
    ? {
        general: "常规",
        config: "配置",
        connections: "连接",
        navigation: "设置导航",
        default: "默认",
        setDefault: "设为默认",
        save: "保存",
        clear: "清除",
        test: "测试搜索",
        retry: "重新读取",
        cancel: "取消",
        confirm: "确定",
        speech: /文字配音/,
        audio: /语音转写/,
        image: /图片生成/,
        video: /视频生成/,
      }
    : {
        general: "General",
        config: "Config",
        connections: "Connections",
        navigation: "Settings navigation",
        default: "Default",
        setDefault: "Set as default",
        save: "Save",
        clear: "Clear",
        test: "Test search",
        retry: "Read again",
        cancel: "Cancel",
        confirm: "OK",
        speech: /Text-to-speech/,
        audio: /Speech-to-text/,
        image: /Image generation/,
        video: /Video generation/,
      };
async function mount({
  width = 390,
  height = 360,
  language = "en",
  module = "general",
  initialReadFailure = false,
  legacy = false,
  theme = "light",
  projectScope = false,
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  diagnosticPage = page;
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://connections-owned.test/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
      });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://connections-owned.test/");
  await page.addStyleTag({ content: css });
  await page.evaluate(
    ({ initialReadFailure, legacy, theme }) => {
      window.initialReadFailure = initialReadFailure;
      window.initialLegacy = legacy;
      document.documentElement.classList.toggle("dark", theme === "dark");
    },
    { initialReadFailure, legacy, theme },
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(
    ({ language, module, projectScope }) => window.renderFixture(language, module, projectScope),
    {
      language,
      module,
      projectScope,
    },
  );
  await page
    .getByRole("heading", { level: 1, name: labels(language)[module], exact: true })
    .waitFor();
  await settle(page);
  return { page, context };
}
async function navigate(page, language, module) {
  const text = labels(language);
  const picker = page.getByRole("combobox", { name: text.navigation, exact: true });
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole("option", { name: text[module], exact: true }).click();
    await page.locator('[role="listbox"]').waitFor({ state: "hidden" });
  } else
    await page
      .getByRole("navigation", { name: text.navigation, exact: true })
      .getByRole("button", { name: text[module], exact: true })
      .click();
  await page.getByRole("heading", { level: 1, name: text[module], exact: true }).waitFor();
  await settle(page);
}
const card = (page, name) =>
  page
    .locator("main article")
    .filter({ has: page.locator("strong").getByText(name, { exact: true }) });
const serper = (page) => card(page, "Google Web Search (Serper)");
const tavily = (page) => card(page, "Tavily AI Search");
const value = (provider) => provider.locator("input").inputValue();
const focused = (node) => node.evaluate((element) => element === document.activeElement);
async function assertVisibleFocus(locator) {
  const value = await locator.evaluate((node) => {
    const b = node.getBoundingClientRect(),
      main = node.closest("main").getBoundingClientRect();
    return {
      focused: node === document.activeElement,
      box: b.toJSON(),
      main: main.toJSON(),
      hit: node.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
    };
  });
  assert.equal(value.focused, true);
  assert.ok(
    value.box.top >= value.main.top - 1 && value.box.bottom <= value.main.bottom + 1,
    JSON.stringify(value),
  );
  assert.equal(value.hit, true);
}
const writes = (page) => page.evaluate(() => window.fixture.writes.length);
async function idle(page) {
  await page.waitForFunction(() => {
    const root = document.querySelector("main section[aria-busy]");
    return !root || root.getAttribute("aria-busy") === "false";
  });
  await settle(page);
}
async function assertDefaults(page, expected, language = "en") {
  assert.deepEqual(
    await page
      .locator("main article")
      .filter({ has: page.getByText(labels(language).default, { exact: true }) })
      .locator("strong")
      .allTextContents(),
    [expected],
  );
}
async function inspect(page, label, config) {
  const metrics = await page.locator("main").evaluate((main) => {
    const bounds = (node) => node.getBoundingClientRect().toJSON();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      main: { box: bounds(main), clientWidth: main.clientWidth, scrollWidth: main.scrollWidth },
      bodyWidth: document.documentElement.scrollWidth,
      bodyHeight: document.documentElement.scrollHeight,
      cards: [...main.querySelectorAll("article")].map((node) => ({
        box: bounds(node),
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        ancestors: (() => {
          const list = [];
          for (let p = node.parentElement; p && p !== main; p = p.parentElement) {
            if (/hidden|clip/.test(getComputedStyle(p).overflowX))
              list.push({ box: bounds(p), scrollLeft: p.scrollLeft });
          }
          return list;
        })(),
      })),
      ids: [...main.querySelectorAll("article header code")].map((node) => ({
        text: node.textContent,
        box: bounds(node),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      })),
      hidden: (() => {
        const nodes = [main, ...main.querySelectorAll("*")];
        for (let ancestor = main.parentElement; ancestor; ancestor = ancestor.parentElement)
          nodes.push(ancestor);
        return nodes.flatMap((node) => {
          const s = getComputedStyle(node);
          return (/(hidden|clip)/.test(s.overflowX) && node.scrollLeft !== 0) ||
            (/(hidden|clip)/.test(s.overflowY) && node.scrollTop !== 0)
            ? [{ tag: node.tagName, left: node.scrollLeft, top: node.scrollTop }]
            : [];
        });
      })(),
    };
  });
  assert.equal(metrics.viewport.width, config.width);
  assert.equal(metrics.viewport.height, config.height);
  assert.ok(metrics.main.scrollWidth <= metrics.main.clientWidth + 1, JSON.stringify(metrics));
  assert.ok(metrics.bodyWidth <= config.width + 1);
  assert.ok(metrics.bodyHeight <= config.height + 1, JSON.stringify(metrics));
  assert.deepEqual(metrics.hidden, []);
  for (const card of metrics.cards) {
    assert.ok(card.scrollWidth <= card.clientWidth + 1, JSON.stringify(card));
    assert.ok(
      card.box.x >= metrics.main.box.x && card.box.right <= metrics.main.box.right + 1,
      JSON.stringify(card),
    );
    for (const ancestor of card.ancestors) {
      assert.ok(
        card.box.x >= ancestor.box.x - 1 && card.box.right <= ancestor.box.right + 1,
        JSON.stringify(card),
      );
      assert.equal(ancestor.scrollLeft, 0);
    }
  }
  reports.push({ kind: label, ...config, metrics });
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(out, name + ".png") });
}
async function confirmClear(page, language = "en", accept = true) {
  await serper(page)
    .getByRole("button", { name: labels(language).clear, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: labels(language)[accept ? "confirm" : "cancel"], exact: true })
    .click();
  await settle(page);
}
async function record(page, kind) {
  assert.equal(await page.evaluate(() => window.fixture.unsafeCalls), 0);
  reports.push({
    kind,
    writes: await writes(page),
    probeCalls: await page.evaluate(() => window.fixture.probeCalls.length),
  });
}
try {
  if (!process.argv.includes("--behaviors-only"))
    for (const [width, height] of [
      [320, 240],
      [320, 360],
      [390, 240],
      [390, 360],
      [800, 480],
      [1280, 760],
    ])
      for (const language of ["zh", "en"])
        for (const theme of ["light", "dark"]) {
          const config = { width, height, language, theme };
          const { page, context } = await mount(config);
          await navigate(page, language, "config");
          await page.locator("main article").first().waitFor();
          await idle(page);
          await inspect(page, "config-layout", config);
          await page.mouse.move(width / 2, height - 40);
          await page.mouse.wheel(0, 280);
          await page.waitForFunction(() => document.querySelector("main").scrollTop > 0);
          await settle(page);
          await screenshot(page, `config-${language}-${theme}-${width}x${height}`);
          await navigate(page, language, "connections");
          await serper(page).waitFor();
          await inspect(page, "search-layout", config);
          await page.mouse.move(width / 2, height - 40);
          await page.mouse.wheel(0, 360);
          await page.waitForFunction(() => document.querySelector("main").scrollTop > 0);
          await settle(page);
          await screenshot(page, `search-${language}-${theme}-${width}x${height}`);
          await serper(page)
            .getByRole("button", { name: labels(language).test, exact: true })
            .click();
          await page.getByText(/^Owned synthetic failure/).waitFor();
          await idle(page);
          await inspect(page, "long-probe-error", config);
          for (const group of ["speech", "audio", "image", "video"]) {
            await page.getByRole("button", { name: labels(language)[group] }).click();
            if (group === "speech") {
              await page.locator("main fieldset article").waitFor();
              await page.locator("main").evaluate((main) => {
                const card = main.querySelector("fieldset article");
                main.scrollTop +=
                  card.getBoundingClientRect().top - main.getBoundingClientRect().top;
              });
            }
            await page.waitForFunction(() =>
              [...document.querySelectorAll("main fieldset")].every(
                (panel) => panel.getAttribute("aria-busy") === "false",
              ),
            );
            await idle(page);
            await inspect(page, group + "-layout", config);
            if (group === "speech")
              await screenshot(page, `speech-${language}-${theme}-${width}x${height}`);
          }
          await screenshot(page, `all-groups-${language}-${theme}-${width}x${height}`);
          await context.close();
        }
  for (const language of ["zh", "en"]) {
    const text = labels(language);
    {
      const { page, context } = await mount({
        width: 800,
        height: 480,
        language,
        module: "connections",
      });
      await tavily(page).getByRole("button", { name: text.setDefault, exact: true }).waitFor();
      await page.evaluate(() => (window.fixture.holdWrite = true));
      const action = tavily(page).getByRole("button", { name: text.setDefault, exact: true });
      await action.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.fixture.writes.length === 1);
      await assertDefaults(page, "Google Web Search (Serper)", language);
      await page.evaluate(() => window.fixture.reject());
      await page
        .getByText(
          language === "zh"
            ? "默认搜索连接保存失败，请重试"
            : "Could not save the default search connection. Please retry.",
          { exact: true },
        )
        .waitFor();
      await idle(page);
      await assertDefaults(page, "Google Web Search (Serper)", language);
      assert.equal(await focused(action), true);
      assert.equal(await page.evaluate(() => window.fixture.stored().search.provider), "serper");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.fixture.writes.length === 2);
      await page.evaluate(() => window.fixture.resolve());
      await idle(page);
      await assertDefaults(page, "Tavily AI Search", language);
      assert.equal(await page.evaluate(() => window.fixture.stored().search.provider), "tavily");
      assert.equal(await focused(tavily(page).locator("input")), true);
      await assertVisibleFocus(tavily(page).locator("input"));
      await record(page, "default-failure-retry-success-" + language);
      await screenshot(page, "default-success-" + language);
      await context.close();
    }
    {
      const { page, context } = await mount({
        width: 800,
        height: 480,
        language,
        module: "connections",
      });
      await serper(page).locator("input").fill("synthetic-unsaved-draft");
      await confirmClear(page, language, false);
      assert.equal(await value(serper(page)), "synthetic-unsaved-draft");
      assert.equal(await writes(page), 0);
      await page.evaluate(() => (window.fixture.holdWrite = true));
      await confirmClear(page, language);
      await page.waitForFunction(() => window.fixture.writes.length === 1);
      assert.equal(await value(serper(page)), "synthetic-unsaved-draft");
      await page.evaluate(() => window.fixture.reject());
      await page
        .getByText(
          language === "zh"
            ? "清除失败，已保留修改，请重试"
            : "Clear failed. Your edits are kept; please retry.",
          { exact: true },
        )
        .waitFor();
      await idle(page);
      assert.equal(await value(serper(page)), "synthetic-unsaved-draft");
      assert.equal(
        await focused(serper(page).getByRole("button", { name: text.clear, exact: true })),
        true,
      );
      await confirmClear(page, language);
      await page.waitForFunction(() => window.fixture.writes.length === 2);
      await page.evaluate(() => window.fixture.resolve());
      await idle(page);
      assert.equal(await value(serper(page)), "");
      assert.equal(
        await page.evaluate(() => window.fixture.stored().search.providers.serper),
        undefined,
      );
      assert.equal(await focused(serper(page).locator("input")), true);
      await assertVisibleFocus(serper(page).locator("input"));
      await record(page, "clear-cancel-failure-retry-success-" + language);
      await context.close();
    }
    {
      const { page, context } = await mount({
        width: 800,
        height: 480,
        language,
        module: "connections",
      });
      const input = serper(page).locator("input");
      await input.fill("synthetic-save-draft");
      await page.evaluate(() => (window.fixture.holdWrite = true));
      await serper(page).getByRole("button", { name: text.save, exact: true }).click();
      await page.waitForFunction(() => window.fixture.writes.length === 1);
      await input.fill("synthetic-newer-draft");
      await input.evaluate((node) => node.setSelectionRange(3, 8, "backward"));
      await page.evaluate(() => window.fixture.resolve());
      await idle(page);
      assert.equal(await value(serper(page)), "synthetic-newer-draft");
      assert.equal(await focused(input), true);
      assert.deepEqual(
        await input.evaluate((node) => [
          node.selectionStart,
          node.selectionEnd,
          node.selectionDirection,
        ]),
        [3, 8, "backward"],
      );
      assert.equal(
        await page.evaluate(() => window.fixture.stored().search.providers.serper.apiKey),
        "synthetic-save-draft",
      );
      assert.equal(
        await serper(page).getByRole("button", { name: text.save, exact: true }).isEnabled(),
        true,
      );
      await serper(page).getByRole("button", { name: text.save, exact: true }).click();
      await page.waitForFunction(() => window.fixture.writes.length === 2);
      await page.evaluate(() => window.fixture.reject());
      await idle(page);
      assert.equal(await value(serper(page)), "synthetic-newer-draft");
      assert.equal(
        await focused(serper(page).getByRole("button", { name: text.save, exact: true })),
        true,
      );
      await record(page, "save-newer-edit-and-failure-" + language);
      await context.close();
    }
  }
  {
    const { page, context } = await mount({ width: 800, height: 480, module: "connections" });
    await serper(page).locator("input").fill("synthetic-current-draft");
    await page.evaluate(() => {
      window.fixture.holdRead = true;
      window.dispatchEvent(new Event("codeshell:settings-changed"));
    });
    await page.waitForFunction(() => window.fixture.heldReads.length === 1);
    await serper(page).locator("input").fill("synthetic-draft-during-read");
    await page.evaluate(() => window.fixture.releaseReads());
    await idle(page);
    assert.equal(await value(serper(page)), "synthetic-draft-during-read");
    assert.equal(await focused(serper(page).locator("input")), true);
    await page.evaluate(() => {
      window.fixture.holdRead = false;
      window.fixture.failRead = true;
      window.dispatchEvent(new Event("codeshell:settings-changed"));
    });
    await page.getByRole("alert").waitFor();
    assert.equal(await value(serper(page)), "synthetic-draft-during-read");
    assert.equal(
      await serper(page).getByRole("button", { name: "Save", exact: true }).isDisabled(),
      true,
    );
    await page.evaluate(() => (window.fixture.failRead = false));
    await page.getByRole("button", { name: "Read again", exact: true }).click();
    await page.getByRole("alert").waitFor({ state: "hidden" });
    await idle(page);
    assert.equal(await value(serper(page)), "synthetic-draft-during-read");
    assert.equal(await focused(serper(page).locator("input")), true);
    await record(page, "refresh-draft-failure-retry");
    await context.close();
  }
  {
    const { page, context } = await mount({
      width: 390,
      height: 360,
      module: "connections",
      initialReadFailure: true,
    });
    await page.getByRole("alert").waitFor();
    assert.equal(await page.locator("main article").count(), 0);
    assert.equal(await writes(page), 0);
    await page.evaluate(() => (window.fixture.failRead = false));
    await page.getByRole("button", { name: "Read again", exact: true }).focus();
    await page.keyboard.press("Enter");
    await serper(page).waitFor();
    await idle(page);
    assert.equal(await focused(serper(page).locator("input")), true);
    await assertVisibleFocus(serper(page).locator("input"));
    await record(page, "initial-read-failure-retry");
    await context.close();
  }
  {
    const { page, context } = await mount({ width: 800, height: 480, module: "connections" });
    await page.evaluate(() => (window.fixture.holdWrite = true));
    await tavily(page).getByRole("button", { name: "Set as default", exact: true }).click();
    await page.waitForFunction(() => window.fixture.writes.length === 1);
    await serper(page).locator("input").fill("synthetic-other-card-newer");
    await page.evaluate(() => window.fixture.resolve());
    await idle(page);
    assert.equal(await focused(serper(page).locator("input")), true);
    assert.equal(await value(serper(page)), "synthetic-other-card-newer");
    await assertDefaults(page, "Tavily AI Search");
    await record(page, "default-success-outside-source-focus");
    await context.close();
  }
  {
    const { page, context } = await mount({ width: 800, height: 480, module: "connections" });
    await page.evaluate(() => (window.fixture.holdProbe = true));
    await serper(page).getByRole("button", { name: "Test search", exact: true }).click();
    await page.waitForFunction(() => window.fixture.probeCalls.length === 1);
    await serper(page).locator("input").fill("synthetic-newer-after-probe");
    await page.evaluate(() => window.fixture.releaseProbe());
    await idle(page);
    assert.equal(await page.getByText(/^Owned synthetic failure/).count(), 0);
    assert.equal(await value(serper(page)), "synthetic-newer-after-probe");
    assert.equal(await focused(serper(page).locator("input")), true);
    assert.equal(await writes(page), 0);
    await record(page, "late-probe-does-not-mark-new-credential");
    await context.close();
  }
  {
    const { page, context } = await mount({
      width: 800,
      height: 480,
      module: "connections",
      legacy: true,
    });
    assert.equal(await value(tavily(page)), "synthetic-legacy-key");
    await page.evaluate(() => (window.fixture.holdWrite = true));
    await serper(page).locator("input").fill("synthetic-new-serper");
    await serper(page).getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => window.fixture.writes.length === 1);
    const patch = await page.evaluate(() => window.fixture.writes[0]);
    assert.equal(patch.search.provider, "tavily");
    assert.equal(patch.search.apiKey, "synthetic-legacy-key");
    assert.equal(patch.search.baseUrl, "https://owned-legacy.invalid");
    assert.equal(patch.search.providers.serper.apiKey, "synthetic-new-serper");
    assert.equal(patch.search.providers.tavily.apiKey, "synthetic-legacy-key");
    await page.evaluate(() => window.fixture.resolve());
    await idle(page);
    await record(page, "legacy-wire-preserved");
    await context.close();
  }
  {
    const { page, context } = await mount({ width: 800, height: 480, module: "connections" });
    await page.evaluate(() => (window.fixture.holdWrite = true));
    await tavily(page).getByRole("button", { name: "Set as default", exact: true }).click();
    await page.waitForFunction(() => window.fixture.writes.length === 1);
    await navigate(page, "en", "general");
    await page.evaluate(() => window.fixture.reject());
    await settle(page);
    assert.equal(
      await page
        .getByText("Could not save the default search connection. Please retry.", { exact: true })
        .count(),
      0,
    );
    await record(page, "unmounted-write-silent");
    await context.close();
  }
  {
    const { page, context } = await mount({
      width: 390,
      height: 360,
      module: "connections",
      projectScope: true,
    });
    await serper(page).locator("input").fill("synthetic-project-draft");
    await serper(page).getByRole("button", { name: "Save", exact: true }).click();
    await idle(page);
    assert.deepEqual(await page.evaluate(() => window.fixture.writeTargets), [
      { projectId: "fixture-project" },
    ]);
    assert.ok(
      (await page.evaluate(() => window.fixture.readTargets)).every(
        (target) => target.projectId === "fixture-project",
      ),
    );
    assert.equal(
      await page.evaluate(() => window.fixture.stored().search.providers.serper.apiKey),
      "synthetic-project-draft",
    );
    await record(page, "project-target-preserved");
    await context.close();
  }
  for (const language of ["zh", "en"]) {
    const config = { width: 320, height: 240, language };
    const { page, context } = await mount({ ...config, module: "connections" });
    await serper(page).locator("input").focus();
    let stops = 0;
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press("Tab");
      const active = await page.evaluate(() => {
        const node = document.activeElement,
          main = document.querySelector("main");
        if (!node?.closest("article") || !main.contains(node)) return null;
        const box = node.getBoundingClientRect(),
          parent = main.getBoundingClientRect();
        return {
          text: node.textContent,
          box: box.toJSON(),
          parent: parent.toJSON(),
          hit: node.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          ),
        };
      });
      if (active) {
        stops++;
        assert.ok(
          active.box.top >= active.parent.top - 1 && active.box.bottom <= active.parent.bottom + 1,
          JSON.stringify(active),
        );
        assert.ok(
          active.box.left >= active.parent.left && active.box.right <= active.parent.right,
          JSON.stringify(active),
        );
        assert.equal(active.hit, true);
      }
    }
    assert.ok(stops >= 15, "Tab traverses the real provider inputs and footer actions");
    await inspect(page, "keyboard-visible-stops", config);
    await context.close();
  }
  {
    const { page, context } = await mount({ width: 390, height: 360, module: "connections" });
    await serper(page).locator("input").fill("synthetic-duplicate-guard");
    await page.evaluate(() => (window.fixture.holdWrite = true));
    const save = serper(page).getByRole("button", { name: "Save", exact: true });
    await save.click();
    await page.waitForFunction(() => window.fixture.writes.length === 1);
    assert.equal(
      await page
        .locator("main article footer button")
        .evaluateAll((buttons) => buttons.every((button) => button.disabled)),
      true,
    );
    const box = await serper(page)
      .getByRole("button", { name: "Saving…", exact: true })
      .boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
    assert.equal(await writes(page), 1);
    await page.evaluate(() => window.fixture.reject());
    await idle(page);
    assert.equal(await value(serper(page)), "synthetic-duplicate-guard");
    await record(page, "real-double-click-guard");
    await context.close();
  }
  {
    const { page, context } = await mount({ width: 390, height: 360, module: "connections" });
    await serper(page).locator("input").fill("synthetic-outside-focus");
    await page.evaluate(() => {
      window.fixture.holdWrite = true;
      const blank = document.createElement("div");
      blank.id = "outside-blank";
      blank.style.cssText = "position:fixed;top:0;right:0;width:8px;height:8px;z-index:100";
      document.body.appendChild(blank);
    });
    await serper(page).getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => window.fixture.writes.length === 1);
    await page.locator("#outside-blank").click();
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await page.evaluate(() => window.fixture.reject());
    await idle(page);
    assert.equal(
      await page.evaluate(() => document.activeElement === document.body),
      true,
      "An explicit outside blank click must not be treated as disabled-opener focus loss",
    );
    await record(page, "save-failure-outside-blank-focus");
    await context.close();
  }
  for (const succeeds of [false, true]) {
    const { page, context } = await mount({ width: 390, height: 360, module: "connections" });
    await page.evaluate(() => (window.fixture.holdWrite = true));
    await confirmClear(page);
    await page.waitForFunction(() => window.fixture.writes.length === 1);
    await serper(page).locator("input").fill("synthetic-new-draft-after-clear");
    await page.evaluate((succeeds) => window.fixture[succeeds ? "resolve" : "reject"](), succeeds);
    await idle(page);
    assert.equal(await value(serper(page)), "synthetic-new-draft-after-clear");
    assert.equal(await focused(serper(page).locator("input")), true);
    assert.equal(
      await page.evaluate(() => window.fixture.stored().search.providers.serper?.apiKey),
      succeeds ? undefined : "synthetic-serper-saved",
    );
    await record(page, "clear-newer-edit-" + (succeeds ? "success" : "failure"));
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ result: "pass", out, observations: reports.length }));
} catch (error) {
  if (diagnosticPage && !diagnosticPage.isClosed())
    await diagnosticPage.screenshot({ path: path.join(out, "failure.png") });
  reports.push({
    kind: "failure",
    error: String(error),
    diagnostics:
      diagnosticPage && !diagnosticPage.isClosed()
        ? await diagnosticPage.evaluate(() => ({
            children: [...document.body.children].map((node) => ({
              tag: node.tagName,
              role: node.getAttribute("role"),
              state: node.getAttribute("data-state"),
              rect: node.getBoundingClientRect().toJSON(),
              position: getComputedStyle(node).position,
              html: node.outerHTML.slice(0, 350),
            })),
            outside: [...document.querySelectorAll("*")]
              .filter(
                (node) =>
                  !node.closest("main") &&
                  node.getBoundingClientRect().bottom > window.innerHeight + 1,
              )
              .slice(0, 20)
              .map((node) => ({
                tag: node.tagName,
                rect: node.getBoundingClientRect().toJSON(),
                position: getComputedStyle(node).position,
                html: node.outerHTML.slice(0, 350),
              })),
          }))
        : null,
  });
  throw error;
} finally {
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ sourceDesktop, chrome: browser.version(), reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
