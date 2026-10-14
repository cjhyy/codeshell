/* Production context menus across themed sidebar boundaries and modal drawers. */
/* global window, document, getComputedStyle */
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
const output = process.env.CODESHELL_CONTEXT_MENU_QA_DIR || "/tmp/codeshell-context-menu-qa";
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {ContextMenu} from './ui/ContextMenu';
  import {ResponsiveSidebar} from './app/ResponsiveSidebar';
  import {AppShell} from './app/AppShell';
  import {saveUILanguage} from './uiLanguage';
  const labels={
    zh:['编辑项目文件夹','不可用的操作','项目配置','置顶项目','在「访达」中显示项目文件夹','重命名项目','归档对话','移除项目'],
    en:['Edit project folders','Unavailable action','Project configuration','Pin project','Reveal project folder in Finder','Rename project','Archive conversations','Remove project'],
  };
  const ids=['edit','disabled','config','pin','reveal','rename','archive','remove'];
  function Fixture({narrow,lang,long}) {
    const [open,setOpen]=React.useState(true);
    const [point,setPoint]=React.useState(null);
    const toggleRef=React.useRef(null);
    const sidebarRef=React.useRef(null);
    const openMenu=event=>{
      event.preventDefault();
      const rect=event.currentTarget.getBoundingClientRect();
      setPoint(long?{x:window.innerWidth-2,y:window.innerHeight-2}:{x:rect.left,y:rect.bottom+2});
    };
    const items=long?Array.from({length:32},(_,index)=>({
      label:index===0?'LongProjectFolderName'.repeat(5):index===31?labels[lang][4]:labels[lang][index%labels[lang].length]+' '+index,
      onClick:()=>window.actions.push('long-'+index),
    })):labels[lang].map((label,index)=>({label,disabled:index===1,onClick:()=>window.actions.push(ids[index])}));
    return <AppShell platformClass="" sidebarCollapsed={false}>
      <header className="flex h-11 shrink-0 items-center px-3">
        <button id="drawer-toggle" ref={toggleRef} onClick={()=>setOpen(true)}>Navigation</button>
      </header>
      <div className="flex min-h-0 flex-1">
        <ResponsiveSidebar narrow={narrow} open={open} onClose={()=>{setOpen(false);window.actions.push('drawer-close')}} onAfterClose={()=>{}} toggleRef={toggleRef}>
          <aside ref={sidebarRef} data-theme-surface="sidebar" className="relative flex h-full w-60 max-w-full shrink-0 flex-col border-r border-border/70">
            <div className="flex justify-end px-4 pt-10">
              <button id="menu-opener" className="h-8 w-8 rounded-md bg-muted" onClick={openMenu} onContextMenu={openMenu}>…</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">codeshell project</div>
            <button id="sidebar-outside" className="m-3 h-8" onClick={()=>{}}>Other sidebar action</button>
            {point&&<ContextMenu x={point.x} y={point.y} items={items} onClose={()=>setPoint(null)} container={sidebarRef.current?.closest('[role="dialog"]')}/>}
          </aside>
        </ResponsiveSidebar>
        <main data-theme-surface="chat" className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-muted p-8">
          <button id="main-outside" className="self-end" onClick={()=>{}}>Other main action</button>
        </main>
      </div>
    </AppShell>;
  }
  const root=createRoot(document.getElementById('root'));
  window.actions=[];
  window.renderFixture=props=>{
    window.actions=[];saveUILanguage(props.lang);
    root.render(<Fixture key={JSON.stringify(props)} {...props}/>);
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
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
let scenarios = 0;
let viewportChecks = 0;

async function waitFocused(locator, label) {
  await locator
    .page()
    .waitForFunction(
      (element) => document.activeElement === element,
      await locator.elementHandle(),
    );
  assert.ok(await locator.evaluate((element) => document.activeElement === element), label);
}

async function fits(menu, label) {
  await menu.page().waitForFunction(
    (element) => {
      const rect = element.getBoundingClientRect();
      return (
        getComputedStyle(element).visibility === "visible" &&
        rect.left >= 9 &&
        rect.top >= 9 &&
        rect.right <= window.innerWidth - 9 &&
        rect.bottom <= window.innerHeight - 9
      );
    },
    await menu.elementHandle(),
  );
  assert.ok(
    await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    `${label}: menu text has no horizontal overflow`,
  );
}

async function hitAcross(item, label) {
  await item.scrollIntoViewIfNeeded();
  const hits = await item.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [rect.left + 5, rect.left + rect.width / 2, rect.right - 5].map((x) => {
      const hit = document.elementFromPoint(x, rect.top + rect.height / 2);
      return { x, usable: element === hit || element.contains(hit), hit: hit?.tagName };
    });
  });
  assert.ok(
    hits.every((hit) => hit.usable),
    `${label}: full row receives hits ${JSON.stringify(hits)}`,
  );
}

