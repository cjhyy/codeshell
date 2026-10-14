/* Real-browser layout/navigation regression; bundles production SettingsPage and CSS in memory. */
/* global window, document, Event, getComputedStyle */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {SettingsPage} from './settings/SettingsPage';
  import {I18nProvider} from './i18n/I18nProvider';
  import {DialogProvider} from './ui/DialogProvider';
  import {saveUILanguage} from './uiLanguage';
  const root=createRoot(document.getElementById('root'));
  let generation=0;
  let pending=[];
  let catalogPending=[];
  const catalog=Array.from({length:6},(_,index)=>({id:'provider-'+index,tag:'text',
    displayName:'Fixture provider '+index,needsKey:false,modelPresets:[{value:'one'}]}));
  const settings={permissionMode:'default',
    modelConnections:[{id:'fixture',catalogId:'provider-0',tag:'text',model:'one'}],
    credentials:[],defaults:{text:'fixture'}};
  const status={enabled:false,active:false,driverAvailable:true,packaged:false,restartRequired:false,
    permissions:{supported:true,accessibility:'denied',screenRecording:'denied',
      screenRequestAvailable:false,restartRequired:false}};
  window.fixture={statusCalls:0,unsafeCalls:0,catalogCalls:0,holdCatalog:false,
    releaseStatus(){const callbacks=pending;pending=[];callbacks.forEach(resolve=>resolve(structuredClone(status)));},
    releaseCatalog(){window.fixture.holdCatalog=false;const callbacks=catalogPending;catalogPending=[];
      callbacks.forEach(resolve=>resolve(structuredClone(catalog)));}};
  const unsafe=async()=>{window.fixture.unsafeCalls++;throw new Error('Unexpected native action');};
  window.codeshell={
    getSettings:async()=>structuredClone(settings),
    getConfigurationSettings:async()=>structuredClone(settings),
    getModelCatalog:()=>{window.fixture.catalogCalls++;
      return window.fixture.holdCatalog?new Promise(resolve=>catalogPending.push(resolve)):Promise.resolve(structuredClone(catalog));},
    getCatalogOrigins:async()=>Object.fromEntries(catalog.map(entry=>[entry.id,'user'])),
    getUpdaterStatus:async()=>({kind:'idle'}),
    onUpdaterStatus:()=>()=>{},
    getAppVersion:async()=>'fixture',
    computerUse:{
      status:()=>{window.fixture.statusCalls++;return new Promise(resolve=>pending.push(resolve));},
      setEnabled:unsafe,requestPermission:unsafe,openSettings:unsafe,restart:unsafe,
    },
  };
  window.renderFixture=(lang,project=false,initialModule='general')=>{
    window.localStorage.clear();
    saveUILanguage(lang);
    root.render(<I18nProvider key={++generation}><DialogProvider>
      <SettingsPage activeProjectPath={null} initialProjectPath={project?'/fixture':null}
        initialModule={initialModule}
        projects={[{id:'fixture',path:'/fixture',name:'Fixture',addedAt:1,pinned:false}]}
        sessionIndices={{}} onRestoreArchivedSession={()=>{}} onDeleteArchivedSession={()=>{}}
        isMac={false} isFullscreen={false} onBack={()=>{}}/>
    </DialogProvider></I18nProvider>);
  };
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
  define: { "process.env.NODE_ENV": '"development"' },
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
  args: ["--disable-features=OverlayScrollbar"],
});
const screenshotDirectory = process.argv.find((arg) => arg.startsWith("--screenshots="))?.slice(14);
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const metrics = (page) =>
  page.locator("main").evaluate((main) => {
    const header = main.firstElementChild.firstElementChild.getBoundingClientRect();
    return {
      clientWidth: main.clientWidth,
      headerX: header.x,
      headerWidth: header.width,
      scrollTop: main.scrollTop,
      overflowing: main.scrollHeight > main.clientHeight,
      mainBottom: main.getBoundingClientRect().bottom,
      bodyHeight: document.documentElement.scrollHeight,
      bodyWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
const stableWidth = (before, after, context) => {
  for (const key of ["clientWidth", "headerX", "headerWidth"]) {
    assert.equal(after[key], before[key], `${context}: ${key} must stay stable`);
  }
};
const bounded = (value, context) => {
  assert.ok(value.mainBottom <= value.viewportHeight + 1, `${context}: main stays in the window`);
  assert.ok(value.bodyHeight <= value.viewportHeight + 1, `${context}: body does not scroll`);
  assert.ok(value.bodyWidth <= value.viewportWidth + 1, `${context}: no horizontal page overflow`);
};
try {
  for (const width of [1000, 390]) {
    for (const lang of ["zh", "en"]) {
      const labels =
        lang === "zh"
          ? {
              computer: "电脑操控",
              general: "常规",
              search: "搜索设置…",
              navigation: "设置导航",
              project: "项目概览",
            }
          : {
              computer: "Computer use",
              general: "General",
              search: "Search settings…",
              navigation: "Settings navigation",
              project: "Project overview",
            };
      const page = await browser.newPage({ viewport: { width, height: 500 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // No renderer dependency can reach the network or the operator's native bridge.
      await page.route("**/*", (route) => {
        if (route.request().url() === "http://settings.test/") {
          return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
        }
        return route.abort();
      });
      await page.goto("http://settings.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((lang) => window.renderFixture(lang), lang);
      await page.getByRole("heading", { level: 1, name: labels.general, exact: true }).waitFor();
      await page.getByText("fixture", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.fixture.statusCalls), 0);
      assert.equal(await page.locator("#computer-use-settings-title").count(), 0);

      const search = page.getByRole("searchbox").filter({ visible: true });
      await search.fill(labels.computer);
      const navigation = page.getByRole("navigation", { name: labels.navigation, exact: true });
      await navigation.getByRole("button", { name: labels.computer, exact: true }).click();
      await page.getByRole("heading", { level: 1, name: labels.computer, exact: true }).waitFor();
      await page.waitForFunction(() => window.fixture.statusCalls === 1);
      assert.equal(
        await page.locator("main").evaluate((main) => getComputedStyle(main).scrollbarGutter),
        "stable",
        "Content reserves space for classic scrollbars before delayed data arrives",
      );
      const loading = await metrics(page);
      await page.evaluate(() => window.fixture.releaseStatus());
      await page.getByRole("switch").waitFor();
      const loaded = await metrics(page);
      console.log(
        `${width}/${lang}: header ${loading.headerWidth}→${loaded.headerWidth}, ` +
          `client ${loading.clientWidth}→${loaded.clientWidth}, overflow ${loading.overflowing}→${loaded.overflowing}`,
      );
      stableWidth(loading, loaded, `${width}/${lang}: delayed status`);
      bounded(loaded, `${width}/${lang}`);
      assert.ok(loaded.overflowing, "The supported permission card exercises a scrolling module");

      await page.locator("main").evaluate((main) => {
        main.scrollTop = Math.min(80, main.scrollHeight - main.clientHeight);
      });
      const scrolled = await metrics(page);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() => window.fixture.statusCalls === 2);
      assert.equal(await page.getByRole("switch").count(), 1, "Refresh preserves the status card");
      stableWidth(scrolled, await metrics(page), "Pending focus refresh");
      assert.equal((await metrics(page)).scrollTop, scrolled.scrollTop);
      await page.evaluate(() => window.fixture.releaseStatus());
      await page.waitForFunction(() => !document.querySelector("section button")?.disabled);
      stableWidth(scrolled, await metrics(page), "Completed focus refresh");
      assert.equal((await metrics(page)).scrollTop, scrolled.scrollTop);
      if (screenshotDirectory && lang === "zh") {
        await page.locator("main").evaluate((main) => {
          main.scrollTop = 0;
        });
        await page.screenshot({
          path: path.join(screenshotDirectory, `computer-use-${width}.png`),
        });
      }

      if (width > 720) {
        const selected = navigation.getByRole("button", { name: labels.computer, exact: true });
        assert.equal(
          await selected.evaluate(
            (button) => getComputedStyle(button.closest("nav").lastElementChild).scrollbarGutter,
          ),
          "stable",
          "Navigation also reserves its scrollbar gutter while search filters long lists",
        );
        const longNavWidth = (await selected.boundingBox()).width;
        await search.fill(labels.computer);
        assert.equal((await selected.boundingBox()).width, longNavWidth, "Search keeps nav widths");
        await selected.click();
      } else {
        const picker = page.getByRole("combobox", { name: labels.navigation, exact: true });
        await picker.click();
        await page.getByRole("option", { name: labels.general, exact: true }).click();
        await page.getByRole("heading", { level: 1, name: labels.general, exact: true }).waitFor();
        await picker.click();
        await page.getByRole("option", { name: labels.computer, exact: true }).click();
        await page.getByRole("heading", { level: 1, name: labels.computer, exact: true }).waitFor();
        await page.evaluate(() => window.fixture.releaseStatus());
        await page.getByRole("switch").waitFor();
      }

      await page.setViewportSize({ width, height: 360 });
      bounded(await metrics(page), `${width}/${lang}: short window`);

      for (const module of ["config", "model-catalog"]) {
        await page.evaluate(({ lang, module }) => window.renderFixture(lang, false, module), {
          lang,
          module,
        });
        const firstPanel = page.locator("main fieldset").first();
        const firstCard = page.locator("main article").first();
        await firstCard.waitFor();
        await page.waitForFunction(
          () => document.querySelector("main fieldset")?.getAttribute("aria-busy") === "false",
        );
        await page.locator("main").evaluate((main) => {
          main.scrollTop = 80;
        });
        const beforeRefresh = await firstCard.boundingBox();
        const scrollBeforeRefresh = (await metrics(page)).scrollTop;
        const previousCalls = await page.evaluate(() => {
          window.fixture.holdCatalog = true;
          const count = window.fixture.catalogCalls;
          window.dispatchEvent(new Event("codeshell:settings-changed"));
          return count;
        });
        await page.waitForFunction(
          (previous) => window.fixture.catalogCalls > previous,
          previousCalls,
        );
        await firstPanel.locator('[role="status"]').waitFor();
        assert.deepEqual(
          await firstCard.boundingBox(),
          beforeRefresh,
          `${module}: pending refresh keeps card geometry`,
        );
        assert.equal(
          (await metrics(page)).scrollTop,
          scrollBeforeRefresh,
          `${module}: pending refresh keeps scroll`,
        );
        await page.evaluate(() => window.fixture.releaseCatalog());
        await page.waitForFunction(
          () => document.querySelector("main fieldset")?.getAttribute("aria-busy") === "false",
        );
        assert.deepEqual(
          await firstCard.boundingBox(),
          beforeRefresh,
          `${module}: completed refresh keeps card geometry`,
        );
        assert.equal(
          (await metrics(page)).scrollTop,
          scrollBeforeRefresh,
          `${module}: completed refresh keeps scroll`,
        );
        bounded(await metrics(page), `${width}/${lang}: ${module}`);
        console.log(
          `${width}/${lang}: ${module} card y=${beforeRefresh.y} stays stable during refresh`,
        );
      }

      await page.evaluate((lang) => window.renderFixture(lang, true, "computer-use"), lang);
      await page.getByRole("heading", { level: 1, name: labels.project, exact: true }).waitFor();
      const callsBeforeProject = await page.evaluate(() => window.fixture.statusCalls);
      assert.equal(
        await page.getByRole("button", { name: labels.computer, exact: true }).count(),
        0,
        "Project navigation and overview omit machine-wide computer controls",
      );
      if (width <= 720) {
        await page.getByRole("combobox", { name: labels.navigation, exact: true }).click();
        assert.equal(
          await page.getByRole("option", { name: labels.computer, exact: true }).count(),
          0,
        );
        await page.keyboard.press("Escape");
      }
      await search.fill(labels.computer);
      assert.equal(
        await page.getByRole("button", { name: labels.computer, exact: true }).count(),
        0,
      );
      assert.equal(await page.evaluate(() => window.fixture.statusCalls), callsBeforeProject);
      assert.equal(await page.evaluate(() => window.fixture.unsafeCalls), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log("PASS: settings computer-use navigation and stable layout (desktop/mobile, zh/en)");
} finally {
  await browser.close();
}
