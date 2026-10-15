/* Production composer geometry, keyboard and native textbox/portal accessibility. */
/* Chromium AX relationships are checked here; screen-reader speech is not. */
/* global document, window, requestAnimationFrame, MutationObserver */
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
  const files=Array.from({length:12},(_,i)=>({path:'/fixture/file'+i+'.ts',name:'file'+i+'.ts',relativePath:'file'+i+'.ts',kind:'file',rootId:'root'}));
  window.pendingFileSearches=new Map();
  window.resolveFileSearch=(query,count)=>{
    const resolve=window.pendingFileSearches.get(query);
    if(!resolve) throw new Error('No pending search: '+query);
    window.pendingFileSearches.delete(query);
    resolve(files.slice(0,count));
  };
  window.codeshell={sttAvailable:async()=>({available:false}),listPluginCommands:async()=>commands,
    onPluginCommandsChanged:()=>()=>{},listSkills:async()=>skills,inspectAttachments:async()=>[],
    searchProjectFiles:async(_project,query)=>query.startsWith('__deferred')
      ?new Promise(resolve=>window.pendingFileSearches.set(query,resolve))
      :query==='__none__'?[]:query==='__reverse__'?[...files].reverse():files,
    getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']})};
  window.sends=[];
  const noop=()=>{};
  function Composer() {
    const [draft,setDraft]=React.useState('');
    const [contextTokens,setContextTokens]=React.useState(0);
    window.bumpContext=()=>setContextTokens(value=>value+100);
    return <ChatView variant="main" messages={[]} onSend={(text)=>window.sends.push(text)} onStop={noop} busy={false}
          activeProjectId="project" permissionMode="plan" onPermissionChange={noop} goalEnabled={false} onGoalToggle={noop}
          modelOptions={[{key:'model',label:'Model',provider:'demo'}]} activeModelKey="model" onModelChange={noop}
          contextTokens={contextTokens} projects={[]} onSelectProject={noop} onAddProject={noop}
          configurationTarget={{projectId:'project'}} configurationAvailable conversationRoot="/fixture" conversationRootId="root"
          draft={draft} onDraftChange={setDraft} attachments={[]} onAttachmentsChange={noop}/>;
  }
  function Fixture({narrowPane,multiple=false}) {
    return <main style={{position:'fixed',inset:0,display:'flex',justifyContent:'flex-end',overflow:'hidden'}}>
      {Array.from({length:multiple?2:1},(_,index)=><section key={index}
        style={{height:'100%',width:multiple?'50%':narrowPane?260:'100%',overflow:'hidden',border:'1px solid transparent'}}>
        <Composer/>
      </section>)}
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

async function association(input, menu, { empty = false } = {}) {
  await menu.waitFor();
  if (!empty) await menu.getByRole("option", { selected: true }).waitFor();
  const state = await input.evaluate((node) => {
    const controls = node.getAttribute("aria-controls");
    const activeId = node.getAttribute("aria-activedescendant");
    const list = controls && document.getElementById(controls);
    const active = activeId && document.getElementById(activeId);
    const selected = list?.querySelectorAll('[role="option"][aria-selected="true"]');
    return {
      role: node.getAttribute("role"),
      label: node.getAttribute("aria-label"),
      autocomplete: node.getAttribute("aria-autocomplete"),
      hasPopup: node.getAttribute("aria-haspopup"),
      expanded: node.getAttribute("aria-expanded"),
      controls,
      activeId,
      selectedId: selected?.[0]?.id,
      selectedCount: selected?.length,
      optionCount: list?.querySelectorAll('[role="option"]').length,
      controlledRole: list?.getAttribute("role"),
      containsActive: !!active && list?.contains(active),
      focused: document.activeElement === node,
    };
  });
  assert.equal(state.role, null, "The multiline textarea retains its native textbox role");
  assert.ok(state.label, "The composer has a stable accessible label");
  assert.equal(state.expanded, null, "aria-expanded is not supported on a native textbox");
  assert.equal(state.autocomplete, "list");
  assert.equal(state.hasPopup, "listbox");
  assert.equal(state.controls, await menu.getAttribute("id"));
  assert.equal(state.controlledRole, "listbox");
  assert.equal(state.focused, true, "DOM focus stays in the composer");
  assert.equal(state.selectedCount, empty ? 0 : 1);
  if (empty) {
    assert.equal(state.optionCount, 0);
    assert.equal(state.activeId, null, "An empty result has no active descendant");
  } else {
    assert.ok(state.activeId);
    assert.equal(state.activeId, state.selectedId);
    assert.equal(state.containsActive, true, "The active option belongs to the actual portal");
  }
  return state;
}

async function assertAX(page, state) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const property = (node, name) => node.properties?.find((item) => item.name === name)?.value;
    const textbox = nodes.find(
      (node) =>
        node.role?.value === "textbox" &&
        property(node, "controls")?.relatedNodes?.some((item) => item.idref === state.controls),
    );
    assert.ok(textbox, "The native textbox exposes its controlled listbox in Chromium's AX tree");
    assert.equal(property(textbox, "multiline")?.value, true);
    assert.equal(property(textbox, "autocomplete")?.value, "list");
    assert.equal(property(textbox, "hasPopup")?.value, "listbox");
    const target = property(textbox, "activedescendant")?.relatedNodes?.[0];
    if (!state.activeId) {
      assert.equal(target, undefined, "Empty results do not expose a stale AX target");
      return;
    }
    assert.equal(target?.idref, state.activeId);
    const option = nodes.find((node) => node.backendDOMNodeId === target.backendDOMNodeId);
    assert.equal(
      option?.role?.value,
      "option",
      "The mounted active descendant is exposed as an AX option",
    );
    assert.equal(property(option, "selected")?.value, true);
  } finally {
    await cdp.detach();
  }
}

