/* Production branch switching with owned Git replies and forbidden network. */
/* global window, document, requestAnimationFrame, Event, KeyboardEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  "/tmp/codeshell-branch-picker-qa";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {BranchPicker} from './chat/BranchPicker';import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';import {applyTheme,saveTheme} from './theme';import {translate} from './i18n/translate';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const repo=current=>({isRepo:true,current,branches:['main',...Array.from({length:45},(_,i)=>'feature-'+(i+1))]});
window.repo=repo;window.statusMode='clean';window.switchMode='hold';window.stashMode='hold';window.calls={read:[],status:[],switch:[],stash:[]};
window.codeshell={getProjectGitBranches:async project=>{window.calls.read.push(project);return repo('main')},getProjectGitStatus:project=>{window.calls.status.push(project);if(window.statusMode==='hold'){window.pendingStatus=deferred();return window.pendingStatus.promise}return Promise.resolve({clean:window.statusMode!=='dirty'})},switchProjectGitBranch:(project,branch)=>{window.calls.switch.push({project,branch});window.pendingSwitch=deferred();return window.pendingSwitch.promise},stashAndSwitchProjectGitBranch:(project,branch)=>{window.calls.stash.push({project,branch});window.pendingStash=deferred();return window.pendingStash.promise}};
function Fixture(){const [state,setState]=React.useState({projectId:'owned-project',cwd:'/owned-project',disabled:false});window.patch=patch=>setState(previous=>({...previous,...patch}));return <main className="fixed inset-0 flex flex-col justify-end gap-2 overflow-hidden p-3"><input aria-label="Outside field"/><div className="flex items-center gap-2"><button id="before">Before picker</button><BranchPicker {...state}/><button id="after">After picker</button></div></main>}
const root=createRoot(document.getElementById('root'));window.mount=({language,theme})=>{localStorage.clear();saveUILanguage(language);saveTheme(theme);applyTheme(theme);window.names={dialog:translate(language,'chat.branch.switchTitle'),cancel:translate(language,'chat.branch.cancel'),stash:translate(language,'chat.branch.stashAndSwitch')};root.render(<I18nProvider><Fixture/></I18nProvider>)};
`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
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
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
const errors = [],
  blocked = [],
  reports = [];
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const focused = (locator) => locator.evaluate((node) => document.activeElement === node);
const trigger = (page) => page.locator('button[aria-haspopup="dialog"]');
const popup = (page) => page.getByRole("dialog");
async function focusVisible(locator, label) {
  assert.equal(await focused(locator), true, `${label}: focused`);
  assert.equal(
    await locator.evaluate((node) => {
      const list = node.closest('[role="listbox"]') ?? node.closest('[role="dialog"]');
      const bounds = list.getBoundingClientRect();
      const target = node.getBoundingClientRect();
      const top = bounds.top + list.clientTop;
      const bottom = top + list.clientHeight;
      const hit = document.elementFromPoint(
        target.x + target.width / 2,
        target.y + target.height / 2,
      );
      return (
        target.top >= top - 1 && target.bottom <= bottom + 1 && (hit === node || node.contains(hit))
      );
    }),
    true,
    `${label}: visible and receives hits`,
  );
}
async function open(page) {
  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await popup(page).waitFor();
  await frames(page);
  await focusVisible(
    popup(page).getByRole("option", { name: "main", exact: true }),
    "Open focuses current branch",
  );
  return popup(page);
}
async function feature(page) {
  await open(page);
  await page.keyboard.press("ArrowDown");
  const option = popup(page).getByRole("option", { name: "feature-1", exact: true });
  await focusVisible(option, "ArrowDown focuses feature");
  await page.keyboard.press("Enter");
}
async function exercise(page, config) {
  const names = await page.evaluate(() => window.names);
  const menu = await open(page);
  const options = menu.getByRole("option");
  await page.keyboard.press("End");
  await frames(page);
  await focusVisible(options.last(), "End reveals last branch");
  await page.setViewportSize({ width: 320, height: 200 });
  await frames(page);
  await focusVisible(options.last(), "Resize reveals last branch");
  await page.keyboard.press("Home");
  await frames(page);
  await focusVisible(options.first(), "Home reveals main");
  const list = menu.getByRole("listbox");
  await list.evaluate((node) => {
    node.scrollTop = 200;
    node.dispatchEvent(new Event("scroll"));
  });
  await frames(page);
  assert.ok(
    (await list.evaluate((node) => node.scrollTop)) >= 199,
    "Anchoring preserves intentional wheel scroll",
  );
  await page.keyboard.press("End");
  await frames(page);
  await focusVisible(options.last(), "Keyboard restores visible selection after wheel scroll");
  await list.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await frames(page);
  await page.keyboard.press("End");
  await focusVisible(options.last(), "End reveals an already-focused branch after wheel scroll");
  await page.screenshot({
    path: path.join(output, `${config.language}-${config.theme}-keyboard.png`),
  });
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "hidden" });
  assert.equal(
    await focused(page.locator("#after")),
    true,
    "Forward Tab continues from composer trigger",
  );
  await open(page);
  await page.keyboard.press("Shift+Tab");
  await menu.waitFor({ state: "hidden" });
  assert.equal(
    await focused(page.locator("#before")),
    true,
    "Backward Tab continues from composer trigger",
  );
  await page.setViewportSize({ width: 760, height: 480 });
  await page.evaluate(() => (window.statusMode = "hold"));
  await feature(page);
  const row = menu.getByRole("option", { name: "feature-1", exact: true });
  await row.evaluate((node) => {
    node.click();
    node.click();
  });
  assert.equal(
    await page.evaluate(() => window.calls.status.length),
    1,
    "One status probe per pending activation",
  );
  assert.equal(await menu.getAttribute("aria-busy"), "true");
  assert.equal(await row.getAttribute("aria-disabled"), "true");
  await page.evaluate(() => window.pendingStatus.resolve({ clean: true }));
  await page.waitForFunction(() => window.calls.switch.length === 1);
  await row.evaluate((node) => {
    node.click();
    node.click();
  });
  assert.deepEqual(await page.evaluate(() => window.calls.switch), [
    { project: "owned-project", branch: "feature-1" },
  ]);
  await page.evaluate(() => window.pendingSwitch.reject(Error("Owned switch failed")));
  await menu.getByRole("alert").waitFor();
  await frames(page);
  assert.equal(await focused(row), true, "Failed switch retains option focus");
  assert.equal(await trigger(page).textContent(), "main", "Failed switch retains current branch");
  await page.evaluate(() => (window.statusMode = "clean"));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.calls.switch.length === 2);
  await page.evaluate(() => window.pendingSwitch.resolve(window.repo("feature-1")));
  await menu.waitFor({ state: "hidden" });
  await frames(page);
  assert.equal(await focused(trigger(page)), true, "Successful switch restores composer trigger");
  assert.equal(await trigger(page).textContent(), "feature-1");
  reports.push({ config, label: "keyboard-scroll-resize-tab-and-held-switch-failure-retry" });

  // Fresh project starts at main, with the same stable composer trigger.
  await page.evaluate(() => window.patch({ projectId: "dirty-project", cwd: "/dirty-project" }));
  await page.waitForFunction(
    () => document.querySelector('button[aria-haspopup="dialog"]')?.textContent === "main",
  );
  await page.evaluate(() => (window.statusMode = "dirty"));
  await feature(page);
  const cancel = menu.getByRole("button", { name: names.cancel, exact: true });
  const stash = menu.getByRole("button", { name: names.stash, exact: true });
  await cancel.waitFor();
  await frames(page);
  await focusVisible(cancel, "Dirty checkout focuses cancellation");
  await page.keyboard.press("Enter");
  await row.waitFor();
  await frames(page);
  await focusVisible(row, "Cancel restores proposed branch option");
  await page.keyboard.press("Enter");
  await cancel.waitFor();
  await frames(page);
  await page.keyboard.press("Tab");
  assert.equal(await focused(stash), true, "Dirty confirmation supports Tab to stash");
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "hidden" });
  assert.equal(
    await focused(page.locator("#after")),
    true,
    "Confirmation Tab exits through composer neighbor",
  );
  await feature(page);
  await cancel.waitFor();
  await frames(page);
  await page.keyboard.press("Tab");
  await page.setViewportSize({ width: 320, height: 200 });
  await frames(page);
  await focusVisible(stash, "Resize keeps focused stash action visible");
  await page.screenshot({
    path: path.join(output, `${config.language}-${config.theme}-confirmation.png`),
  });
  await page.setViewportSize({ width: 760, height: 480 });
  await frames(page);
  await stash.evaluate((node) => {
    node.click();
    node.click();
  });
  assert.deepEqual(await page.evaluate(() => window.calls.stash), [
    { project: "dirty-project", branch: "feature-1" },
  ]);
  await page.evaluate(() => window.pendingStash.reject(Error("Owned stash failed")));
  await menu.getByRole("alert").waitFor();
  await frames(page);
  assert.equal(await focused(stash), true, "Failed stash preserves retry focus");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.calls.stash.length === 2);
  await page.evaluate(() => window.pendingStash.resolve(window.repo("feature-1")));
  await menu.waitFor({ state: "hidden" });
  await frames(page);
  assert.equal(await focused(trigger(page)), true, "Successful stash restores trigger");
  reports.push({ config, label: "dirty-cancel-and-held-stash-failure-retry" });

  await page.evaluate(() =>
    window.patch({ projectId: "cancellation-project", cwd: "/cancellation-project" }),
  );
  await page.waitForFunction(
    () => document.querySelector('button[aria-haspopup="dialog"]')?.textContent === "main",
  );
  await page.evaluate(() => (window.statusMode = "hold"));
  await feature(page);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  const outside = page.getByRole("textbox", { name: "Outside field" });
  await outside.focus();
  const switchCount = await page.evaluate(() => window.calls.switch.length);
  await page.evaluate(() => window.pendingStatus.resolve({ clean: true }));
  await frames(page);
  assert.equal(
    await page.evaluate(() => window.calls.switch.length),
    switchCount,
    "Dismissal cancels a pending status probe before checkout",
  );
  assert.equal(await focused(outside), true, "Late reply preserves outside focus");
  assert.equal(await menu.count(), 0, "Late reply does not reopen picker");
  await open(page);
  await options.first().evaluate((node) => {
    for (const key of ["Escape", "Enter", "ArrowDown"])
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true }),
      );
  });
  assert.equal(await menu.count(), 1, "IME does not close or activate a branch");
  assert.equal(await page.evaluate(() => window.calls.switch.length), switchCount);
  await outside.focus();
  await menu.waitFor({ state: "hidden" });
  await open(page);
  await page.evaluate(() => window.patch({ disabled: true }));
  await menu.waitFor({ state: "hidden" });
  await outside.focus();
  await page.evaluate(() => window.patch({ disabled: false }));
  await frames(page);
  assert.equal(await menu.count(), 0);
  assert.equal(await focused(outside), true, "Re-enable does not reopen or steal focus");

  await page.evaluate(() => (window.statusMode = "clean"));
  await feature(page);
  await page.waitForFunction((count) => window.calls.switch.length === count + 1, switchCount);
  await outside.focus();
  await menu.waitFor({ state: "hidden" });
  await page.evaluate(() => window.pendingSwitch.resolve(window.repo("feature-1")));
  await frames(page);
  assert.equal(
    await focused(outside),
    true,
    "Completing an active checkout preserves relinquished focus",
  );
  assert.equal(await menu.count(), 0);
  reports.push({ config, label: "dismissal-ime-disable-and-async-focus-ownership" });
}
let lastPage;
try {
  for (const language of ["zh", "en"])
    for (const theme of ["light", "dark"]) {
      const config = { language, theme };
      const context = await browser.newContext({
        viewport: { width: 760, height: 480 },
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) => {
        if (route.request().url() === "http://branch-picker-owned.test/")
          return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
        blocked.push(route.request().url());
        return route.abort();
      });
      const page = (lastPage = await context.newPage());
      page.setDefaultTimeout(6000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("http://branch-picker-owned.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: built.outputFiles[0].text });
      await page.evaluate((config) => window.mount(config), config);
      await trigger(page).waitFor();
      await exercise(page, config);
      await context.close();
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ output, scenarios: reports.length, errors, blocked }));
} catch (error) {
  if (lastPage && !lastPage.isClosed())
    await lastPage.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ sourceDesktop, reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
