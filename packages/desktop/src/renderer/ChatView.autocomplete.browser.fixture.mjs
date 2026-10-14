/* Production composer geometry and pointer/keyboard regression. */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const recordOnly = process.argv.includes("--record-only");
const output = "/tmp/codeshell-composer-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {ChatView} from './ChatView';
  import {I18nProvider} from './i18n/I18nProvider';
  import {saveUILanguage} from './uiLanguage';
  const commands=Array.from({length:20},(_,i)=>({name:'demo:command'+i,pluginName:'demo',description:'Command '+i,argumentHint:'<path>'}));
  const skills=Array.from({length:8},(_,i)=>({name:'skill'+i,filePath:'/fixture/skill'+i+'/SKILL.md',description:'Skill '+i}));
  const files=Array.from({length:12},(_,i)=>({path:'/fixture/file'+i+'.ts',relativePath:'file'+i+'.ts',kind:'file',rootId:'root'}));
  window.codeshell={sttAvailable:async()=>({available:false}),listPluginCommands:async()=>commands,
    onPluginCommandsChanged:()=>()=>{},listSkills:async()=>skills,inspectAttachments:async()=>[],
    searchProjectFiles:async()=>files,getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']})};
  window.sends=[];
  const noop=()=>{};
  function Fixture({narrowPane}) {
    const [draft,setDraft]=React.useState('');
    const [contextTokens,setContextTokens]=React.useState(0);
    window.bumpContext=()=>setContextTokens(value=>value+100);
    return <main style={{position:'fixed',inset:0,display:'flex',justifyContent:'flex-end',overflow:'hidden'}}>
      <section style={{height:'100%',width:narrowPane?260:'100%',overflow:'hidden',border:'1px solid transparent'}}>
        <ChatView variant="main" messages={[]} onSend={(text)=>window.sends.push(text)} onStop={noop} busy={false}
          activeProjectId="project" permissionMode="plan" onPermissionChange={noop} goalEnabled={false} onGoalToggle={noop}
          modelOptions={[{key:'model',label:'Model',provider:'demo'}]} activeModelKey="model" onModelChange={noop}
          contextTokens={contextTokens} projects={[]} onSelectProject={noop} onAddProject={noop}
          configurationTarget={{projectId:'project'}} configurationAvailable conversationRoot="/fixture" conversationRootId="root"
          draft={draft} onDraftChange={setDraft} attachments={[]} onAttachmentsChange={noop}/>
      </section>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=(props)=>{saveUILanguage(props.lang);root.render(<I18nProvider key={JSON.stringify(props)}><Fixture {...props}/></I18nProvider>);};
`;
const built = await build({
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
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
const reports = [];
const failures = [];
try {
  for (const lang of ["zh", "en"]) {
    for (const viewport of [
      { width: 800, height: 360 },
      { width: 390, height: 320 },
    ]) {
      for (const narrowPane of [false, true]) {
        const page = await browser.newPage({ viewport });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("http://composer.test/", (route) =>
          route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
        );
        await page.goto("http://composer.test/");
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: built.outputFiles[0].text });
        await page.evaluate((props) => window.renderFixture(props), { lang, narrowPane });
        const input = page.locator("textarea");
        await input.waitFor();
        for (const token of ["@", "/"]) {
          await input.fill(token);
          const menu = page.getByRole("listbox");
          await menu.waitFor();
          await page.waitForTimeout(250);
          const measure = async (phase) => {
            const box = await menu.evaluate((node) => {
              const rect = node.getBoundingClientRect();
              const viewport = { width: window.innerWidth, height: window.innerHeight };
              const first = node.querySelector('[role="option"]');
              const item = first?.getBoundingClientRect();
              const hit = item
                ? document.elementFromPoint(item.left + item.width / 2, item.top + item.height / 2)
                : null;
              return {
                rect: rect.toJSON(),
                viewport,
                hit: !!first && (hit === first || first.contains(hit)),
                scrollWidth: node.scrollWidth,
                clientWidth: node.clientWidth,
              };
            });
            const context = { lang, viewport, narrowPane, token, phase, box };
            reports.push(context);
            if (!recordOnly) {
              assert.ok(
                box.rect.left >= 10 &&
                  box.rect.top >= 10 &&
                  box.rect.right <= box.viewport.width - 10 &&
                  box.rect.bottom <= box.viewport.height - 10,
                JSON.stringify(context),
              );
              assert.ok(box.hit, JSON.stringify(context));
              assert.ok(box.scrollWidth <= box.clientWidth + 1, JSON.stringify(context));
              assert.ok(
                await input.evaluate((node) => document.activeElement === node),
                "Typing focus stays in the composer",
              );
            }
          };
          try {
            await measure("open");
            await page.screenshot({
              path: path.join(
                output,
                `${recordOnly ? "before" : "after"}-${lang}-${viewport.width}-${narrowPane}-${token === "@" ? "mention" : "slash"}.png`,
              ),
            });
            if (!recordOnly) {
              const scrolled = await menu.evaluate((node) => {
                node.scrollTop = node.scrollHeight;
                return node.scrollTop;
              });
              assert.ok(scrolled > 0, "Long suggestions can be manually scrolled");
              await page.evaluate(async () => {
                window.bumpContext();
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
              });
              assert.equal(
                await menu.evaluate((node) => node.scrollTop),
                scrolled,
                "Background token updates preserve manually scrolled suggestions",
              );
              await input.press("ArrowUp");
              await page.waitForTimeout(80);
              const selected = menu.getByRole("option", { selected: true });
              await selected.waitFor();
              assert.ok(
                await selected.evaluate((node) => {
                  const r = node.getBoundingClientRect();
                  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                  return hit === node || node.contains(hit);
                }),
                "Keyboard selection remains visible and clickable",
              );
              await selected.click();
              await menu.waitFor({ state: "hidden" });
              assert.ok(
                await input.evaluate((node) => document.activeElement === node),
                "Pointer selection retains composer focus",
              );
              assert.equal(
                await page.evaluate(() => window.sends.length),
                0,
                "Picking a suggestion never sends the draft",
              );
              await input.fill(token);
              await menu.waitFor();
              await page.setViewportSize({ width: 320, height: 240 });
              await page.waitForTimeout(200);
              await measure("resize");
            }
          } catch (error) {
            failures.push(error.message);
          }
          await input.press("Escape");
          await menu.waitFor({ state: "hidden" });
          await page.setViewportSize(viewport);
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        result: recordOnly ? "recorded" : failures.length ? "fail" : "pass",
        cases: reports.length,
        failures,
        ...(recordOnly ? { reports } : {}),
      },
      null,
      2,
    ),
  );
  if (!recordOnly) assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  await browser.close();
}
