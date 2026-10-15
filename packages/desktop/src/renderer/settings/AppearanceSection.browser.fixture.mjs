/* Production AppearanceSection, dialogs, toasts and CSS; every Host method is fixture-owned. */
/* global window, document, localStorage, getComputedStyle, StorageEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  "/tmp/codeshell-appearance-state-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {AppearanceSection} from './settings/AppearanceSection';
  import {I18nProvider} from './i18n/I18nProvider';
  import {saveUILanguage} from './uiLanguage';
  import {DialogProvider} from './ui/DialogProvider';
  import {ToastProvider} from './ui/ToastProvider';
  import {refreshInstalledThemes} from './installedThemes';
  import {saveTheme,applyTheme,saveThemePackId,applyThemePack} from './theme';
  const packs=[
    {id:'fixture-sky',name:'Fixture Sky',swatch:'205 65% 42%',colors:{light:{'--cs-primary':'205 65% 42%'},dark:{'--cs-primary':'205 65% 65%'}}},
    {id:'fixture-rose',name:'Fixture Rose',swatch:'335 65% 42%',colors:{light:{'--cs-primary':'335 65% 42%'},dark:{'--cs-primary':'335 65% 65%'}}},
  ];
  let installed=[],pending,immediate,uninstallCalls=[],logs=[];
  const listeners=new Set();
  window.fixture={
    get calls(){return uninstallCalls},get logs(){return logs},
    completeImmediately(success){immediate=success},
    finish(success){
      if(!pending)throw new Error('No pending fixture uninstall');
      const op=pending;pending=undefined;
      if(success){installed=installed.filter(pack=>pack.id!==op.id);for(const listener of [...listeners])listener();op.resolve();}
      else op.reject(new Error('Host rejected the fixture deletion'));
    },
  };
  window.codeshell={
    listInstalledThemes:async()=>structuredClone(installed),
    onThemesChanged:listener=>{listeners.add(listener);return ()=>listeners.delete(listener)},
    uninstallTheme:id=>{if(!packs.some(pack=>pack.id===id))throw new Error('Unexpected uninstall target');uninstallCalls.push(id);return new Promise((resolve,reject)=>{if(pending)throw new Error('Duplicate native uninstall');pending={id,resolve,reject};if(immediate!==undefined)queueMicrotask(()=>window.fixture.finish(immediate))})},
    pickAndPreviewTheme:async()=>{throw new Error('Unexpected native file picker')},
    log:(event,value)=>logs.push({event,value}),
  };
  let generation=0;
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=async({lang='zh',mode='light',active='fixture-sky'}={})=>{
    installed=structuredClone(packs);uninstallCalls=[];logs=[];pending=undefined;immediate=undefined;
    localStorage.clear();saveUILanguage(lang);saveTheme(mode);
    await refreshInstalledThemes();saveThemePackId(active);applyTheme(mode);applyThemePack(active);
    const current=++generation;
    root.render(<React.StrictMode><I18nProvider key={current}><DialogProvider><ToastProvider>
      <div data-fixture-generation={current} className='flex h-full min-h-0 flex-col bg-background text-foreground'>
        <header className='h-11 shrink-0 border-b border-border px-4 py-3 text-xs'>CodeShell · Appearance</header>
        <main id='appearance-scroll' className='min-h-0 flex-1 overflow-y-auto p-4'><AppearanceSection/></main>
      </div>
    </ToastProvider></DialogProvider></I18nProvider></React.StrictMode>);
    return current;
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "dataurl", ".wav": "empty" },
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
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const errors = [],
  blocked = [],
  reports = [];
async function mount(width = 1000, lang = "zh", mode = "light") {
  const page = await browser.newPage({
    viewport: { width, height: 600 },
    serviceWorkers: "block",
    colorScheme: mode,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://codeshell-appearance-fixture.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://codeshell-appearance-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const generation = await page.evaluate((options) => window.renderFixture(options), {
    lang,
    mode,
  });
  await page.locator(`[data-fixture-generation="${generation}"]`).waitFor();
  await page.locator('[data-theme-uninstall="fixture-sky"]').waitFor();
  return page;
}
const card = (page, id) => page.locator(`[data-theme-pack="${id}"]`);
const remove = (page) => page.locator('[data-theme-uninstall="fixture-sky"]');
async function selected(page, id) {
  assert.equal(await card(page, id).locator("button").first().getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("codeshell.theme-pack")), id);
}
async function reset(page) {
  const generation = await page.evaluate(() => window.renderFixture());
  await page.locator(`[data-fixture-generation="${generation}"]`).waitFor();
  await remove(page).waitFor();
}
async function confirm(page, waitForPendingFocus = true) {
  await remove(page).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.fixture.calls.length === 1);
  if (waitForPendingFocus)
    await page.waitForFunction(() => document.activeElement === document.body);
}
async function settleToast(page) {
  await page
    .locator(".pointer-events-auto")
    .last()
    .evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
}
try {
  for (const width of [390, 1000])
    for (const lang of ["zh", "en"])
      for (const mode of ["light", "dark"]) {
        const page = await mount(width, lang, mode);
        const controls = page.locator("[data-theme-mode]");
        assert.equal(await controls.count(), 3);
        assert.equal(
          await page
            .locator('[data-theme-mode][aria-pressed="true"]')
            .getAttribute("data-theme-mode"),
          mode,
        );
        assert.equal(
          await page
            .locator('[data-theme-mode][aria-pressed="true"] svg')
            .evaluate((el) => getComputedStyle(el).visibility),
          "visible",
        );
        const metrics = await page
          .locator("#appearance-scroll")
          .evaluate((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
        assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, "Appearance fits narrow width");
        reports.push({ width, lang, mode, ...metrics });
        await page.screenshot({ path: path.join(output, `modes-${width}-${lang}-${mode}.png`) });
        await page.locator('[data-theme-mode="system"]').click();
        assert.equal(
          await page
            .locator('[data-theme-mode][aria-pressed="true"]')
            .getAttribute("data-theme-mode"),
          "system",
        );
        await page.close();
      }
  const page = await mount();
  // Same-frame repeated taps cannot queue duplicate confirmation dialogs.
  await remove(page).focus();
  await remove(page).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-theme-uninstall") === "fixture-sky",
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);
  await selected(page, "fixture-sky");
  // Rejection retains the selection and its exact applied CSS, and unlocks retry.
  const beforeStyle = await page.locator("#cs-theme-pack").textContent();
  await confirm(page);
  assert.equal(await remove(page).isDisabled(), true);
  await selected(page, "fixture-sky");
  assert.equal(await page.locator("#cs-theme-pack").textContent(), beforeStyle);
  await page.evaluate(() => window.fixture.finish(false));
  await page.getByText(/无法删除主题包「Fixture Sky」/).waitFor();
  await settleToast(page);
  await selected(page, "fixture-sky");
  assert.equal(await page.locator("#cs-theme-pack").textContent(), beforeStyle);
  assert.equal(await remove(page).isDisabled(), false);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-theme-uninstall") === "fixture-sky",
  );
  await page.screenshot({ path: path.join(output, "deletion-rejected.png") });
  await page.keyboard.press("Tab");
  assert.equal(
    await card(page, "fixture-rose")
      .locator("button")
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
    "Retry focus preserves the natural next Tab target",
  );
  // A user can leave the deletion controls while Host is working.
  await reset(page);
  await confirm(page);
  const importButton = page.locator("[data-theme-import]");
  await importButton.focus();
  await page.evaluate(() => window.fixture.finish(false));
  await page.getByText(/无法删除主题包「Fixture Sky」/).waitFor();
  await settleToast(page);
  assert.equal(await importButton.evaluate((el) => el === document.activeElement), true);
  await page.screenshot({
    path: path.join(output, "deletion-rejected-preserves-outside-focus.png"),
  });
  // A successful Host event before promise completion still persists fallback.
  await reset(page);
  await confirm(page);
  await page.evaluate(() => window.fixture.finish(true));
  await card(page, "fixture-sky").waitFor({ state: "hidden" });
  await selected(page, "default");
  await page.waitForFunction(
    () =>
      document.activeElement?.closest("[data-theme-pack]")?.getAttribute("data-theme-pack") ===
      "default",
  );
  await page.getByText("已删除主题包「Fixture Sky」", { exact: true }).waitFor();
  await settleToast(page);
  await page.screenshot({ path: path.join(output, "deletion-success-focus.png") });
  // A quick Host response may finish before the dialog finishes returning focus.
  for (const success of [false, true]) {
    await reset(page);
    await page.evaluate((value) => window.fixture.completeImmediately(value), success);
    await confirm(page, false);
    await page.waitForFunction((removed) => {
      const focused = document.activeElement;
      return removed
        ? focused?.closest("[data-theme-pack]")?.getAttribute("data-theme-pack") === "default"
        : focused?.getAttribute("data-theme-uninstall") === "fixture-sky";
    }, success);
  }
  // Choosing another pack while deletion is pending must win over old closures.
  await reset(page);
  await confirm(page);
  await card(page, "fixture-rose").locator("button").first().click();
  await selected(page, "fixture-rose");
  await page.screenshot({ path: path.join(output, "deletion-pending-new-selection.png") });
  await page.evaluate(() => window.fixture.finish(true));
  await card(page, "fixture-sky").waitFor({ state: "hidden" });
  await selected(page, "fixture-rose");
  assert.ok((await page.locator("#cs-theme-pack").textContent()).includes("335 65% 42%"));
  assert.deepEqual(await page.evaluate(() => window.fixture.calls), ["fixture-sky"]);
  assert.equal(
    await card(page, "fixture-rose")
      .locator("button")
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
    "Successful deletion preserves focus on a newly selected theme",
  );
  await page.screenshot({ path: path.join(output, "deletion-keeps-new-selection.png") });
  // A storage event from another window also refreshes display-mode semantics.
  await page.evaluate(() => {
    localStorage.setItem("codeshell.theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "codeshell.theme" }));
  });
  await page.locator('[data-theme-mode="dark"][aria-pressed="true"]').waitFor();
  await page.close();
  const narrow = await mount(390, "en", "dark");
  await remove(narrow).click();
  await narrow.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await narrow.waitForFunction(() => window.fixture.calls.length === 1);
  await card(narrow, "fixture-rose").locator("button").first().click();
  await narrow.evaluate(() => window.fixture.finish(false));
  await narrow.getByText(/Could not remove theme pack “Fixture Sky”/).waitFor();
  await settleToast(narrow);
  await selected(narrow, "fixture-rose");
  assert.equal(await remove(narrow).isDisabled(), false);
  assert.equal(
    await card(narrow, "fixture-rose")
      .locator("button")
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
    "Rejected deletion preserves focus on a newly selected theme",
  );
  await narrow.screenshot({
    path: path.join(output, "deletion-rejected-new-selection-390-en-dark.png"),
  });
  await narrow.close();
  assert.deepEqual(errors, [], "No renderer exceptions");
  assert.deepEqual(blocked, [], "No network access");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        reports,
        keyboardRetryFocus: true,
        successFocus: true,
        preservesOutsideFocus: true,
        errors,
        blocked,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS Appearance cancellation, rejection, successful removal, concurrent selection, mode semantics and visual matrix: ${output}`,
  );
} finally {
  await browser.close();
}
