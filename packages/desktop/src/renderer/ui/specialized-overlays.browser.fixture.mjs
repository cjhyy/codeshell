/* Production specialized overlays, Tailwind, and native browser geometry. */
/* global window, document, getComputedStyle, requestAnimationFrame */
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
  process.env.CODESHELL_SPECIALIZED_OVERLAYS_QA_DIR || "/tmp/codeshell-specialized-overlays-qa";
const recordOnly = process.argv.includes("--record-only");
await mkdir(output, { recursive: true });

const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {DigitalHumanEditorDialog} from './digital-humans/DigitalHumanEditorDialog';
  import {DingTalkSetupDialog} from './credentials/DingTalkSetupDialog';
  import {FilesChangedCard} from './messages/FilesChangedCard';
  import {SkillDetailModal} from './extensions/SkillDetailModal';
  import {PluginInstallReviewDialog} from './extensions/PluginInstallReviewDialog';
  import {PanelAppInstallReviewDialog} from './extensions/PanelAppInstallReviewDialog';
  import {I18nProvider} from './i18n/I18nProvider';
  import {saveUILanguage} from './uiLanguage';
  import {DialogProvider} from './ui/DialogProvider';
  import {ToastProvider} from './ui/ToastProvider';
  window.actions=[];
  window.codeshell={
    turnUndoState:async()=>({undoable:true,redoable:false}),
    readSkillBody:async()=>Array.from({length:40},(_,i)=>'### Section '+i+'\\n\\nSkill description.').join('\\n\\n'),
    imGateway:{getDingTalkSetup:async()=>({enabled:true,clientId:'',hasClientSecret:false,
      secretStorage:'missing',allowedConversationIds:[],allowedUserIds:[]}),onEvent:()=>()=>{}},
  };
  const diff='diff --git a/a.ts b/a.ts\\n--- a/a.ts\\n+++ b/a.ts\\n@@ -1,1 +1,80 @@\\n-old\\n'+
    Array.from({length:80},(_,i)=>'+line '+i).join('\\n');
  const message={kind:'files_changed',id:'changed',files:[{path:'a.ts',added:80,removed:1,count:1}],
    totalAdded:80,totalRemoved:1,sessionDiffs:[{path:'a.ts',diff}]};
  function Fixture({kind}) {
    const [open,setOpen]=React.useState(true);
    if(!open)return <output>closed</output>;
    if(kind==='editor')return <DigitalHumanEditorDialog open existingIds={[]} skills={[]}
      profile={{name:'fixture',label:'Fixture digital human',basePreset:'general',plugins:[],skills:[],mcp:[],agents:[],
        portableMemory:false,exclusiveCapabilities:false,active:false}}
      configurationTarget={{projectId:'fixture'}} busy={false} onOpenChange={setOpen} onSave={()=>window.actions.push('save')}/>;
    if(kind==='dingtalk')return <DingTalkSetupDialog open gatewayStatus={null}
      onOpenChange={setOpen} onStatusChange={()=>{}} onOpenConsole={()=>{}}/>;
    if(kind==='skill')return <SkillDetailModal name="Example skill" filePath="/fixture/SKILL.md"
      source="project" configurationTarget={{projectId:'fixture'}} onClose={()=>setOpen(false)}/>;
    if(kind==='plugin')return <PluginInstallReviewDialog busy={false} onCancel={()=>setOpen(false)} onInstall={()=>{}}
      preview={{name:'research-assistant-plugin',version:'1.0.0',format:'cc',alreadyInstalled:false,
      source:{kind:'dir',label:'/fixture/research-assistant-plugin'},reviewToken:'fixture-token',warnings:[],
      skills:[{name:'research',description:'Research supporting documents.'}],commands:[],agents:[],hooks:[],
      mcpServers:[],automationTemplates:[],interface:{externalLinks:[],media:{screenshots:[]}}}}/>;
    if(kind==='panel')return <PanelAppInstallReviewDialog busy={false} action="install"
      projectLabel="Fixture project" onCancel={()=>setOpen(false)} onInstall={()=>{}}
      preview={{id:'research-assistant',title:{default:'Research assistant'},version:'1.0.0',
      source:{kind:'git',label:'fixture/panels'},reviewToken:'fixture-token',alreadyInstalled:false,
      entry:'app/index.html',singleton:true,permissions:['storage','workspace.read','process']}}/>;
    return <main className="fixed inset-0 overflow-y-auto bg-background p-4">
      <div className="mx-auto max-w-xl pt-16">
        <div className="cs-stream-item" data-testid="history-item">
          <FilesChangedCard message={message} cwd={null} sessionId="fixture-session" isLatest={kind==='undo'}/>
        </div>
        <div className="h-40">Later history messages</div>
      </div>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=(kind,lang)=>{
    saveUILanguage(lang);
    root.render(<I18nProvider key={kind+lang}><ToastProvider><DialogProvider>
      <Fixture kind={kind}/>
    </DialogProvider></ToastProvider></I18nProvider>);
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  outfile: path.join(output, "fixture.js"),
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
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const reports = [];
const failures = [];
async function geometry(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      rect: rect.toJSON(),
      hit: element === hit || element.contains(hit),
      hitText: hit?.textContent?.slice(0, 80),
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowY: getComputedStyle(element).overflowY,
      scrollTop: element.scrollTop,
      ancestors: Array.from(
        (function* (node) {
          while (node.parentElement) {
            node = node.parentElement;
            yield node;
          }
        })(element),
      )
        .filter((node) => node.matches('nav,form,[role="dialog"]'))
        .map((node) => ({
          tag: node.tagName,
          role: node.getAttribute("role"),
          rect: node.getBoundingClientRect().toJSON(),
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          overflowY: getComputedStyle(node).overflowY,
        })),
    };
  });
}
function check(ok, message, context) {
  if (!ok) failures.push({ message, ...context });
}
async function scrollTo(locator) {
  if (recordOnly) await locator.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
  else await locator.scrollIntoViewIfNeeded();
}
async function inspectEditor(page, context) {
  const tabs = page.locator("nav button");
  for (let index = 0; index < (await tabs.count()); index++) {
    await scrollTo(tabs.nth(index));
    const tab = await geometry(tabs.nth(index));
    check(
      tab.hit && tab.rect.top >= 8 && tab.rect.bottom <= context.viewport.height - 8,
      "Editor navigation is reachable",
      { ...context, index, tab },
    );
    if (!recordOnly) await tabs.nth(index).click();
  }
  await scrollTo(tabs.first());
  if (!recordOnly) await tabs.first().click();
  const field = page.locator("#digital-human-summary");
  await scrollTo(field);
  const fieldBox = await geometry(field);
  // A tall textarea may require its own scroll position; its center must be usable.
  check(fieldBox.hit, "Editor identity field is reachable", { ...context, field: fieldBox });
  if (!recordOnly) await field.fill("Updated fixture summary");
  const submit = page.locator('button[type="submit"]');
  await scrollTo(submit);
  const action = await geometry(submit);
  check(
    action.hit && action.rect.bottom <= context.viewport.height - 8,
    "Editor save is reachable",
    { ...context, action },
  );
  if (!recordOnly) await submit.click();
}
try {
  for (const viewport of [
    { width: 800, height: 360 },
    { width: 390, height: 320 },
    { width: 1280, height: 760 },
  ]) {
    for (const lang of ["zh", "en"]) {
      for (const kind of ["editor", "review", "undo", "dingtalk", "skill", "plugin", "panel"]) {
        const page = await browser.newPage({ viewport });
        const context = { kind, lang, viewport };
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) =>
          route.request().url() === "http://specialized-overlays.test/"
            ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
            : route.abort(),
        );
        await page.goto("http://specialized-overlays.test/");
        await page.addStyleTag({ content: css });
        for (const file of bundle.outputFiles) {
          if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
          else await page.addScriptTag({ content: file.text });
        }
        await page.evaluate(({ kind, lang }) => window.renderFixture(kind, lang), { kind, lang });
        if (kind === "review" || kind === "undo") {
          await page
            .getByRole("button", {
              name:
                kind === "review"
                  ? lang === "zh"
                    ? "审核改动"
                    : "Review changes"
                  : lang === "zh"
                    ? "撤销改动"
                    : "Undo changes",
            })
            .click();
        }
        await page.waitForTimeout(240);
        const surface = page
          .locator('[role="dialog"]')
          .count()
          .then((count) =>
            count ? page.locator('[role="dialog"]') : page.locator(".fixed.inset-0.z-50 > div"),
          );
        const overlay = await surface;
        const box = await geometry(overlay);
        reports.push({ ...context, box });
        check(
          box.rect.top >= 8 &&
            box.rect.bottom <= viewport.height - 8 &&
            box.rect.left >= 8 &&
            box.rect.right <= viewport.width - 8,
          "Overlay fits viewport",
          { ...context, box },
        );
        check(box.scrollWidth <= box.clientWidth + 1, "No horizontal clipping", {
          ...context,
          box,
        });
        check(box.hit, "Overlay receives pointer hits", { ...context, box });
        if (kind === "review" || kind === "undo") {
          check(
            await overlay.evaluate((element) => !element.closest('[data-testid="history-item"]')),
            "Transcript overlay escapes history containment",
            context,
          );
        }
        if (kind === "editor") {
          await inspectEditor(page, context);
          if (viewport.width === 1280) {
            for (const resized of [
              { width: 800, height: 360 },
              { width: 390, height: 320 },
            ]) {
              await page.setViewportSize(resized);
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              await inspectEditor(page, { ...context, viewport: resized, phase: "live-resize" });
            }
          }
          if (!recordOnly)
            check(
              await page.evaluate(() => window.actions.includes("save")),
              "Editor save action executes",
              context,
            );
        } else if (kind === "review") {
          const lastLine = page.getByText("line 79", { exact: true });
          await scrollTo(lastLine);
          const line = await geometry(lastLine);
          check(line.hit, "Last diff line is reachable", { ...context, line });
          const close = page.getByRole("button", {
            name: lang === "zh" ? "关闭" : "Close",
            exact: true,
          });
          await scrollTo(close);
          const closeBox = await geometry(close);
          check(closeBox.hit, "Diff close button is reachable", { ...context, close: closeBox });
          if (!recordOnly) await close.click();
        } else if (kind === "undo" && !recordOnly) {
          await page
            .getByRole("button", { name: lang === "zh" ? "取消" : "Cancel", exact: true })
            .click();
        }
        if ((kind === "review" || kind === "undo") && !recordOnly) {
          const openerLabel =
            kind === "review"
              ? lang === "zh"
                ? "审核改动"
                : "Review changes"
              : lang === "zh"
                ? "撤销改动"
                : "Undo changes";
          await page.waitForFunction(
            (label) => document.activeElement?.getAttribute("aria-label") === label,
            openerLabel,
          );
          await page.getByRole("button", { name: openerLabel, exact: true }).click();
          await page.getByRole("dialog").waitFor();
          await page.keyboard.press("Escape");
          await page.waitForFunction(
            (label) => document.activeElement?.getAttribute("aria-label") === label,
            openerLabel,
          );
        }
        check(errors.length === 0, "No browser errors", { ...context, errors });
        if (recordOnly)
          await page.screenshot({
            path: path.join(output, `${kind}-${lang}-${viewport.width}x${viewport.height}.png`),
          });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(path.join(output, "report.json"), JSON.stringify({ reports, failures }, null, 2));
console.log(JSON.stringify({ scenarios: reports.length, failures }, null, 2));
if (!recordOnly) assert.equal(failures.length, 0, "Specialized overlay browser regression failed");
