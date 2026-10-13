/* Real browser QA with production TSX and Tailwind; no Host, IPC, or provider. */
/* global window, document */
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
const output =
  process.env.CODESHELL_PANEL_CAPABILITIES_QA_DIR || "/tmp/codeshell-panel-capabilities-qa";
await mkdir(output, { recursive: true });

const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {PanelAppCapabilities} from './extensions/PanelAppCapabilities';
  import {PanelAppInstallReviewDialog} from './extensions/PanelAppInstallReviewDialog';
  import {CapabilitiesOverviewSection} from './settings/CapabilitiesOverviewSection';
  import {I18nProvider} from './i18n/I18nProvider';
  import {saveUILanguage} from './uiLanguage';
  import {saveProjects} from './projects';
  import {PANEL_APP_PERMISSION_NAMES} from '../shared/panel-apps';

  const unknown='future.fixturePermission';
  const longName='save_fixture_document_'+'long_identifier_'.repeat(10);
  const agent={
    tools:[
      {name:'read_fixture_document',description:'Read the document selected by the user.',readOnly:true},
      {name:longName,description:'Save the document after the user confirms its content. '.repeat(3),readOnly:false}
    ],
    skills:['skills/document-workflow/SKILL.md']
  };
  const selected={
    id:'panel-app:fixture-panel',appId:'fixture-panel',title:'Fixture panel',version:'1.4.0',
    revision:'selected-package',bindingRevision:'a'.repeat(64),hostId:'fixture-panel',
    kind:'panel-app',icon:'panel',singleton:true,projectBound:true,enabled:true,
    permissions:['workspace.read'],agent,
    updateSource:{kind:'git',label:'fixtures/panels',available:true}
  };
  saveProjects([{id:'fixture-project',name:'Fixture project',path:'/fixture-project',
    roots:[{id:'fixture-root',path:'/fixture-project',name:'Fixture project',addedAt:1}],
    primaryRootId:'fixture-root',addedAt:1}]);
  window.hostCalls=[];
  window.actions=[];
  window.codeshell={
    listCapabilities:async()=>[],
    listPanelAppExtensions:async(cwd,locale)=>{
      window.hostCalls.push(['selected',cwd,locale]);
      return [selected];
    },
    listPanelApps:()=>{throw new Error('Global catalog may not replace the selected package')},
    setPanelAppProjectBinding:()=>{throw new Error('Reading capability details must not mutate bindings')}
  };
  const preview={
    id:'fixture-panel',version:'2.0.0',title:{default:'Fixture panel'},entry:'app/index.html',
    singleton:true,permissions:[...PANEL_APP_PERMISSION_NAMES.filter(x=>x!=='workspace.read'),unknown],
    alreadyInstalled:true,reviewToken:'fixture-reviewed-token',source:{kind:'git',label:'fixtures/panels'},
    warnings:[],agent
  };
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=(mode,lang,baseline='known')=>{
    saveUILanguage(lang);
    root.render(<I18nProvider key={mode+'-'+lang+'-'+baseline}>
      {mode==='review' ? <PanelAppInstallReviewDialog busy={false} action="update" preview={preview}
        installedVersion="1.4.0" installedPermissions={baseline==='known'?['storage','workspace.read']:
          baseline==='empty'?[]:undefined} projectLabel="Fixture project"
        onCancel={()=>window.actions.push('cancel')} onInstall={()=>window.actions.push('confirm')}/>
        : <main className="mx-auto max-w-3xl p-4">
          {mode==='settings' ? <CapabilitiesOverviewSection scope="project" projectPath="/fixture-project"/>
            : <PanelAppCapabilities permissions={['storage','process','credentials.connections',unknown]}
                agent={agent} nativeEntries={{document_cli:{entry:'tools/document-cli.mjs',sha256:'a'.repeat(64)}}}/>}
        </main>}
    </I18nProvider>);
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
const reports = [];
try {
  for (const width of [1280, 390]) {
    for (const lang of ["zh", "en"]) {
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Every browser request stays in this exact-origin fixture. No app server
      // runs, and arbitrary requests cannot reach native or external services.
      await page.route("**/*", (route) => {
        if (route.request().url() === "http://panel-capabilities.test/") {
          return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
        }
        return route.abort();
      });
      await page.goto("http://panel-capabilities.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const labels =
        lang === "zh"
          ? {
              details: "能力详情",
              host: "声明的 Host 能力",
              process: "本机程序执行",
              processDescription: "启动和管理本机工具进程",
              unknown: "此版本暂未提供该权限的用途说明，请核对应用包声明。",
              readOnly: "只读",
              writable: "可写",
              added: "新增",
              removed: "移除",
              unavailable: "无法比较原版本权限，请审阅全部能力。",
              confirm: "确认并更新",
            }
          : {
              details: "Capability details",
              host: "Declared host capabilities",
              process: "Run native programs",
              processDescription: "Start and manage native tool processes",
              unknown:
                "This version has no description for this permission. Check the app package declaration.",
              readOnly: "Read-only",
              writable: "May write",
              added: "Added",
              removed: "Removed",
              unavailable:
                "The previous version's permissions cannot be compared. Review all capabilities.",
              confirm: "Review and update",
            };

      await page.evaluate((value) => window.renderFixture("details", value), lang);
      const disclosure = page.getByRole("button", { name: new RegExp(`^${labels.details}`) });
      await disclosure.waitFor();
      assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
      assert.equal(await page.getByRole("list", { name: labels.host, exact: true }).count(), 0);
      await disclosure.focus();
      await page.keyboard.press("Enter");
      assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
      const host = page.getByRole("list", { name: labels.host, exact: true });
      await host.waitFor();
      assert.ok((await host.textContent()).includes(labels.process));
      assert.ok((await host.textContent()).includes(labels.processDescription));
      assert.ok((await host.textContent()).includes("credentials.connections"));
      assert.ok((await host.textContent()).includes("future.fixturePermission"));
      assert.ok((await host.textContent()).includes(labels.unknown));
      assert.ok((await page.locator("main").textContent()).includes(labels.readOnly));
      assert.ok((await page.locator("main").textContent()).includes(labels.writable));
      assert.ok(
        (await page.locator("main").textContent()).includes("skills/document-workflow/SKILL.md"),
      );
      assert.ok((await page.locator("main").textContent()).includes("tools/document-cli.mjs"));
      assert.deepEqual(await page.evaluate(() => window.actions), []);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `${width}/${lang}: detail rows wrap without horizontal page overflow`,
      );
      await page.screenshot({
        path: path.join(output, `details-${width}-${lang}.png`),
        fullPage: true,
      });
      await disclosure.focus();
      await page.keyboard.press("Space");
      assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
      assert.equal(await host.count(), 0);

      await page.evaluate((value) => window.renderFixture("settings", value), lang);
      await page.getByText("v1.4.0", { exact: true }).waitFor();
      const projectDetails = page.getByRole("button", { name: new RegExp(`^${labels.details}`) });
      await projectDetails.waitFor();
      assert.ok((await page.locator("main").textContent()).includes("v1.4.0"));
      await projectDetails.click();
      const selectedHost = page.getByRole("list", { name: labels.host, exact: true });
      assert.ok((await selectedHost.textContent()).includes("workspace.read"));
      assert.equal((await selectedHost.textContent()).includes("credentials.connections"), false);
      assert.deepEqual(await page.evaluate(() => window.hostCalls), [
        ["selected", "/fixture-project", lang],
      ]);
      await page.screenshot({
        path: path.join(output, `settings-${width}-${lang}.png`),
        fullPage: true,
      });

      await page.evaluate((value) => window.renderFixture("review", value), lang);
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await page.waitForTimeout(180); // Finish the Dialog's CSS entrance animation.
      const permissions = dialog.getByRole("list", { name: labels.host, exact: true });
      await permissions.waitFor();
      const rows = permissions.getByRole("listitem");
      const processRow = rows.filter({ has: page.getByText("process", { exact: true }) });
      assert.ok((await processRow.textContent()).includes(labels.added));
      const storageRow = rows.filter({ has: page.getByText("storage", { exact: true }) });
      assert.equal((await storageRow.textContent()).includes(labels.added), false);
      const removedRow = rows.filter({ has: page.getByText("workspace.read", { exact: true }) });
      assert.ok((await removedRow.textContent()).includes(labels.removed));
      const confirm = dialog.getByRole("button", { name: labels.confirm, exact: true });
      assert.ok(await confirm.isVisible());
      const geometry = await dialog.evaluate((element) => {
        const scroll = [...element.querySelectorAll("div")].find((node) =>
          node.classList.contains("overflow-y-scroll"),
        );
        return {
          dialog: element.getBoundingClientRect().toJSON(),
          scrollHeight: scroll?.scrollHeight,
          clientHeight: scroll?.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      const footer = await confirm.boundingBox();
      assert.ok(geometry.dialog.left >= 0 && geometry.dialog.right <= width + 1);
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${width}/${lang}: review wraps`);
      assert.ok(
        geometry.scrollHeight > geometry.clientHeight,
        "Long capabilities scroll in review",
      );
      assert.ok(
        footer && footer.y >= 0 && footer.y + footer.height <= 760,
        "Confirmation stays on screen",
      );
      assert.deepEqual(await page.evaluate(() => window.actions), []);
      await page.screenshot({ path: path.join(output, `review-${width}-${lang}.png`) });
      await permissions
        .getByText("future.fixturePermission", { exact: true })
        .scrollIntoViewIfNeeded();
      assert.ok(
        await confirm.isVisible(),
        "Scrolling the permissions keeps confirmation available",
      );
      await page.screenshot({ path: path.join(output, `review-scroll-${width}-${lang}.png`) });

      await page.evaluate((value) => window.renderFixture("review", value, "unknown"), lang);
      await dialog.getByText(labels.unavailable, { exact: true }).waitFor();
      assert.equal(await dialog.getByText(labels.added, { exact: true }).count(), 0);
      assert.equal(await dialog.getByText(labels.removed, { exact: true }).count(), 0);
      await page.evaluate((value) => window.renderFixture("review", value, "empty"), lang);
      await dialog.getByText(labels.added, { exact: true }).first().waitFor();
      assert.equal(await dialog.getByText(labels.added, { exact: true }).count(), 19);
      assert.equal(await dialog.getByText(labels.removed, { exact: true }).count(), 0);
      await confirm.click();
      assert.deepEqual(await page.evaluate(() => window.actions), ["confirm"]);
      assert.deepEqual(errors, []);
      reports.push({ width, lang, geometry });
      await page.close();
    }
  }
  console.log(JSON.stringify({ result: "pass", output, reports }, null, 2));
} finally {
  await browser.close();
}
