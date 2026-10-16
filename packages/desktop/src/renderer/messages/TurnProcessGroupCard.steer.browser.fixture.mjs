/** Real stream folding, process card and production CSS; owned transcript, forbidden network. */
/* global window, document, requestAnimationFrame, innerWidth, innerHeight */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const repo = path.resolve(desktop, "../..");
const renderer = path.join(desktop, "src/renderer");
const sourceRef = process.argv.find((arg) => arg.startsWith("--source-ref="))?.slice(13);
const baseline = process.argv.includes("--expect-baseline");
const development = process.argv.includes("--development");
assert.ok(!baseline || sourceRef, "Baseline evidence requires an explicit source ref");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-steer-bubble-"));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node"),
  { Scanner } = tw("@tailwindcss/oxide");
const source = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{TurnProcessGroupCard}from'./messages/TurnProcessGroupCard';
import{buildStreamItems,reconcileStreamItems}from'./messages/streamGroups';
import{I18nProvider}from'./i18n/I18nProvider';import{saveUILanguage}from'./uiLanguage';
window.unexpected=[];window.codeshell=new Proxy({log:()=>{}},{get(target,key){if(key in target)return target[key];window.unexpected.push(String(key));throw Error('Unexpected bridge '+String(key))}});
const started=Date.now()-65000;
const followUp={zh:'完成后请读取 eval-note.txt；不要再修改文件。',en:'After finishing, read eval-note.txt; do not modify the file again.'};
function makeMessages(options){
 const steer={kind:'user',id:'steer-user-1',steerId:'steer-1',clientMessageId:'client-1',injected:true,pending:options.pending,text:followUp[options.lang]};
 const tool=(id,toolName)=>({kind:'tool',id,toolName,args:JSON.stringify({file_path:'/owned/eval-note.txt',content:'Owned note'}),result:'Owned fixture result',status:'succeeded',startedAt:started+100,endedAt:started+200});
 return [
  {kind:'user',id:'initial-user',text:'Create eval-note.txt',turnTiming:{startedAt:started,durationMs:65000,completed:!options.live,completedCleanly:true}},
  tool('tool-before','Write'),steer,
  ...(options.two?[{...steer,id:'steer-user-2',steerId:'steer-2',clientMessageId:'client-2',pending:false}]:[]),
  ...(options.reminder?[{kind:'user',id:'internal-reminder',injected:true,text:'<system-reminder>Owned internal reminder body</system-reminder>'}]:[]),
  tool('tool-after','Read'),
  {kind:'assistant',id:'final-answer',text:options.live?'':'Owned final summary',done:!options.live}
 ];
}
function Fixture({initial}){
 const[options,setOptions]=React.useState(initial);const previous=React.useRef([]);
 window.patchFixture=patch=>flushSync(()=>setOptions(old=>({...old,...patch})));
 const messages=makeMessages(options);const items=reconcileStreamItems(previous.current,buildStreamItems(messages,{liveTurnActive:options.live}));previous.current=items;
 let group=items.find(item=>item.kind==='turn_process_group');
 if(options.duplicate){const user=group.items.find(item=>item.id==='steer-user-1');group={...group,items:[...group.items,user]};}
 window.fixtureGroup=group;window.expectedFollowUp=followUp[options.lang];
 return <main className="fixed inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
  <div id="owned-reading-pane" className="min-h-0 min-w-0 flex-1 overflow-y-auto py-3">
   <div className="cs-chat-transcript mx-auto w-full min-w-0 max-w-3xl">
    <TurnProcessGroupCard group={group} cwd={null} sessionId={null}/>
   </div>
  </div>
 </main>
}
const root=createRoot(document.getElementById('root'));let generation=0;
window.renderFixture=options=>{saveUILanguage(options.lang);document.documentElement.classList.toggle('dark',options.theme==='dark');flushSync(()=>root.render(<React.StrictMode><I18nProvider key={++generation}><Fixture initial={options}/></I18nProvider></React.StrictMode>));};
window.unmountFixture=()=>flushSync(()=>root.render(null));
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  plugins: sourceRef
    ? [
        {
          name: "owned-old-process-card",
          setup(builder) {
            builder.onLoad({ filter: /\/messages\/TurnProcessGroupCard\.tsx$/ }, (args) => ({
              contents: execFileSync(
                "git",
                [
                  "show",
                  `${sourceRef}:packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx`,
                ],
                { cwd: repo, encoding: "utf8" },
              ),
              loader: "tsx",
              resolveDir: path.dirname(args.path),
            }));
          },
        },
      ]
    : [],
});
const cssPath = path.join(renderer, "styles/tailwind.css");
let stylesheet = await readFile(cssPath, "utf8");
if (sourceRef) {
  const oldCssPath = path.join(output, "source-chat-content.css");
  await writeFile(
    oldCssPath,
    execFileSync(
      "git",
      ["show", `${sourceRef}:packages/desktop/src/renderer/styles/chat-content.css`],
      { cwd: repo, encoding: "utf8" },
    ),
  );
  assert.ok(stylesheet.includes('"./chat-content.css"'));
  stylesheet = stylesheet.replace('"./chat-content.css"', JSON.stringify(oldCssPath));
}
const compiled = await compile(stylesheet, {
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
  reports = [],
  screenshots = [];
const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "reduce" });
await context.route("**/*", (route) =>
  route.request().url() === "http://steer-bubble-owned.test/"
    ? route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;overflow:hidden}</style><div id="root"></div>',
      })
    : (blocked.push(route.request().url()), route.abort()),
);
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("http://steer-bubble-owned.test/");
await page.addStyleTag({ content: css });
await page.addScriptTag({ content: bundle.outputFiles[0].text });
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const heading = () => page.locator(".cs-process-heading");
const bubbles = () => page.locator("[data-steer-message]");
async function render(options) {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.evaluate((options) => window.renderFixture(options), options);
  await heading().waitFor();
  await frames();
}
async function capture(name) {
  const file = path.join(output, name + ".png");
  await page.screenshot({ path: file });
  screenshots.push(file);
}
async function measure() {
  return page.evaluate(() => {
    const root = document.querySelector(".cs-process"),
      surface = root.querySelector(".cs-process-surface"),
      heading = root.querySelector(".cs-process-heading");
    const box = (node) => node.getBoundingClientRect().toJSON();
    return {
      surface: box(surface),
      heading: box(heading),
      body: surface.querySelector(".cs-process-content")
        ? box(surface.querySelector(".cs-process-content"))
        : null,
      outside: [...root.querySelectorAll("[data-steer-message]")].map((node) => ({
        id: node.dataset.steerMessage,
        outside: !node.closest(".cs-process-surface"),
        text: node.textContent,
        box: box(node),
      })),
      order: [...root.querySelectorAll("[data-tool-name],[data-steer-message]")].map(
        (node) => node.dataset.steerMessage || node.dataset.toolName,
      ),
      controls: (heading.getAttribute("aria-controls") || "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => ({
          id,
          exists: !!document.getElementById(id),
          inActivity: !!document.getElementById(id)?.closest(".cs-process-surface"),
        })),
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      },
    };
  });
}
async function assertState({ open, users = 1, tools = open, order = null }) {
  assert.equal(await heading().getAttribute("aria-expanded"), String(open));
  assert.equal(await bubbles().count(), users);
  const expected = await page.evaluate(() => window.expectedFollowUp);
  const data = await measure();
  assert.ok(
    data.outside.every((item) => item.outside),
    "Every confirmed steer is outside every activity surface",
  );
  assert.ok(
    data.outside.every((item) => item.text === expected),
    "Full user content is preserved exactly",
  );
  assert.equal(new Set(data.outside.map((item) => item.id)).size, users);
  assert.ok(
    data.controls.length > 0 && data.controls.every((item) => item.exists && item.inActivity),
    "Disclosure controls resolve to actual activity bodies",
  );
  assert.equal(new Set(data.controls.map((item) => item.id)).size, data.controls.length);
  assert.equal(await page.locator('[data-message-kind="tool"]').count(), tools ? 2 : 0);
  if (order)
    assert.deepEqual(data.order, order, "Tools and user requests retain their chronological order");
  if (!open) {
    assert.ok(
      data.surface.height <= data.heading.height + 2.1,
      "Collapsed leading card contains only its header, with no white body around the steer",
    );
    assert.equal(data.body?.height ?? 0, 0);
    assert.equal(await page.locator(".cs-process-surface").count(), 1);
  }
  assert.ok(data.document.width <= data.document.viewportWidth + 1);
  assert.ok(data.document.height <= data.document.viewportHeight + 1);
  for (const bubble of await bubbles().all()) {
    await bubble.scrollIntoViewIfNeeded();
    const geometry = await bubble.evaluate((node) => {
      const box = node.getBoundingClientRect(),
        scroller = document.getElementById("owned-reading-pane").getBoundingClientRect();
      const content = node.firstElementChild.getBoundingClientRect();
      const hit = document.elementFromPoint(
        content.x + content.width / 2,
        content.y + content.height / 2,
      );
      return { box: box.toJSON(), scroller: scroller.toJSON(), hit: node.contains(hit) };
    });
    assert.ok(geometry.box.left >= 0 && geometry.box.right <= data.document.viewportWidth + 1);
    assert.ok(
      geometry.box.top >= geometry.scroller.top - 1 &&
        geometry.box.bottom <= geometry.scroller.bottom + 1,
      JSON.stringify(geometry),
    );
    assert.equal(
      geometry.hit,
      true,
      "Steer content is visible and hit-testable in the real scroll pane",
    );
  }
  return data;
}
async function confirmWhileReadingFollowingTool() {
  await render({ width: 800, height: 480, lang: "en", theme: "light", live: true, pending: true });
  const afterTool = page.locator('[data-tool-name="Read"] [data-tool-heading]');
  await afterTool.click();
  assert.equal(await afterTool.getAttribute("aria-expanded"), "true");
  await page.evaluate(() => {
    window.savedAfterTool = document.querySelector('[data-tool-name="Read"] [data-tool-heading]');
  });
  assert.equal(await afterTool.evaluate((node) => node === document.activeElement), true);
  await page.evaluate(() => window.patchFixture({ pending: false }));
  await frames();
  const afterConfirm = await afterTool.evaluate((node) => ({
    sameNode: node === window.savedAfterTool,
    previousConnected: window.savedAfterTool.isConnected,
    expanded: node.getAttribute("aria-expanded"),
    focused: node === document.activeElement,
    activeTag: document.activeElement.tagName,
  }));
  reports.push({ phase: "pending-confirmation-keeps-existing-tool-reading-state", afterConfirm });
  assert.equal(
    afterConfirm.expanded,
    "true",
    "Late confirmation preserves the tool disclosure: " + JSON.stringify(afterConfirm),
  );
  assert.equal(
    afterConfirm.focused,
    true,
    "Late confirmation preserves the actual focused tool: " + JSON.stringify(afterConfirm),
  );
}
try {
  if (baseline) {
    await render({ width: 320, height: 240, lang: "zh", theme: "light", live: false });
    const bubble = page.getByText(await page.evaluate(() => window.expectedFollowUp), {
      exact: true,
    });
    assert.equal(await bubble.evaluate((node) => !!node.closest(".cs-process-surface")), true);
    const data = await measure();
    assert.equal(await heading().getAttribute("aria-expanded"), "false");
    assert.ok(
      data.surface.height > data.heading.height + 20,
      "Old collapsed card incorrectly contains a visible user-body region",
    );
    await capture("before-collapsed-320-zh-light");
    reports.push({ phase: "baseline", data });
    await confirmWhileReadingFollowingTool();
  } else {
    for (const [width, height] of [
      [800, 480],
      [320, 240],
    ])
      for (const lang of ["zh", "en"])
        for (const theme of ["light", "dark"]) {
          const config = { width, height, lang, theme, live: true };
          await render(config);
          const expanded = await assertState({
            open: true,
            order: ["Write", "steer-user-1", "Read"],
          });
          if (width === 320) await capture(`after-expanded-${width}-${lang}-${theme}`);
          await heading().focus();
          await page.keyboard.press("Enter");
          const collapsed = await assertState({ open: false, order: ["steer-user-1"] });
          await capture(`after-collapsed-${width}-${lang}-${theme}`);
          await page.evaluate(() => window.patchFixture({ live: false }));
          await assertState({ open: false });
          if (width === 320) await capture(`after-completed-collapsed-${width}-${lang}-${theme}`);
          await render({ ...config, live: false });
          const replay = await assertState({ open: false });
          await heading().click();
          await assertState({ open: true, order: ["Write", "steer-user-1", "Read"] });
          reports.push({ phase: "layout", config, expanded, collapsed, replay });
        }
    await render({ width: 320, height: 240, lang: "zh", theme: "dark", live: true, pending: true });
    await assertState({ open: true, users: 0, order: ["Write", "Read"] });
    await capture("after-pending-before-confirm-320-zh-dark");
    await heading().click();
    await assertState({ open: false, users: 0, order: [] });
    await capture("after-pending-collapsed-320-zh-dark");
    await heading().click();
    await assertState({ open: true, users: 0, order: ["Write", "Read"] });
    await page.evaluate(() => window.patchFixture({ pending: false }));
    await assertState({ open: true, order: ["Write", "steer-user-1", "Read"] });
    await page.evaluate(() => {
      window.savedSteer = document.querySelector('[data-steer-message="steer-user-1"]');
      window.patchFixture({});
    });
    assert.equal(
      await page.evaluate(
        () => window.savedSteer === document.querySelector('[data-steer-message="steer-user-1"]'),
      ),
      true,
      "Replayed unchanged identity retains the user bubble node",
    );
    await page.evaluate(() => window.patchFixture({ duplicate: true }));
    await assertState({ open: true, order: ["Write", "steer-user-1", "Read"] });
    reports.push({ phase: "pending-confirmed-replay-dedup", data: await measure() });
    await render({
      width: 320,
      height: 240,
      lang: "en",
      theme: "light",
      live: true,
      two: true,
      reminder: true,
    });
    await assertState({
      open: true,
      users: 2,
      order: ["Write", "steer-user-1", "steer-user-2", "Read"],
    });
    const reminder = page.getByRole("button", { name: /System task|系统任务/i });
    await reminder.waitFor();
    assert.equal(await reminder.evaluate((node) => !!node.closest(".cs-process-surface")), true);
    await reminder.click();
    assert.equal(await page.getByText("Owned internal reminder body", { exact: true }).count(), 1);
    assert.equal(
      await page
        .getByText("Owned internal reminder body", { exact: true })
        .evaluate((node) => !!node.closest(".cs-process-surface")),
      true,
    );
    await heading().click();
    await assertState({ open: false, users: 2, order: ["steer-user-1", "steer-user-2"] });
    assert.equal(await page.getByText("Owned internal reminder body", { exact: true }).count(), 0);
    reports.push({ phase: "two-identical-text-identities-reminder", data: await measure() });
    await capture("after-two-steers-collapsed-320-en-light");
    await confirmWhileReadingFollowingTool();
  }
  assert.deepEqual(await page.evaluate(() => window.unexpected), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} finally {
  await context.close();
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { sourceRef, baseline, development, reports, screenshots, errors, blocked },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, observations: reports.length, screenshots, errors, blocked }),
  );
}
