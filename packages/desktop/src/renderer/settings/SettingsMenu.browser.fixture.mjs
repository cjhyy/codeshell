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
  window.renderFixture=(lang, features={})=>{
    saveUILanguage(lang);
    root.render(<div style={{position:'fixed',left:12,bottom:12,width:240}}>
      <SettingsMenu key={lang} petWidgetVisible={false} onTogglePetWidget={()=>window.actions.push('pet')}
        onNavigate={page=>window.actions.push(page)} onOpenSettingsPage={()=>window.actions.push('settings')}
        {...features}/>
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
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});

async function assertMenuFits(page, menu, label) {
  // Wait for Radix's collision update and the entrance animation before
  // checking actual painted bounds, including the submenu overlap transform.
  await page.waitForFunction(
    (name) => {
      const node = Array.from(document.querySelectorAll('[role="menu"]')).find(
        (candidate) => candidate.getAttribute("aria-label") === name,
      );
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return (
        rect.left >= 11 &&
        rect.top >= 11 &&
        rect.right <= window.innerWidth - 11 &&
        rect.bottom <= window.innerHeight - 11 &&
        rect.width >= Math.min(159, window.innerWidth - 24)
      );
    },
    await menu.getAttribute("aria-label"),
  );
  const box = await menu.boundingBox();
  assert.ok(box.width >= Math.min(159, page.viewportSize().width - 24), `${label}: readable width`);
  assert.equal(
    await menu.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
    `${label}: menu content fits horizontally`,
  );
}

async function assertItemReachable(item, label) {
  await item.scrollIntoViewIfNeeded();
  assert.ok(
    await item.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === node || node.contains(hit);
    }),
    `${label}: menu item receives pointer input after scrolling`,
  );
}

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
              taskInbox: "任务中心",
              credentials: "凭证",
              cloud: "云端工作台",
              lab: "优化实验室",
            }
          : {
              settings: "Settings",
              activity: "Activity",
              language: "Switch language",
              pet: "Show Mimi",
              logs: "Logs",
              taskInbox: "Task center",
              credentials: "Credentials",
              cloud: "Cloud workbench",
              lab: "Optimization Lab",
            };
      const opener = page.getByRole("button", { name: labels.settings, exact: true });
      const menu = page.getByRole("menu", { name: labels.settings, exact: true });
      const activity = menu.getByRole("menuitem", { name: labels.activity, exact: true });
      const activityMenu = page.getByRole("menu", { name: labels.activity, exact: true });
      const language = menu.getByRole("menuitem", { name: labels.language, exact: true });
      const languageMenu = page.getByRole("menu", { name: labels.language, exact: true });
      const pet = menu.getByRole("menuitem", { name: labels.pet, exact: true });
      await opener.click();
      assert.equal(
        await menu.getByRole("menuitem", { name: labels.cloud, exact: true }).count(),
        0,
        "Cloud location belongs to an existing project instead of Settings",
      );
      await activity.hover();
      await page.waitForTimeout(150); // Beyond Radix's hover-open delay.
      assert.equal(await activityMenu.isVisible(), false, "Hover alone does not open a submenu");
      await activity.click();
      await activityMenu.waitFor();
      await assertMenuFits(page, activityMenu, `${width}/${lang} activity`);
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
      await assertMenuFits(page, languageMenu, `${width}/${lang} language`);
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
      for (const [label, target] of [[labels.credentials, "credentials"]]) {
        await opener.click();
        assert.equal(
          await menu.getByRole("menuitem", { name: labels.lab, exact: true }).count(),
          0,
        );
        await menu.getByRole("menuitem", { name: label, exact: true }).click();
        await menu.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => window.actions.at(-1)), target);
        assert.ok(await opener.evaluate((node) => node === document.activeElement));
      }
      await opener.click();
      await activity.click();
      await activityMenu.getByRole("menuitem", { name: labels.taskInbox, exact: true }).click();
      await menu.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => window.actions.at(-1)), "task_inbox");
      await page.evaluate(
        (value) =>
          window.renderFixture(value, {
            taskInboxEnabled: false,
            optimizationLabEnabled: true,
          }),
        lang,
      );
      await opener.click();
      await menu.getByRole("menuitem", { name: labels.lab, exact: true }).click();
      await menu.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => window.actions.at(-1)), "optimization_lab");
      await opener.click();
      await activity.click();
      await activityMenu.waitFor();
      assert.equal(
        await activityMenu.getByRole("menuitem", { name: labels.taskInbox, exact: true }).count(),
        0,
      );
      assert.ok(await logs.isVisible(), "Disabling tasks leaves history available");
      await page.mouse.click(width - 20, 20);
      await menu.waitFor({ state: "hidden" });

      // Keep menus open through narrow and short viewport changes. Every
      // action must remain reachable even when the full menu needs scrolling.
      await page.evaluate((value) => window.renderFixture(value), lang);
      await opener.click();
      await activity.click();
      for (const viewport of [
        { width: 390, height: 320 },
        { width: 280, height: 200 },
        { width: 1280, height: 760 },
      ]) {
        await page.setViewportSize(viewport);
        await assertMenuFits(page, menu, `${lang} resized settings`);
        await assertMenuFits(page, activityMenu, `${lang} resized activity`);
        if (viewport.height === 200) {
          assert.ok(
            await activityMenu.evaluate((node) => node.scrollHeight > node.clientHeight),
            `${lang}: short activity menu scrolls instead of clipping actions`,
          );
        }
        for (const item of await activityMenu.getByRole("menuitem").all()) {
          await assertItemReachable(item, `${lang} activity ${await item.textContent()}`);
        }
      }
      await logs.click();
      await menu.waitFor({ state: "hidden" });
      await opener.click();
      await language.click();
      await page.setViewportSize({ width: 280, height: 200 });
      await assertMenuFits(page, menu, `${lang} short settings`);
      await assertMenuFits(page, languageMenu, `${lang} short language`);
      for (const item of await languageMenu.getByRole("menuitemradio").all()) {
        await assertItemReachable(item, `${lang} language ${await item.textContent()}`);
      }
      await page.keyboard.press("Escape");
      await languageMenu.waitFor({ state: "hidden" });
      const openSettings = menu.getByRole("menuitem", { name: /打开设置|Open settings/ });
      await assertItemReachable(openSettings, `${lang} short open settings`);
      await openSettings.click();
      await menu.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => window.actions.at(-1)), "settings");
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log(
    "PASS: settings menus preserve pointer/focus behavior and fit narrow/short/resized windows (zh/en)",
  );
} finally {
  await browser.close();
}
