/* Production composer caret ownership; native events and deliberately delayed animation frames. */
/* global document, window, MouseEvent, Event, performance */
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
    const [engineSessionId,setEngineSessionId]=React.useState(null);
    window.replaceDraft=setDraft;window.changeSession=setEngineSessionId;
    return <main data-fixture-generation={generation} data-session={engineSessionId??'draft'} style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
      <button data-caret-outside>Outside composer</button>
      <ChatView engineSessionId={engineSessionId} variant={variant} messages={[]} busy={busy}
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

  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const frames = new Map();
    let armed = false,
      nextId = -1;
    window.holdNextCaret = () => {
      if (armed) throw new Error("A previous frame was never registered");
      armed = true;
    };
    window.requestAnimationFrame = (callback) => {
      if (!armed) return request(callback);
      armed = false;
      const id = nextId--;
      frames.set(id, { callback, canceled: false });
      window.latestCaret = id;
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const held = frames.get(id);
      if (held) held.canceled = true;
      else cancel(id);
    };
    window.flushCaret = (id) => {
      const held = frames.get(id);
      if (!held) throw new Error("Missing held caret frame: " + id);
      frames.delete(id);
      // Deliberately invoke even canceled frames. A stale callback must also
      // reject its old identity instead of touching a newer operation.
      held.callback(performance.now());
      return held.canceled;
    };
  });
  const state = () =>
    input.evaluate((node) => ({
      value: node.value,
      start: node.selectionStart,
      end: node.selectionEnd,
      focused: document.activeElement === node,
    }));
  const flush = (id) => page.evaluate((id) => window.flushCaret(id), id);
  const heldPick = async (draft = "@", caret = draft.length, token = "@") => {
    await input.fill(draft);
    if (caret !== draft.length)
      await input.evaluate((node, caret) => {
        node.setSelectionRange(caret, caret);
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }, caret);
    await menu.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 2);
    await input.press("ArrowUp");
    const previous = await page.evaluate(() => window.latestCaret);
    await page.evaluate(() => window.holdNextCaret());
    await input.press("Enter");
    await closed();
    const insertion = token === "@" ? "@/fixture/file.ts " : "/demo:review";
    const start = token === "@" ? draft.lastIndexOf("@", caret - 1) : 0;
    const expected =
      token === "@" ? draft.slice(0, start) + insertion + draft.slice(caret) : insertion;
    await page.waitForFunction(
      (value) => document.querySelector("textarea").value === value,
      expected,
    );
    const id = await page.evaluate(() => window.latestCaret);
    assert.notEqual(id, previous, "The pick registered the next held frame synchronously");
    return { id, expected, caret: start + insertion.length };
  };

  await mount();
  let pick = await heldPick("before @ suffix", 8);
  assert.equal(await flush(pick.id), false);
  assert.deepEqual(await state(), {
    value: pick.expected,
    start: pick.caret,
    end: pick.caret,
    focused: true,
  });
  assert.ok(
    pick.caret < pick.expected.length,
    "Middle insertion restores the token tail before the suffix",
  );
  cases.push("Normal middle mention insertion preserves suffix and token-tail caret");

  for (const token of ["@", "/"]) {
    await mount();
    pick = await heldPick(token, token.length, token);
    await input.press("ControlOrMeta+A");
    const canceled = await flush(pick.id);
    const selected = await state();
    assert.deepEqual([selected.start, selected.end], [0, pick.expected.length]);
    assert.equal(canceled, true);
    await page.keyboard.insertText(token);
    assert.equal(
      await input.inputValue(),
      token,
      "The new token replaces the entire selected draft",
    );
    cases.push(`${token} native select-all replacement survives a stale caret callback`);
  }

  for (const key of ["Home", "End", "ArrowLeft"]) {
    await mount();
    pick = await heldPick();
    await input.press(key);
    const intended = await state();
    assert.equal(await flush(pick.id), true);
    assert.deepEqual(await state(), intended);
    cases.push(`${key} keeps the user's new caret`);
  }

  await mount();
  pick = await heldPick();
  await input.evaluate((node) => node.setSelectionRange(0, 0));
  await page.keyboard.insertText("x");
  const edited = await state();
  assert.equal(edited.value, "x" + pick.expected);
  assert.equal(edited.start, 1);
  assert.equal(await flush(pick.id), true);
  assert.deepEqual(await state(), edited);
  cases.push("Native beforeinput without keydown cancels the old restoration");

  await mount();
  pick = await heldPick();
  await input.click({ position: { x: 22, y: 15 } });
  const pointed = await state();
  assert.equal(await flush(pick.id), true);
  assert.deepEqual(await state(), pointed);
  cases.push("Pointer caret placement owns the selection");

  await mount();
  pick = await heldPick();
  const outside = page.locator("[data-caret-outside]");
  await outside.focus();
  assert.equal(await flush(pick.id), true);
  assert.ok(await outside.evaluate((node) => document.activeElement === node));
  cases.push("Programmatic outside focus and blur never return focus to the composer");

  await mount();
  pick = await heldPick();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await input.evaluate((node) => node.setSelectionRange(0, 0));
  const blurred = await state();
  assert.equal(await flush(pick.id), true);
  assert.deepEqual(await state(), blurred);
  cases.push("Window blur invalidates the pending restoration");

  await mount();
  const first = await heldPick();
  const second = await heldPick("x @ z", 3);
  const beforeOld = await state();
  assert.equal(await flush(first.id), true);
  assert.deepEqual(await state(), beforeOld);
  assert.equal(await flush(second.id), false);
  assert.deepEqual(await state(), {
    value: second.expected,
    start: second.caret,
    end: second.caret,
    focused: true,
  });
  cases.push("A newer pick supersedes the older frame while retaining its own restoration");

  await mount();
  pick = await heldPick();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await accepted("sent", pick.expected.trim(), 1);
  const sent = await state();
  assert.equal(await flush(pick.id), true);
  assert.deepEqual(await state(), sent);
  cases.push("Accepted send clears the draft and invalidates its old pick frame");

  await mount();
  pick = await heldPick();
  await page.evaluate(() => window.replaceDraft("external replacement"));
  await page.waitForFunction(
    () => document.querySelector("textarea").value === "external replacement",
  );
  await input.evaluate((node) => node.setSelectionRange(2, 2));
  const replaced = await state();
  assert.equal(await flush(pick.id), true);
  assert.deepEqual(await state(), replaced);
  cases.push("An externally replaced controlled draft rejects a mismatched restoration");

  await mount();
  pick = await heldPick();
  await page.evaluate(() => window.changeSession("new-session"));
  await page.locator('[data-session="new-session"]').waitFor();
  await input.evaluate((node) => node.setSelectionRange(0, 0));
  const changed = await state();
  assert.equal(await flush(pick.id), true);
  assert.deepEqual(await state(), changed);
  cases.push("Switching the conversation scope invalidates the old frame");

  await mount();
  pick = await heldPick();
  const oldInput = await input.elementHandle();
  await mount();
  assert.equal(await oldInput.evaluate((node) => node.isConnected), false);
  await outside.focus();
  assert.equal(await flush(pick.id), true);
  assert.equal(await input.inputValue(), "");
  assert.ok(await outside.evaluate((node) => document.activeElement === node));
  cases.push("Unmounting rejects the stale frame and preserves the new surface's focus");
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ result: "pass", cases }, null, 2));
} finally {
  await browser.close();
}
