/* Real pointer/focus regression; compile the production menu and styles in memory. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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
  import {SettingsMenu} from './settings/SettingsMenu';
  import {saveUILanguage} from './uiLanguage';
  const root=createRoot(document.getElementById('root'));
  window.actions=[];
  window.renderFixture=lang=>{
    saveUILanguage(lang);
    root.render(<div style={{position:'fixed',left:12,bottom:12,width:240}}>
      <SettingsMenu key={lang} petWidgetVisible={false} onTogglePetWidget={()=>window.actions.push('pet')}
        onNavigate={page=>window.actions.push(page)} onOpenSettingsPage={()=>window.actions.push('settings')}/>
    </div>);
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
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const lang of ["zh", "en"]) {
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("http://settings.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
      );
      await page.goto("http://settings.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((value) => window.renderFixture(value), lang);
      const labels =
        lang === "zh"
          ? {
              settings: "设置",
              activity: "活动记录",
              language: "切换语言",
              pet: "显示 Mimi",
              logs: "日志",
            }
          : {
              settings: "Settings",
              activity: "Activity",
              language: "Switch language",
              pet: "Show Mimi",
              logs: "Logs",
            };
      const opener = page.getByRole("button", { name: labels.settings, exact: true });
      const menu = page.getByRole("menu", { name: labels.settings, exact: true });
      const activity = menu.getByRole("menuitem", { name: labels.activity, exact: true });
      const activityMenu = page.getByRole("menu", { name: labels.activity, exact: true });
      const language = menu.getByRole("menuitem", { name: labels.language, exact: true });
      const languageMenu = page.getByRole("menu", { name: labels.language, exact: true });
      const pet = menu.getByRole("menuitem", { name: labels.pet, exact: true });
      await opener.click();
      await activity.hover();
      await page.waitForTimeout(150); // Beyond Radix's hover-open delay.
      assert.equal(await activityMenu.isVisible(), false, "Hover alone does not open a submenu");
      await activity.click();
      await activityMenu.waitFor();
      // Slowly pass the trigger edge and a neighbouring parent item. Radix's
      // default pointer leave moves focus outside the submenu after its grace area.
      await pet.hover({ position: { x: 12, y: 12 } });
      await page.waitForTimeout(400); // Beyond the 300ms pointer grace and exit animation.
      assert.ok(
        await activityMenu.isVisible(),
        `${width}/${lang}: activity survives neighbouring hover`,
      );
      const logs = activityMenu.getByRole("menuitem", { name: labels.logs, exact: true });
      await logs.hover();
      await language.hover({ position: { x: 12, y: 12 } });
      await page.waitForTimeout(400);
      assert.ok(await activityMenu.isVisible(), "Leaving a child item does not dismiss its menu");
      assert.equal(await languageMenu.isVisible(), false, "Hover does not switch submenus");
      await language.click();
      await languageMenu.waitFor();
      await activityMenu.waitFor({ state: "hidden" });
      await pet.hover({ position: { x: 12, y: 12 } });
      await page.waitForTimeout(400);
      assert.ok(await languageMenu.isVisible(), "Language also survives neighbouring hover");
      await activity.click();
      await activityMenu.waitFor();
      await languageMenu.waitFor({ state: "hidden" });
      await logs.click();
      await menu.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => window.actions), ["logs"]);
      assert.ok(await opener.evaluate((node) => node === document.activeElement));

      await opener.click();
      await activity.click();
      await activityMenu.waitFor();
      await activity.click();
      await activityMenu.waitFor({ state: "hidden" });
      await activity.focus();
      await activity.press("ArrowRight");
      await activityMenu.waitFor();
      await activityMenu.getByRole("menuitem").first().focus();
      await page.keyboard.press("ArrowLeft");
      await activityMenu.waitFor({ state: "hidden" });
      assert.ok(await activity.evaluate((node) => node === document.activeElement));
      await activity.press("ArrowRight");
      await activityMenu.waitFor();
      await page.keyboard.press("Escape");
      await activityMenu.waitFor({ state: "hidden" });
      assert.ok(await menu.isVisible(), "Escape closes the submenu before its parent");
      await activity.click();
      await activityMenu.waitFor();
      await page.mouse.click(width - 20, 20);
      await menu.waitFor({ state: "hidden" });
      await activityMenu.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => window.actions), ["logs"]);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log(
    "PASS: settings submenus survive pointer travel and preserve explicit dismissal (wide/narrow, zh/en)",
  );
} finally {
  await browser.close();
}
