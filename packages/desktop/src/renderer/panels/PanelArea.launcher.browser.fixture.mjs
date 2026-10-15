/* Real PanelArea/launcher state and production Tailwind in isolated Chrome. */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Run through run-isolated-node-smoke.mjs");
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output = "/tmp/codeshell-panel-launcher-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {flushSync} from 'react-dom';
  import {FolderTree,PanelsTopLeft,NotebookPen,Link} from 'lucide-react';
  import {PanelArea} from './panels/PanelArea';
  import {PANEL_REGISTRY} from './panels/PanelRegistry';
  import {PANEL_LAUNCHER_KIND} from './panels/panelLauncherKind';
  import {I18nProvider} from './i18n/I18nProvider';
  import {translate} from './i18n/translate';
  import {saveUILanguage} from './uiLanguage';
  const SINGLE='launcher-notes',APP='launcher-data',LINK='launcher-link',INTERNAL='launcher-private',LAST='launcher-final';
  window.codeshell={openPanelAppWindow:async()=>{}};
  function RetainedPanel({context}){
    const [draft,setDraft]=React.useState('');
    React.useEffect(()=>{window.mounts.push(context.tabId);return()=>window.unmounts.push(context.tabId)},[context.tabId]);
    return <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" data-retained-panel={context.tabId}>
      <label className="text-sm font-medium" htmlFor={'draft-'+context.tabId}>{window.labels.notes}</label>
      <textarea id={'draft-'+context.tabId} aria-label={context.tabId} value={draft} onChange={event=>setDraft(event.target.value)} className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm"/>
    </div>;
  }
  function Fixture({pane,onlyNote=false}){
    const [tabs,setTabs]=React.useState([{id:'notes-retained',kind:SINGLE},...(onlyNote?[]:[{id:'data-retained',kind:APP}])]);
    const [activeId,setActiveId]=React.useState('notes-retained');
    window.fixtureState={tabs,activeId};
    return <main id="launcher-fixture" className="fixed inset-0 flex min-h-0 min-w-0 justify-center bg-muted/30 text-foreground">
      <PanelArea projectPath={null} bucket="launcher-browser" tabs={tabs} setTabs={setTabs} activeId={activeId} setActiveId={setActiveId}
        requestNonce={0} requestKind={null} width={pane} onClose={()=>{}} onResizeStart={()=>{}}/>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));let generation=0;let dispose=[];
  window.renderFixture=props=>{
    flushSync(()=>root.render(null));for(const remove of dispose)remove();dispose=[];
    window.mounts=[];window.unmounts=[];saveUILanguage(props.lang);document.documentElement.classList.toggle('dark',props.mode==='dark');
    window.labels={notes:props.lang==='zh'?'项目笔记':'Project notes',clear:translate(props.lang,'panels.launcher.clearSearch')};
    const register=(key,title,owner,singleton=true,internalOnly=false,icon=PanelsTopLeft)=>dispose.push(PANEL_REGISTRY.register({key,title:{kind:'literal',value:title},owner,icon,
      order:900+dispose.length,singleton,internalOnly,enabled:()=>true,render:context=><RetainedPanel context={context}/>}));
    register(SINGLE,window.labels.notes,{kind:'builtin'},true,false,NotebookPen);
    register(APP,props.lang==='zh'?'数据工作台':'Data workspace',{kind:'panel-app',appId:'fixture-data'});
    register(LINK,props.lang==='zh'?'Link 调研工作台':'Link research',{kind:'panel-app',appId:'fixture-link'},false,false,Link);
    for(let index=0;index<7;index++)register('launcher-collection-'+index,(props.lang==='zh'?'项目面板 ':'Project panel ')+(index+1),{kind:'panel-app',appId:'fixture-'+index});
    register('launcher-long',(props.lang==='zh'?'跨工作区资料整理与长名称面板':'Cross-workspace research and long panel title')+' '+('LongIdentifierWithoutSpaces'.repeat(7)),{kind:'panel-app',appId:'fixture-long'});
    register(LAST,props.lang==='zh'?'归档面板':'Archive panel',{kind:'panel-app',appId:'fixture-final'});
    register(INTERNAL,'Internal hidden entry',{kind:'builtin'},true,true,FolderTree);
    window.kinds={single:SINGLE,app:APP,link:LINK,internal:INTERNAL,last:LAST,launcher:PANEL_LAUNCHER_KIND};
    flushSync(()=>root.render(<I18nProvider key={++generation}><Fixture {...props}/></I18nProvider>));
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
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
  args: ["--disable-background-networking", "--disable-component-update", "--no-pings"],
});
const context = await browser.newContext({ reducedMotion: "reduce", serviceWorkers: "block" });
const failures = [],
  errors = [],
  blocked = [],
  reports = [];
await context.route("**/*", (route) => {
  if (route.request().url() === "http://panel-launcher.test/")
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
    });
  blocked.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("http://panel-launcher.test/");