async function assertClosed(input, menu) {
  await menu.waitFor({ state: "hidden" });
  assert.equal(await input.getAttribute("aria-controls"), null);
  assert.equal(await input.getAttribute("aria-activedescendant"), null);
}

async function waitForOptionCount(page, menu, count) {
  await page.waitForFunction(
    ({ id, count }) =>
      document.getElementById(id)?.querySelectorAll('[role="option"]').length === count,
    { id: await menu.getAttribute("id"), count },
  );
}

async function waitForPick(page, input, expected) {
  await page.waitForFunction((value) => {
    const node = document.querySelector("textarea");
    return (
      node?.value === value &&
      node.selectionStart === value.length &&
      node.selectionEnd === value.length &&
      document.activeElement === node
    );
  }, expected);
  // A pick schedules caret restoration for the next paint. Let it finish
  // before fill() starts its select-all/insertText replacement sequence.
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await input.inputValue(), expected);
}

async function asynchronousResults(page, input) {
  const menu = page.getByRole("listbox");
  await input.fill("/");
  await menu.waitFor();
  await waitForOptionCount(page, menu, 21);
  await input.press("ArrowUp");
  const slashLast = await association(input, menu);
  await input.fill("/demo:command19");
  await waitForOptionCount(page, menu, 1);
  const narrowed = await association(input, menu);
  assert.equal(narrowed.activeId, slashLast.activeId, "Filtering preserves command identity");
  await assertAX(page, narrowed);
  await input.press("Escape");
  await assertClosed(input, menu);

  await input.fill("@");
  await menu.waitFor();
  await waitForOptionCount(page, menu, 20);
  const original = await association(input, menu);
  const firstFileId = await menu.getByRole("option").nth(8).getAttribute("id");
  await input.press("ArrowUp");
  const last = await association(input, menu);

  await input.fill("@__deferred_shrink__");
  await page.waitForFunction(() => window.pendingFileSearches.has("__deferred_shrink__"));
  await input.press("ArrowUp");
  assert.equal((await association(input, menu)).activeId, last.activeId);
  await page.evaluate(() => window.resolveFileSearch("__deferred_shrink__", 1));
  await waitForOptionCount(page, menu, 1);
  const shrunk = await association(input, menu);
  assert.equal(shrunk.activeId, firstFileId, "Clamping points to the surviving mounted option");
  await assertAX(page, shrunk);

  await input.fill("@__reverse__");
  await waitForOptionCount(page, menu, 12);
  const reversed = await association(input, menu);
  assert.equal(reversed.activeId, last.activeId, "Option identity survives list reordering");

  await input.fill("@__deferred_empty__");
  await page.waitForFunction(() => window.pendingFileSearches.has("__deferred_empty__"));
  await input.press("ArrowUp");
  await association(input, menu);
  await page.evaluate(() => window.resolveFileSearch("__deferred_empty__", 0));
  await waitForOptionCount(page, menu, 0);
  await assertAX(page, await association(input, menu, { empty: true }));

  await input.fill("@__deferred_close__");
  await page.waitForFunction(() => window.pendingFileSearches.has("__deferred_close__"));
  await input.press("Escape");
  await assertClosed(input, menu);
  await page.evaluate(async () => {
    window.resolveFileSearch("__deferred_close__", 12);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await assertClosed(input, menu);
  await input.fill("@");
  await menu.waitFor();
  await waitForOptionCount(page, menu, 20);
  const reopened = await association(input, menu);
  assert.equal(reopened.controls, original.controls);
  assert.equal(reopened.activeId, original.activeId);
  await input.press("Escape");
  await assertClosed(input, menu);
}

async function multipleComposers(page) {
  await page.evaluate(() => window.renderFixture({ lang: "en", multiple: true }));
  const inputs = page.locator("textarea");
  await page.waitForFunction(() => document.querySelectorAll("textarea").length === 2);
  const first = inputs.nth(0);
  const second = inputs.nth(1);
  await first.fill("/");
  await page.waitForFunction(() =>
    document.querySelectorAll("textarea")[0].hasAttribute("aria-controls"),
  );
  const firstId = await first.getAttribute("aria-controls");
  const firstMenu = page.locator(`[id=${JSON.stringify(firstId)}]`);
  await waitForOptionCount(page, firstMenu, 21);
  const firstState = await association(first, firstMenu);
  await second.fill("/");
  await page.waitForFunction(() =>
    document.querySelectorAll("textarea")[1].hasAttribute("aria-controls"),
  );
  const secondId = await second.getAttribute("aria-controls");
  const secondMenu = page.locator(`[id=${JSON.stringify(secondId)}]`);
  await waitForOptionCount(page, secondMenu, 21);
  const secondState = await association(second, secondMenu);
  assert.notEqual(firstId, secondId, "Each composer owns a distinct listbox");
  assert.notEqual(firstState.activeId, secondState.activeId);
  await assertClosed(first, firstMenu);
  assert.deepEqual(await association(second, secondMenu), secondState);
  await assertAX(page, secondState);
  await first.click();
  const reopened = await association(first, firstMenu);
  assert.equal(reopened.activeId, firstState.activeId);
  await assertClosed(second, secondMenu);
  await association(first, firstMenu);
  await first.press("Escape");
  await assertClosed(first, firstMenu);
}

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
        await page.evaluate(() => {
          window.associationViolations = [];
          new MutationObserver(() => {
            for (const node of document.querySelectorAll("textarea")) {
              const controls = node.getAttribute("aria-controls");
              const activeId = node.getAttribute("aria-activedescendant");
              const list = controls && document.getElementById(controls);
              const active = activeId && document.getElementById(activeId);
              if (
                (controls && list?.getAttribute("role") !== "listbox") ||
                (activeId &&
                  (!list?.contains(active) || active?.getAttribute("aria-selected") !== "true"))
              )
                window.associationViolations.push({ controls, activeId });
            }
          }).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["id", "aria-controls", "aria-activedescendant", "aria-selected"],
          });
        });
        for (const token of ["@", "/"]) {
          await input.fill(token);
          const menu = page.getByRole("listbox");
          await menu.waitFor();
          await page.waitForTimeout(250);
          const opened = recordOnly ? null : await association(input, menu);
          let phase = "open";
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
              await assertAX(page, await association(input, menu));
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
              phase = "scroll";
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
              assert.equal((await association(input, menu)).activeId, opened.activeId);
              phase = "keyboard";
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
              const last = await association(input, menu);
              await assertAX(page, last);
              await input.press("ArrowDown");
              assert.equal((await association(input, menu)).activeId, opened.activeId);
              await input.press("ArrowUp");
              assert.equal((await association(input, menu)).activeId, last.activeId);
              phase = "pick";
              await selected.click();
              await assertClosed(input, menu);
              const pickedDraft = token === "@" ? "@/fixture/file11.ts " : "/demo:command19 ";
              // Closing the portal is only one part of a pick. Check the
              // controlled draft, then let the pick's scheduled caret restore
              // finish before replacing the input again.
              await waitForPick(page, input, pickedDraft);
              assert.ok(
                await input.evaluate((node) => document.activeElement === node),
                "Pointer selection retains composer focus",
              );
              assert.equal(
                await page.evaluate(() => window.sends.length),
                0,
                "Picking a suggestion never sends the draft",
              );
              for (const key of ["Enter", "Tab"]) {
                phase = `pick-${key}`;
                await input.fill(token);
                await menu.waitFor();
                await waitForOptionCount(page, menu, opened.optionCount);
                await input.press("ArrowUp");
                assert.equal((await association(input, menu)).activeId, last.activeId);
                await input.press(key);
                await assertClosed(input, menu);
                await waitForPick(page, input, pickedDraft);
                assert.equal(await page.evaluate(() => window.sends.length), 0);
              }
              phase = "reopen";
              await input.fill(token);
              await menu.waitFor();
              await waitForOptionCount(page, menu, opened.optionCount);
              assert.deepEqual(await association(input, menu), opened);
              assert.equal(
                await input.inputValue(),
                token,
                "A fresh token replaces the picked draft",
              );
              // A transient blur must not close this new query after focus has
              // already returned. The resize below outlives the blur callback.
              await input.evaluate((node) => {
                node.blur();
                node.focus();
              });
              phase = "resize";
              await page.setViewportSize({ width: 320, height: 240 });
              await page.waitForTimeout(200);
              await measure("resize");
              phase = "blur";
              await input.evaluate((node) => node.blur());
              await assertClosed(input, menu);
              await input.click();
              await menu.waitFor();
              await waitForOptionCount(page, menu, opened.optionCount);
              assert.deepEqual(await association(input, menu), opened);
            }
          } catch (error) {
            const inputState = await input.evaluate((node) => ({
              value: node.value,
              selectionStart: node.selectionStart,
              selectionEnd: node.selectionEnd,
              focused: document.activeElement === node,
            }));
            failures.push(
              `${JSON.stringify({ lang, viewport, narrowPane, token, phase, inputState })}\n${error.message}`,
            );
            console.error(failures.at(-1));
          }
          await input.press("Escape");
          if (recordOnly) await menu.waitFor({ state: "hidden" });
          else {
            await assertClosed(input, menu);
            assert.equal(await input.inputValue(), token, "Escape preserves the draft");
            assert.ok(await input.evaluate((node) => document.activeElement === node));
          }
          await page.setViewportSize(viewport);
        }
        if (!recordOnly && lang === "en" && viewport.width === 800 && !narrowPane) {
          const menu = page.getByRole("listbox");
          for (const token of ["/", "@"]) {
            await input.fill(`${token}__none__`);
            await menu.waitFor();
            await waitForOptionCount(page, menu, 0);
            await assertAX(page, await association(input, menu, { empty: true }));
            for (const key of ["ArrowDown", "ArrowUp"]) {
              await input.press(key);
              await association(input, menu, { empty: true });
            }
            await input.press("Tab");
            await assertClosed(input, menu);
            assert.equal(await input.inputValue(), `${token}__none__`);
            assert.equal(await page.evaluate(() => window.sends.length), 0);
            await input.click();
            await menu.waitFor();
            await waitForOptionCount(page, menu, 0);
            await association(input, menu, { empty: true });
            await input.press("Escape");
            await assertClosed(input, menu);
          }
          await asynchronousResults(page, input);
          await multipleComposers(page);
        }
        if (!recordOnly)
          assert.deepEqual(
            await page.evaluate(() => window.associationViolations),
            [],
            "Observed DOM updates never leave a missing or unselected active descendant",
          );
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