async function openMenu(page, rightClick = false) {
  const opener = page.locator("#menu-opener");
  await opener.focus();
  await opener.click({ button: rightClick ? "right" : "left" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await fits(menu, "open menu");
  await waitFocused(menu.getByRole("menuitem").first(), "First enabled action gets focus");
  return menu;
}

try {
  for (const lang of ["zh", "en"]) {
    for (const narrow of [false, true]) {
      for (const long of [false, true]) {
        const mode = narrow ? "drawer" : "desktop";
        const label = `${mode}/${lang}/${long ? "long" : "project"}`;
        const viewport = narrow ? { width: 520, height: 650 } : { width: 1000, height: 760 };
        const page = await browser.newPage({ viewport });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) =>
          route.request().url() === "http://context-menu.test/"
            ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
            : route.abort(),
        );
        await page.goto("http://context-menu.test/");
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate((props) => window.renderFixture(props), { narrow, lang, long });
        const menu = await openMenu(page);
        const opener = page.locator("#menu-opener");
        assert.ok(
          await menu.evaluate((element) => !element.closest('[data-theme-surface="sidebar"]')),
          `${label}: menu escapes the themed sidebar stacking context`,
        );
        assert.equal(
          await menu.evaluate((element) => Boolean(element.closest('[role="dialog"]'))),
          narrow,
          `${label}: menu retains its modal focus and pointer boundary`,
        );
        if (!long) {
          const sidebar = await page.locator('[data-theme-surface="sidebar"]').boundingBox();
          const menuBox = await menu.boundingBox();
          assert.ok(
            menuBox.x + menuBox.width > sidebar.x + sidebar.width + 40,
            `${label}: regression crosses the sidebar right boundary`,
          );
          for (const item of await menu.getByRole("menuitem").all()) {
            await hitAcross(item, label);
          }
          await page.screenshot({ path: path.join(output, `${mode}-${lang}.png`) });
          const reveal = menu.getByRole("menuitem").nth(4);
          const revealBox = await reveal.boundingBox();
          await reveal.click({ position: { x: revealBox.width - 5, y: revealBox.height / 2 } });
          await menu.waitFor({ state: "hidden" });
          assert.deepEqual(await page.evaluate(() => window.actions), ["reveal"]);
          await waitFocused(opener, `${label}: pointer action restores the opener`);
          if (narrow) assert.ok(await page.getByRole("dialog").isVisible());

          await openMenu(page, true);
          const choices = menu.getByRole("menuitem");
          await page.keyboard.press("ArrowDown");
          await waitFocused(choices.nth(2), `${label}: ArrowDown skips disabled actions`);
          await page.keyboard.press("End");
          await waitFocused(choices.last(), `${label}: End focuses the last action`);
          await page.keyboard.press("ArrowDown");
          await waitFocused(choices.first(), `${label}: ArrowDown wraps`);
          await page.keyboard.press("ArrowUp");
          await waitFocused(choices.last(), `${label}: ArrowUp wraps`);
          await page.keyboard.press("Home");
          await waitFocused(choices.first(), `${label}: Home returns to the first action`);
          await page.keyboard.press("Enter");
          await menu.waitFor({ state: "hidden" });
          assert.deepEqual(await page.evaluate(() => window.actions), ["reveal", "edit"]);
          await waitFocused(opener, `${label}: keyboard action restores the opener`);

          await openMenu(page);
          const outside = page.locator(narrow ? "#sidebar-outside" : "#main-outside");
          await outside.click();
          await menu.waitFor({ state: "hidden" });
          await waitFocused(outside, `${label}: outside click retains its target focus`);
          if (narrow) assert.ok(await page.getByRole("dialog").isVisible());

          await openMenu(page);
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "hidden" });
          await waitFocused(opener, `${label}: Escape restores the menu opener`);
          if (narrow) {
            assert.ok(await page.getByRole("dialog").isVisible(), "First Escape keeps drawer open");
            await page.keyboard.press("Escape");
            await page.getByRole("dialog").waitFor({ state: "hidden" });
            await waitFocused(
              page.locator("#drawer-toggle"),
              "Second Escape restores drawer toggle",
            );
            assert.deepEqual(await page.evaluate(() => window.actions), [
              "reveal",
              "edit",
              "drawer-close",
            ]);
          }
        } else {
          for (const resized of [
            { width: 390, height: 320 },
            { width: 220, height: 200 },
            { width: 1280, height: 760 },
          ]) {
            await page.setViewportSize(resized);
            await fits(menu, `${label}/${resized.width}`);
            await hitAcross(menu.getByRole("menuitem").last(), `${label}/${resized.width}/last`);
            viewportChecks++;
          }
          await menu.getByRole("menuitem").last().click();
          await menu.waitFor({ state: "hidden" });
          assert.deepEqual(await page.evaluate(() => window.actions), ["long-31"]);
          await waitFocused(opener, `${label}: scrolled last action restores the opener`);
          if (narrow) assert.ok(await page.getByRole("dialog").isVisible());
        }
        assert.deepEqual(errors, [], `${label}: no browser errors`);
        scenarios++;
        await page.close();
      }
    }
  }
  console.log(
    `PASS: ${scenarios} context-menu scenarios, ${viewportChecks} live-resize cases, themed boundaries, full-row hits, drawer focus/Escape, outside dismiss and last-action activation (zh/en)`,
  );
} finally {
  await browser.close();
}