const launcher = page.locator("[data-panel-launcher]");
const plus = page.locator('[data-panel-action="new-tab"]');
async function settle() {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}
async function reachable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  assert.ok(
    await locator.evaluate((node) => {
      const box = node.getBoundingClientRect(),
        hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.left >= 0 &&
        box.right <= window.innerWidth + 1 &&
        box.top >= 0 &&
        box.bottom <= window.innerHeight + 1 &&
        (hit === node || node.contains(hit))
      );
    }),
    label + ": keyboard/pointer control remains reachable",
  );
}
async function geometry(label) {
  const result = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    pane: document.querySelector('[data-theme-surface="panel"]').clientWidth,
    paneScroll: document.querySelector('[data-theme-surface="panel"]').scrollWidth,
    launcher: document.querySelector("[data-panel-launcher]").clientWidth,
    launcherScroll: document.querySelector("[data-panel-launcher]").scrollWidth,
  }));
  assert.ok(
    result.document <= result.viewport + 1 &&
      result.paneScroll <= result.pane + 1 &&
      result.launcherScroll <= result.launcher + 1,
    label + ": no horizontal overflow " + JSON.stringify(result),
  );
  for (const card of await launcher.locator("[data-panel-launcher-kind]").all())
    assert.ok(
      await card.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      label + ": long card labels stay within their card",
    );
  reports.push({ label, geometry: result });
}
async function preserved(label) {
  assert.equal(
    await page.locator('textarea[aria-label="notes-retained"]').inputValue(),
    "Preserved panel input",
    label + ": original input value retained",
  );
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('textarea[aria-label="notes-retained"]') === window.originalInput,
    ),
    label + ": original input DOM stays mounted",
  );
  assert.deepEqual(
    await page.evaluate(() => window.unmounts),
    [],
    label + ": no panel was unmounted",
  );
}
try {
  await page.setViewportSize({ width: 360, height: 360 });
  await page.evaluate((props) => window.renderFixture(props), {
    lang: "zh",
    mode: "light",
    pane: 320,
    onlyNote: true,
  });
  await plus.click();
  await settle();
  assert.ok(
    await launcher.getByRole("searchbox").evaluate((node) => node === document.activeElement),
    "Explicit plus focuses search",
  );
  const keyboardLauncherId = await page.evaluate(() => window.fixtureState.activeId);
  const keyboardLauncherTab = page.locator(`[role="tab"][id$="-tab-${keyboardLauncherId}"]`);
  const notesTab = page.locator('[role="tab"][id$="-tab-notes-retained"]');
  await notesTab.click();
  await notesTab.press("ArrowRight");
  await settle();
  assert.ok(
    await keyboardLauncherTab.evaluate((node) => node === document.activeElement),
    "ArrowRight to launcher retains tab-strip focus",
  );
  await keyboardLauncherTab.press("ArrowLeft");
  await settle();
  assert.ok(
    await notesTab.evaluate((node) => node === document.activeElement),
    "ArrowLeft returns to the real tab",
  );
  await notesTab.press("Delete");
  await settle();
  assert.ok(
    await keyboardLauncherTab.evaluate((node) => node === document.activeElement),
    "Deleting the neighboring real tab focuses the surviving launcher tab",
  );
  assert.equal(await page.getByRole("tab").count(), 1);
  for (const lang of ["zh", "en"])
    for (const mode of ["light", "dark"])
      for (const layout of [
        { width: 1100, height: 800, pane: 620, name: "wide" },
        { width: 360, height: 360, pane: 320, name: "narrow" },
      ]) {
        const label = `${lang}-${mode}-${layout.name}`;
        try {
          await page.setViewportSize({ width: layout.width, height: layout.height });
          await page.evaluate((props) => window.renderFixture(props), {
            lang,
            mode,
            pane: layout.pane,
          });
          const kinds = await page.evaluate(() => window.kinds),
            labels = await page.evaluate(() => window.labels);
          await page
            .getByRole("textbox", { name: "notes-retained", exact: true })
            .fill("Preserved panel input");
          await page.evaluate(() => {
            window.originalInput = document.querySelector('textarea[aria-label="notes-retained"]');
          });
          await plus.click();
          await settle();
          assert.equal(
            await page.getByRole("menu").count(),
            0,
            label + ": plus opens a page, without a dropdown menu",
          );
          assert.equal(await page.getByRole("tab").count(), 3);
          const first = await page.evaluate(() => window.fixtureState);
          assert.equal(first.tabs.find((tab) => tab.id === first.activeId).kind, kinds.launcher);
          const search = launcher.getByRole("searchbox");
          assert.ok(
            await search.evaluate((node) => node === document.activeElement),
            label + ": new launcher focuses search",
          );
          assert.equal(
            await page.locator(`[data-panel-id="${kinds.single}"]`).getAttribute("inert"),
            "",
          );
          await preserved(label);
          assert.deepEqual(
            await page.evaluate(() => window.mounts),
            ["notes-retained", "data-retained"],
            label + ": listing entries mounts none of them",
          );
          assert.equal(
            await launcher
              .locator(
                `[data-panel-launcher-kind="${kinds.internal}"],[data-panel-launcher-kind="subagent"]`,
              )
              .count(),
            0,
          );
          assert.equal(await launcher.locator('[data-panel-launcher-group="tools"]').count(), 1);
          assert.equal(await launcher.locator('[data-panel-launcher-group="panels"]').count(), 1);
          await geometry(label);
          await page.evaluate(() => document.activeElement?.blur());
          await page.locator('[data-theme-surface="panel"]').screenshot({
            path: path.join(output, `launcher-${label}.png`),
            animations: "disabled",
          });
          await page.getByRole("tab", { name: labels.notes, exact: true }).click();
          await settle();
          assert.equal(await launcher.getAttribute("inert"), "");
          assert.equal(
            await launcher.locator('input[type="search"]').isDisabled(),
            true,
            label + ": inactive launcher cannot receive input",
          );
          await plus.click();
          await settle();
          assert.deepEqual(
            await page.evaluate(() => window.fixtureState),
            first,
            label + ": reopening plus reuses its single launcher tab",
          );
          await reachable(
            launcher.locator(`[data-panel-launcher-kind="${kinds.last}"]`),
            label + "/last card",
          );
          await search.fill("  LINK  ");
          await settle();
          assert.equal(
            await launcher.locator("[data-panel-launcher-kind]").count(),
            1,
            label + ": trim/case-insensitive search filters entries",
          );
          await geometry(label + "/search");
          await page
            .locator('[data-theme-surface="panel"]')
            .screenshot({ path: path.join(output, `search-${label}.png`), animations: "disabled" });
          const link = launcher.locator(`[data-panel-launcher-kind="${kinds.link}"]`);
          await reachable(link, label + "/search result");
          await link.focus();
          await link.press("Enter");
          await settle();
          const selected = await page.evaluate(() => window.fixtureState);
          assert.equal(selected.tabs.length, 3);
          assert.equal(selected.tabs[2].kind, kinds.link);
          assert.notEqual(
            selected.tabs[2].id,
            first.activeId,
            label + ": selected entry replaces launcher with a new panel id",
          );
          assert.equal(selected.activeId, selected.tabs[2].id);
          assert.equal(await launcher.count(), 0);
          assert.ok(
            await page
              .locator('[role="tab"][aria-selected="true"]')
              .evaluate((node) => node === document.activeElement),
            label + ": keyboard selection focuses the new tab",
          );
          await preserved(label + "/pick");
          await plus.click();
          await settle();
          await launcher.getByRole("searchbox").fill(kinds.single);
          await settle();
          await launcher.locator(`[data-panel-launcher-kind="${kinds.single}"]`).click();
          await settle();
          assert.deepEqual(
            await page.evaluate(() => window.fixtureState),
            { tabs: selected.tabs, activeId: "notes-retained" },
            label + ": existing singleton focuses without duplication",
          );
          await preserved(label + "/singleton");
          assert.equal(
            await page.locator(`[data-panel-id="${kinds.link}"]`).getAttribute("inert"),
            "",
          );
          await plus.click();
          await settle();
          await launcher.getByRole("searchbox").fill("DefinitelyNoMatchingPanel");
          await settle();
          assert.equal(await launcher.locator("[data-panel-launcher-kind]").count(), 0);
          const clear = launcher.getByRole("button", { name: labels.clear, exact: true });
          await reachable(clear.last(), label + "/no result clear");
          await clear.last().click();
          await settle();
          assert.equal(await launcher.getByRole("searchbox").inputValue(), "");
          const currentId = await page.evaluate(() => window.fixtureState.activeId);
          const currentTab = page.locator(`[role="tab"][id$="-tab-${currentId}"]`);
          await currentTab.focus();
          await currentTab.press("Delete");
          await settle();
          assert.equal(
            await launcher.count(),
            0,
            label + ": normal tab keyboard close removes launcher",
          );
          await preserved(label + "/close");
        } catch (error) {
          failures.push({ label, error: error.stack });
          await page.screenshot({ path: path.join(output, `failure-${label}.png`) });
          if (process.argv.includes("--fail-fast")) throw error;
        }
      }
} catch (error) {
  if (!failures.length) failures.push({ error: error.stack });
} finally {
  await browser.close();
}
const result = {
  result: failures.length || errors.length || blocked.length ? "fail" : "pass",
  workflows: 8,
  keyboardCases: 1,
  geometryCases: reports.length,
  reports,
  failures,
  browserErrors: errors,
  blockedRequests: blocked,
  output,
};
await writeFile(path.join(output, "report.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (result.result !== "pass") process.exitCode = 1;
