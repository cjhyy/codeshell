/* Real composer submission and suggestion lifecycle; all authority is fixture-owned. */
/* global document, window */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {ChatView} from './ChatView';
  import {I18nProvider} from './i18n/I18nProvider';
  import {saveUILanguage} from './uiLanguage';
  window.codeshell={
    sttAvailable:async()=>({available:false}),
    listPluginCommands:async()=>[{name:'demo:review',pluginName:'demo',description:'Review a draft'}],
    onPluginCommandsChanged:()=>()=>{},
    listSkills:async()=>[{name:'fixture-skill',filePath:'/fixture/SKILL.md',description:'Fixture skill'}],
    inspectAttachments:async()=>[],
    searchProjectFiles:async(_project,query)=>query==='__none__'?[]:[
      {path:'/fixture/file.ts',name:'file.ts',relativePath:'file.ts',kind:'file',rootId:'root'}
    ],
    getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']})
  };
  const noop=()=>{};
  function Fixture({busy=false,queue=false,force=false,variant='main',generation}) {
    const [draft,setDraft]=React.useState('');
    return <main data-fixture-generation={generation} style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
      <ChatView variant={variant} messages={[]} busy={busy}
        onSend={text=>window.calls.sent.push(text)} onStop={noop}
        onQueueInput={queue?text=>window.calls.queued.push(text):undefined}
        onForceSend={force?text=>window.calls.guided.push(text):undefined}
        activeProjectId="project" permissionMode="plan" onPermissionChange={noop}
        goalEnabled={false} onGoalToggle={noop} modelOptions={[]} activeModelKey={null} onModelChange={noop}
        contextTokens={0} projects={[]} onSelectProject={noop} onAddProject={noop}
        configurationTarget={{projectId:'project'}} configurationAvailable
        conversationRoot="/fixture" conversationRootId="root"
        draft={draft} onDraftChange={setDraft} attachments={[]} onAttachmentsChange={noop}/>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  let generation=0;
  window.renderFixture=(props={})=>{
    window.calls={sent:[],queued:[],guided:[]};saveUILanguage('en');
    const current=++generation;
    root.render(<I18nProvider key={current}><Fixture {...props} generation={current}/></I18nProvider>);
    return current;
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
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
const errors = [],
  blocked = [],
  cases = [];
try {
  const page = await browser.newPage({
    viewport: { width: 800, height: 500 },
    serviceWorkers: "block",
  });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://composer-submit.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://composer-submit.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = page.locator("textarea");
  const menu = page.getByRole("listbox");
  const mount = async (props = {}) => {
    const generation = await page.evaluate((props) => window.renderFixture(props), props);
    await page.locator(`[data-fixture-generation="${generation}"]`).waitFor();
    await input.waitFor();
  };
  const open = async (token, empty = false) => {
    const draft = empty ? `${token}__none__` : token;
    await input.fill(draft);
    await menu.waitFor();
    await page.waitForFunction(
      ({ id, count }) =>
        document.getElementById(id)?.querySelectorAll('[role="option"]').length === count,
      { id: await menu.getAttribute("id"), count: empty ? 0 : 2 },
    );
    return draft;
  };
  const closed = async () => {
    await menu.waitFor({ state: "hidden" });
    assert.equal(await input.getAttribute("aria-controls"), null);
    assert.equal(await input.getAttribute("aria-activedescendant"), null);
  };
  const accepted = async (channel, draft, count) => {
    await page.waitForFunction(
      ({ channel, draft, count }) =>
        window.calls[channel].length === count &&
        window.calls[channel].at(-1) === draft &&
        document.querySelector("textarea").value === "",
      { channel, draft, count },
    );
    await closed();
  };

  await mount();
  for (const token of ["/", "@"]) {
    const draft = await open(token, true);
    await input.press("Enter");
    await accepted("sent", draft, token === "/" ? 1 : 3);
    assert.ok(await input.evaluate((node) => document.activeElement === node));
    cases.push(`${token} Enter sends an unmatched query and closes suggestions`);
    await open(token);
    await input.press("ArrowUp");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await accepted("sent", token, token === "/" ? 2 : 4);
    await open(token);
    assert.equal(await menu.getByRole("option").first().getAttribute("aria-selected"), "true");
    await input.press("Escape");
    await closed();
    cases.push(`${token} pointer send closes selected suggestions and a new query starts fresh`);
  }

  await mount({ busy: true, queue: true });
  for (const token of ["/", "@"]) {
    const draft = await open(token, true);
    await input.press("Enter");
    await accepted("queued", draft, token === "/" ? 1 : 2);
    cases.push(`${token} accepted queued input closes suggestions`);
  }
  assert.deepEqual(await page.evaluate(() => window.calls.sent), []);

  await mount({ busy: true, force: true });
  for (const token of ["/", "@"]) {
    await open(token);
    await input.press("ArrowUp");
    await page.getByRole("button", { name: "Guide", exact: true }).click();
    await accepted("guided", token, token === "/" ? 1 : 2);
    cases.push(`${token} accepted guidance closes suggestions`);
  }

  await mount({ busy: true, variant: "quickChat" });
  for (const token of ["/", "@"]) {
    const draft = await open(token, true);
    const controls = await input.getAttribute("aria-controls");
    await input.press("Enter");
    assert.equal(await input.inputValue(), draft);
    assert.equal(await menu.isVisible(), true);
    assert.equal(await input.getAttribute("aria-controls"), controls);
    assert.ok(await input.evaluate((node) => document.activeElement === node));
    assert.deepEqual(await page.evaluate(() => window.calls), { sent: [], queued: [], guided: [] });
    await input.press("Escape");
    await closed();
    cases.push(`${token} rejected busy quick-chat send preserves its draft and suggestions`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ result: "pass", cases }, null, 2));
} finally {
  await browser.close();
}
