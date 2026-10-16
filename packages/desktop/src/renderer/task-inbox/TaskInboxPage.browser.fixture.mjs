/* Production Task center and CSS; every bridge method is fixture-owned. */
/* global document, window */
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
const tailwind = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwind("@tailwindcss/node");
const { Scanner } = tailwind("@tailwindcss/oxide");
const output = process.env.CODESHELL_TASKS_QA_DIR || "/tmp/codeshell-task-center-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {TaskInboxPage} from './task-inbox/TaskInboxPage';
  import {I18nProvider} from './i18n/I18nProvider';
  const records=Array.from({length:14},(_,i)=>({schemaVersion:1,taskKey:'job:'+i,
    source:['background-job','session','background-shell'][i%3],sourceId:String(i),
    ...(i%3===1?{automationId:'owned-schedule-'+i}:{}),
    title:'Review task '+(i+1),status:i===0?'waiting':'running',
    summary:'Review layout, keyboard navigation and recoverable errors.',
    workspacePath:i%2?'/work/very-long-project-name-without-spaces':'/work/project',
    artifacts:[],capabilities:['open'],createdAt:Date.UTC(2026,9,15,8),updatedAt:Date.UTC(2026,9,15,8),sourceRevision:'v1'}));
  records.push({...records[0],taskKey:'ordinary-session',source:'external-runtime',sourceId:'ordinary-session',title:'Ordinary foreground conversation'});
  window.codeshell={taskInbox:{list:async()=>({version:1,records,errors:[]}),
    onChanged:()=>()=>{},act:async input=>({status:'ok'})}};
  const root=createRoot(document.getElementById('root'));
  window.mount=({lang,dark})=>{
    localStorage.setItem('codeshell.uiLanguage',lang);
    document.documentElement.classList.toggle('dark',dark);
    root.render(<I18nProvider key={lang+dark}>
      <div className='flex h-full min-h-0 flex-col'>
        <header className='h-11 shrink-0 border-b border-border px-3 py-3 text-xs'>CodeShell</header>
        <div className='min-h-0 flex-1'>
          <TaskInboxPage onOpenTaskInboxRecord={record=>{window.opened=record.taskKey}}/>
        </div>
      </div>
    </I18nProvider>);
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty" },
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
const reports = [];
const errors = [];
try {
  for (const lang of ["zh", "en"]) {
    for (const viewport of [
      { width: 320, height: 360 },
      { width: 390, height: 360 },
      { width: 390, height: 540 },
      { width: 480, height: 540 },
      { width: 760, height: 540 },
      { width: 1280, height: 720 },
      { width: 1280, height: 360 },
    ]) {
      const page = await browser.newPage({ viewport, serviceWorkers: "block" });
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        route.request().url() === "http://codeshell-tasks.test/"
          ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
          : route.abort(),
      );
      await page.goto("http://codeshell-tasks.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((props) => window.mount(props), { lang, dark: lang === "en" });
      await page.getByRole("article").first().waitFor();
      const first = await page.getByRole("article").first().boundingBox();
      assert.ok(first.y < viewport.height - 90, "The first task is visible below compact filters");
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        "No horizontal page overflow",
      );
      const filters = page.getByRole("button", {
        name: lang === "zh" ? "筛选" : "Filters",
        exact: true,
      });
      assert.equal(await filters.isVisible(), viewport.width < 1000);
      reports.push({ lang, viewport, first });
      await page.screenshot({
        path: path.join(output, `tasks-${lang}-${viewport.width}x${viewport.height}.png`),
      });

      if (viewport.width === 390 && viewport.height === 360) {
        const search = page.getByRole("searchbox");
        await search.fill("Review task 1");
        assert.equal(await page.getByRole("article").count(), 6);
        await filters.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", {
          name: lang === "zh" ? "筛选" : "Filters",
          exact: true,
        });
        await dialog.waitFor();
        const bounds = await dialog.boundingBox();
        assert.ok(
          bounds.y >= 10 && bounds.y + bounds.height <= viewport.height - 10,
          "Filters fit a short viewport",
        );
        await dialog
          .getByRole("combobox", { name: lang === "zh" ? "来源" : "Source", exact: true })
          .click();
        await page
          .getByRole("option", {
            name: lang === "zh" ? "后台任务" : "Background task",
            exact: true,
          })
          .click();
        assert.equal(await page.getByRole("article").count(), 3);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() =>
          /^(筛选|Filters)\s*1$/.test(document.activeElement?.textContent ?? ""),
        );
        assert.ok(
          await page
            .getByRole("button", { name: /^(筛选|Filters).*1$/ })
            .evaluate((node) => document.activeElement === node),
        );
        await page.getByRole("button", { name: /^(筛选|Filters).*1$/ }).click();
        await dialog
          .getByRole("button", { name: lang === "zh" ? "清除筛选" : "Clear filters", exact: true })
          .click();
        assert.equal(
          await search.inputValue(),
          "Review task 1",
          "Clearing advanced filters preserves search",
        );
        assert.equal(await page.getByRole("article").count(), 6);
        await page.setViewportSize({ width: 1280, height: 540 });
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("type") === "search");
        assert.ok(
          await search.evaluate((node) => document.activeElement === node),
          "Resizing returns focus to a visible field",
        );
        await search.fill("");
        assert.equal(await page.getByRole("article").count(), 14);
        await page.setViewportSize(viewport);
        const firstCard = page.getByRole("article").first();
        const open = firstCard.getByRole("button", { name: /^(打开来源|Open source)/ });
        await open.focus();
        const action = await open.boundingBox();
        assert.ok(
          action.y >= 44 && action.y + action.height <= viewport.height,
          "Keyboard scrolling reaches task actions",
        );
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => window.opened === "job:0");
      }
      await page.close();
    }
  }
  assert.deepEqual(errors, [], "No browser errors");
  await writeFile(path.join(output, "report.json"), JSON.stringify(reports, null, 2));
  console.log(
    JSON.stringify({ result: "pass", layoutCases: reports.length, browserErrors: errors, output }),
  );
} finally {
  await browser.close();
}
