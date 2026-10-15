/* Resolved AskUser receipts through production ChatView/CSS; fixture-owned bridge and no network. */
/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const sourceDesktop =
  process.argv.find((arg) => arg.startsWith("--source-desktop="))?.slice(17) || desktop;
const baseline = process.argv.includes("--expect-baseline-overflow");
const renderer = path.join(sourceDesktop, "src/renderer");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  "/tmp/codeshell-ask-receipt-qa";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';import {ChatView} from './ChatView';
import {I18nProvider} from './i18n/I18nProvider';import {ToastProvider} from './ui/ToastProvider';
import {saveUILanguage} from './uiLanguage';import {applyTheme,saveTheme} from './theme';
const noop=()=>{};window.codeshell={sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>noop,listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:false}),log:noop};
const root=createRoot(document.getElementById('root'));
window.renderFixture=({width,lang,mode,variant})=>{localStorage.clear();saveUILanguage(lang);saveTheme(mode);applyTheme(mode);
const hash='a17b2090d5ff334d'.repeat(32);
const answers=[{key:'approved',answer:lang==='zh'?'允许本次':'Allow once',tone:'ok'},
{key:'denied',answer:lang==='zh'?'拒绝':'Deny',tone:'danger'},
{key:'url',answer:'https://fixture.example/reports/'+hash+'?request='+hash},
{key:'hash',answer:hash,tone:'ok'},
{key:'multiline',answer:'  '+(lang==='zh'?'检查记录':'Review notes')+String.fromCharCode(10)+Array.from({length:48},(_,i)=>(i+1)+'. '+(lang==='zh'?'保留原始换行与完整答案':'Preserve original lines and the complete answer')).join(String.fromCharCode(10))+String.fromCharCode(10)+'RECEIPT-END'}];
window.receiptAnswers=answers;
const messages=answers.map(({key,answer,tone})=>({kind:'ask_user',id:key,requestId:'receipt-'+key,question:key==='hash'?(lang==='zh'?'本次检查已确认。':'The review choice is confirmed.')+String.fromCharCode(10)+'question_identifier_'+hash:(lang==='zh'?'本次检查已确认。':'The review choice is confirmed.'),header:key==='hash'?'review_identifier'+String.fromCharCode(10)+hash:key,answer,multiSelect:false,options:tone?[{label:answer,tone}]:undefined}));
window.receiptLongPrompt=messages.find(message=>message.id==='hash');
root.render(<I18nProvider><ToastProvider><main data-fixture-pane style={{position:'fixed',top:0,left:0,width,height:540,overflow:'hidden'}}><ChatView variant={variant} messages={messages} onSend={noop} onStop={noop} busy={false} activeProjectId={null} permissionMode='default' onPermissionChange={noop} goalEnabled={false} onGoalToggle={noop} modelOptions={[]} activeModelKey={null} onModelChange={noop} contextTokens={0} projects={[]} onSelectProject={noop} onAddProject={noop} configurationTarget={{noRepo:true}} configurationAvailable conversationRoot={null} conversationRootId={null} draft='' onDraftChange={noop} attachments={[]} onAttachmentsChange={noop} onAskUserAnswer={()=>{throw new Error('Resolved receipts must not submit')}}/></main></ToastProvider></I18nProvider>);};
`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
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
const reports = [],
  errors = [],
  blocked = [];
async function mount(options) {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    serviceWorkers: "block",
    colorScheme: options.mode,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://receipt-fixture.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://receipt-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.evaluate((options) => window.renderFixture(options), options);
  await page.locator("textarea").waitFor();
  return page;
}
async function measure(locator) {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const bounds = el.getBoundingClientRect();
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
    // pre-wrap deliberately hangs trailing spaces beyond a soft line break.
    // Measure visible glyphs so whitespace-only rectangles cannot mimic clipping.
    const glyphs = [];
    const walker = document.createTreeWalker(el, 4);
    let node;
    while ((node = walker.nextNode()))
      for (let index = 0; index < node.textContent.length; index++) {
        if (/\s/.test(node.textContent[index])) continue;
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0) glyphs.push(rect);
      }
    return {
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      whiteSpace: getComputedStyle(el).whiteSpace,
      text: el.textContent,
      lines: lines.length,
      lineOverflow: glyphs.some(
        (rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1,
      ),
      rect: bounds.toJSON(),
    };
  });
}
async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(output, name + ".png"),
    clip: await page.locator("[data-fixture-pane]").boundingBox(),
  });
}
try {
  for (const width of baseline ? [390] : [320, 390])
    for (const variant of baseline ? ["main"] : ["main", "quickChat"])
      for (const lang of baseline ? ["zh"] : ["zh", "en"])
        for (const mode of baseline ? ["light"] : ["light", "dark"]) {
          const page = await mount({ width, variant, lang, mode });
          const expected = await page.evaluate(() => window.receiptAnswers);
          const results = [];
          for (const answer of expected) {
            const locator = page.getByText(answer.answer, { exact: true });
            await locator.waitFor({ state: "attached" });
            const value = await measure(locator);
            assert.equal(value.text, answer.answer, "Every original character is retained");
            if (!baseline) {
              assert.equal(
                value.lineOverflow,
                false,
                answer.key + ": all text lines stay within the receipt",
              );
              assert.ok(
                value.scrollWidth <= value.clientWidth + 1,
                answer.key + ": no horizontal scrolling or crop",
              );
              assert.ok(
                value.rect.x >= 0 && value.rect.right <= width + 1,
                answer.key + ": fits its pane",
              );
              assert.equal(value.whiteSpace, "pre-wrap");
              if (answer.key === "multiline")
                assert.ok(value.lines >= 50, "Original line breaks stay visible");
            }
            results.push({
              key: answer.key,
              ...value,
              textLength: value.text.length,
              text: undefined,
            });
          }
          const prompt = await page.evaluate(() => window.receiptLongPrompt);
          for (const field of ["header", "question"]) {
            const value = await measure(page.getByText(prompt[field], { exact: true }));
            assert.equal(value.text, prompt[field]);
            if (!baseline) {
              assert.equal(
                value.lineOverflow,
                false,
                `Long ${field} stays inside the receipt card`,
              );
              assert.ok(value.scrollWidth <= value.clientWidth + 1);
              assert.equal(value.whiteSpace, "pre-wrap");
            }
            results.push({ key: field, ...value, text: undefined, textLength: value.text.length });
          }
          if (baseline) {
            assert.ok(
              results.find((item) => item.key === "hash").rect.right > width,
              "Baseline hash extends beyond the visible pane",
            );
            assert.notEqual(
              results.find((item) => item.key === "multiline").whiteSpace,
              "pre-wrap",
              "Baseline collapses original line breaks",
            );
          }
          const hash = page.getByText(expected.find((item) => item.key === "hash").answer, {
            exact: true,
          });
          await hash.scrollIntoViewIfNeeded();
          await screenshot(
            page,
            `${baseline ? "before" : "after"}-${variant}-${width}-${lang}-${mode}`,
          );
          if (!baseline) {
            const pill = hash.locator("..");
            const icon = await pill.locator("svg").boundingBox();
            assert.ok(
              icon.width >= 11 && icon.width <= 13,
              "The status icon keeps its size next to a long receipt",
            );
            const multiline = page.getByText(
              expected.find((item) => item.key === "multiline").answer,
              { exact: true },
            );
            await multiline.evaluate((el) => {
              const scroll = el.closest(".cs-chat-transcript").parentElement;
              scroll.scrollTop = scroll.scrollHeight;
            });
            const tail = await multiline.evaluate((el) => {
              const range = document.createRange();
              const node = el.firstChild;
              range.setStart(node, node.textContent.length - "RECEIPT-END".length);
              range.setEnd(node, node.textContent.length);
              const rect = range.getBoundingClientRect();
              const scroller = el
                .closest(".cs-chat-transcript")
                .parentElement.getBoundingClientRect();
              return {
                top: rect.top,
                bottom: rect.bottom,
                scrollTop: scroller.top,
                scrollBottom: scroller.bottom,
                text: range.toString(),
              };
            });
            assert.equal(tail.text, "RECEIPT-END");
            assert.ok(
              tail.top >= tail.scrollTop - 1 && tail.bottom <= tail.scrollBottom + 1,
              "The final answer line can be brought fully into view",
            );
            if (width === 320 && lang === "en" && mode === "dark")
              await screenshot(page, `after-multiline-${variant}-320-en-dark`);
          }
          reports.push({ width, variant, lang, mode, results });
          await page.close();
        }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ baseline, reports, errors, blocked }, null, 2),
  );
  console.log(
    "PASS resolved AskUser receipts: " +
      (baseline
        ? "baseline overflow reproduced"
        : "16 real ChatView layouts, full URL/hash/newline answers and scrollable final line") +
      ". Evidence: " +
      output,
  );
} finally {
  await browser.close();
}
