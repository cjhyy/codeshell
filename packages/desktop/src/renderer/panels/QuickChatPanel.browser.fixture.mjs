/* Real quick-chat panel layout, theme, lifecycle controls and portaled menus. */
/* global document, window, requestAnimationFrame, getComputedStyle */
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
const output = "/tmp/codeshell-quick-chat-qa";
const previewOnly = process.argv.includes("--preview-only");
await mkdir(output, { recursive: true });

const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {QuickChatPanel} from './panels/QuickChatPanel';
  import {I18nProvider} from './i18n/I18nProvider';
  import {translate} from './i18n/translate';
  import {saveUILanguage} from './uiLanguage';
  window.codeshell={
    sttAvailable:async()=>({available:false}),
    listPluginCommands:async()=>[],onPluginCommandsChanged:()=>()=>{},
    listSkills:async()=>[],inspectAttachments:async()=>[],searchProjectFiles:async()=>[],
    getProjectGitBranches:async()=>({isRepo:true,current:'main',branches:['main']}),
  };
  const models=Array.from({length:18},(_,index)=>({
    key:'model-'+index,label:'Fixture Model '+index+' with a descriptive name',
    provider:'fixture',supportsVision:true,
  }));
  function Fixture({state,width,lang,presentation}) {
    const [mode,setMode]=React.useState(state);
    const [draft,setDraft]=React.useState('');
    const [attachments,setAttachments]=React.useState([]);
    const [permission,setPermission]=React.useState('plan');
    const [model,setModel]=React.useState('model-0');
    const [busy,setBusy]=React.useState(false);
    const [sent,setSent]=React.useState([]);
    const inherited=mode!=='empty';
    const messages=mode==='active'?[
      {kind:'user',id:'question',text:lang==='zh'?'帮我整理这个方案的重点，给出下一步建议。':'Summarize this approach and suggest the next step.'},
      {kind:'assistant',id:'answer',done:true,text:lang==='zh'
        ?'可以先明确目标，再检查关键约束。\\n\\n- 保留当前讨论的上下文\\n- 把复杂任务拆成可以验证的小步骤\\n\\n'+('补充信息：这是一段用来验证窄面板换行和滚动的内容。'.repeat(8))
        :'Start with the goal, then check the constraints.\\n\\n- Keep the current conversation context\\n- Split the task into small verifiable steps\\n\\n'+('Additional detail to verify wrapping and scrolling in a narrow panel. '.repeat(8))},
      ...sent,
    ]:sent;
    return <main style={{position:'fixed',inset:0,display:'flex',justifyContent:'flex-end',overflow:'hidden',background:'var(--color-muted)'}}>
      <section id="quick-chat-fixture" style={{width,height:'100%',minWidth:0,overflow:'hidden',transform:'translateZ(0)',borderLeft:'1px solid var(--color-border)'}}>
        <QuickChatPanel sessionId="qchat-fixture-private-session-id" creationNonce="fixture-generation"
          messages={messages} cwd="/fixture/project" busy={busy} liveTurnActive={busy}
          creationStatus={mode==='creating'?'creating':mode==='error'?'error':'ready'}
          creationError={lang==='zh'?'暂时无法复制对话上下文，请重试。':'The conversation context could not be copied. Please try again.'}
          contextMode={inherited?'full':'blank'} copiedEventCount={inherited?12:0}
          sourceTitle={lang==='zh'?'一个很长的原始对话标题，用来验证上下文摘要在窄面板中的呈现方式':'A long source conversation title to verify the context summary in a narrow panel'}
          draft={draft} attachments={attachments} permissionMode={permission}
          modelOptions={presentation?[{...models[0],label:lang==='zh'?'默认模型':'Default model'},...models.slice(1)]:models} activeModelKey={model}
          onPermissionChange={value=>{window.actions.push(['permission',value]);setPermission(value)}}
          onModelChange={value=>{window.actions.push(['model',value.key]);setModel(value.key)}}
          onDraftChange={setDraft} onAttachmentsChange={setAttachments}
          onSend={text=>{window.actions.push(['send',text]);setSent(value=>[...value,{kind:'user',id:'sent-'+value.length,text}]);setBusy(true)}}
          onStop={()=>{window.actions.push(['stop']);setBusy(false)}}
          onRetry={()=>{window.actions.push(['retry']);setMode('creating')}}
          onUseBlank={()=>{window.actions.push(['blank']);setMode('empty')}}/>
      </section>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=props=>{
    saveUILanguage(props.lang);
    document.documentElement.classList.toggle('dark',props.theme==='dark');
    window.actions=[];
    window.labels={send:translate(props.lang,'chat.composer.send'),stop:translate(props.lang,'chat.composer.stop'),
      retry:translate(props.lang,'panels.quickChat.retryFork'),blank:translate(props.lang,'panels.quickChat.useBlank'),
      starters:translate(props.lang,'panels.quickChat.starters'),
      firstPrompt:translate(props.lang,'panels.quickChat.explainPrompt'),
      lastPrompt:translate(props.lang,'panels.quickChat.brainstormPrompt')};
    root.render(<I18nProvider key={JSON.stringify(props)}><Fixture {...props}/></I18nProvider>);
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
const reports = [];
const failures = [];
let interactionCases = 0;
let responsiveCases = 0;

async function responsiveIntro(page, label) {
  const welcome = page.locator(".cs-quick-chat-welcome");
  const geometry = await welcome.evaluate((node) => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).display !== "none";
    };
    const intro = node.querySelector(".cs-quick-chat-intro");
    const icon = node.querySelector(".cs-quick-chat-intro-icon");
    const title = intro.querySelector("h3");
    return {
      height: node.clientHeight,
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      box: node.getBoundingClientRect().toJSON(),
      intro: visible(intro),
      icon: visible(icon),
      iconBox: icon.getBoundingClientRect().toJSON(),
      titleBox: title.getBoundingClientRect().toJSON(),
      description: visible(node.querySelector(".cs-quick-chat-intro-description")),
      starters: visible(node.querySelector(".cs-quick-chat-starters")),
    };
  });
  assert.equal(
    geometry.intro,
    geometry.height > 2 * geometry.rem,
    `${label}: tiny welcome hides intro ${JSON.stringify(geometry)}`,
  );
  assert.equal(
    geometry.icon,
    geometry.height > 16 * geometry.rem,
    `${label}: compact welcome hides decoration ${JSON.stringify(geometry)}`,
  );
  assert.equal(
    geometry.description,
    geometry.height > 9 * geometry.rem,
    `${label}: short welcome hides description ${JSON.stringify(geometry)}`,
  );
  assert.equal(
    geometry.starters,
    geometry.height > 9 * geometry.rem,
    `${label}: short welcome hides starters ${JSON.stringify(geometry)}`,
  );
  if (geometry.intro) {
    assert.ok(
      geometry.titleBox.top >= geometry.box.top - 1 &&
        geometry.titleBox.bottom <= geometry.box.bottom + 1,
      `${label}: simplified title remains fully visible ${JSON.stringify(geometry)}`,
    );
  }
  if (geometry.icon) {
    assert.ok(
      geometry.iconBox.top >= geometry.box.top - 1 &&
        geometry.iconBox.bottom <= geometry.box.bottom + 1,
      `${label}: decorative icon remains fully visible ${JSON.stringify(geometry)}`,
    );
  }
  responsiveCases++;
  return geometry;
}

async function reachable(locator, label) {
  await locator.waitFor();
  await locator.scrollIntoViewIfNeeded();
  const geometry = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const panel = document.getElementById("quick-chat-fixture").getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      box: box.toJSON(),
      panel: panel.toJSON(),
      disabled: node.matches(":disabled"),
      reachable: hit === node || node.contains(hit),
    };
  });
  assert.ok(geometry.box.width > 0 && geometry.box.height > 0, `${label}: has geometry`);
  assert.ok(geometry.box.left >= geometry.panel.left - 1, `${label}: left is inside pane`);
  assert.ok(geometry.box.right <= geometry.panel.right + 1, `${label}: right is inside pane`);
  assert.ok(
    geometry.box.top >= 0 && geometry.box.bottom <= geometry.panel.bottom + 1,
    `${label}: vertically visible ${JSON.stringify(geometry)}`,
  );
  // Disabled send/voice buttons intentionally have pointer-events: none.
  assert.ok(
    geometry.disabled || geometry.reachable,
    `${label}: pointer reaches enabled control ${JSON.stringify(geometry)}`,
  );
}

async function menuWorks(page, opener, kind, label) {
  await reachable(opener, `${label}/${kind} trigger`);
  await opener.click();
  const menu = page.getByRole("listbox");
  await menu.waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector('[role="listbox"]');
    const box = node?.getBoundingClientRect();
    return (
      box &&
      box.left >= 9 &&
      box.top >= 9 &&
      box.right <= window.innerWidth - 9 &&
      box.bottom <= window.innerHeight - 9
    );
  });
  assert.ok(
    await menu.evaluate((node) => node.parentElement === document.body),
    `${label}/${kind}: menu escapes transformed clipping ancestor`,
  );
  assert.ok(
    await menu.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    `${label}/${kind}: menu has no horizontal overflow`,
  );
  if (label === "zh/light/260x280/empty") {
    await page.screenshot({ path: path.join(output, `zh-light-260x280-${kind}-menu.png`) });
  }
  const option = menu.getByRole("option").last();
  await option.scrollIntoViewIfNeeded();
  assert.ok(
    await option.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === node || node.contains(hit);
    }),
    `${label}/${kind}: final option is reachable`,
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.ok(
    await opener.evaluate((node) => document.activeElement === node),
    `${label}/${kind}: Escape restores trigger focus`,
  );
  await opener.click();
  await menu.getByRole("option").last().click();
  await menu.waitFor({ state: "hidden" });
  const actions = await page.evaluate(() => window.actions);
  assert.equal(actions.at(-1)?.[0], kind, `${label}/${kind}: selection callback`);
}

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://quick-chat.test/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://quick-chat.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  for (const lang of previewOnly ? [] : ["zh", "en"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [260, 360, 520]) {
        for (const height of [680, 280]) {
          await page.setViewportSize({ width: 900, height });
          for (const state of ["empty", "inherited", "creating", "error", "active"]) {
            const props = { lang, theme, width, height, state };
            const label = `${lang}/${theme}/${width}x${height}/${state}`;
            const errorCount = errors.length;
            try {
              await page.evaluate((props) => window.renderFixture(props), props);
              await page.waitForFunction(async () => {
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
                return document.getElementById("quick-chat-fixture")?.children.length > 0;
              });
              const panel = page.locator("#quick-chat-fixture");
              const geometry = await panel.evaluate((node) => ({
                clientWidth: node.clientWidth,
                scrollWidth: node.scrollWidth,
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
              }));
              assert.ok(
                geometry.scrollWidth <= geometry.clientWidth + 1,
                `${label}: pane has no horizontal overflow ${JSON.stringify(geometry)}`,
              );
              assert.ok(
                geometry.documentWidth <= geometry.viewportWidth + 1,
                `${label}: document has no horizontal overflow`,
              );
              const welcome =
                state === "empty" || state === "inherited"
                  ? await responsiveIntro(page, label)
                  : undefined;
              reports.push({ ...props, geometry, welcome });
              if (
                (width === 360 && height === 680) ||
                (lang === "zh" && width === 260 && height === 280)
              ) {
                await panel.screenshot({
                  path: path.join(output, `${lang}-${theme}-${width}x${height}-${state}.png`),
                });
              }
              const labels = await page.evaluate(() => window.labels);
              if (state === "creating" || state === "error") {
                if (state === "error") {
                  const retry = page.getByRole("button", { name: labels.retry, exact: true });
                  await reachable(retry, `${label}/retry`);
                  await retry.click();
                  assert.deepEqual(await page.evaluate(() => window.actions), [["retry"]]);
                }
                const blank = page.getByRole("button", { name: labels.blank, exact: true });
                await reachable(blank, `${label}/blank`);
                await blank.click();
                await page.locator("textarea").waitFor();
                assert.equal((await page.evaluate(() => window.actions)).at(-1)?.[0], "blank");
              } else {
                const input = page.locator("textarea");
                await reachable(input, `${label}/textarea`);
                for (const control of await page.locator(".cs-chat-composer button").all()) {
                  await reachable(control, `${label}/toolbar`);
                }
                const send = page.getByRole("button", { name: labels.send, exact: true });
                await reachable(send, `${label}/send`);
                assert.ok(await send.isDisabled(), `${label}: empty draft cannot send`);
                if (state !== "active") {
                  const starters = page.getByRole("group", { name: labels.starters });
                  if (await starters.isVisible()) {
                    const first = starters.getByRole("button").first();
                    await reachable(first, `${label}/starter`);
                    await first.click();
                    await page.waitForFunction((expected) => {
                      const node = document.querySelector("textarea");
                      return node?.value === expected && document.activeElement === node;
                    }, labels.firstPrompt);
                    assert.deepEqual(
                      await page.evaluate(() => window.actions),
                      [],
                      `${label}: starter seeds without sending`,
                    );
                    await input.fill("Existing draft");
                    await starters.getByRole("button").last().click();
                    await page.waitForFunction((expected) => {
                      const node = document.querySelector("textarea");
                      return node?.value === expected && document.activeElement === node;
                    }, `Existing draft\n\n${labels.lastPrompt}`);
                    assert.deepEqual(
                      await page.evaluate(() => window.actions),
                      [],
                      `${label}: starter preserves existing draft without sending`,
                    );
                    await input.fill("");
                  }
                }
                await menuWorks(
                  page,
                  page.locator('button[aria-haspopup="listbox"]:not([data-active-model])'),
                  "permission",
                  label,
                );
                await menuWorks(page, page.locator("[data-active-model]"), "model", label);
                await input.fill("A focused quick-chat message");
                await send.click();
                assert.ok(
                  (await page.evaluate(() => window.actions)).some(
                    (action) =>
                      action[0] === "send" && action[1] === "A focused quick-chat message",
                  ),
                  `${label}: send callback receives draft`,
                );
                assert.equal(await input.inputValue(), "", `${label}: send clears draft`);
                const stop = page.getByRole("button", { name: labels.stop, exact: true });
                await reachable(stop, `${label}/stop`);
                await stop.click();
                assert.equal((await page.evaluate(() => window.actions)).at(-1)?.[0], "stop");
                await send.waitFor();
                if (width === 260 && height === 280 && state === "active") {
                  const longDraft = "A long draft that should remain editable and sendable. "
                    .repeat(80)
                    .trim();
                  await input.fill(longDraft);
                  await reachable(send, `${label}/long-draft send`);
                  const scroll = await page
                    .locator(".cs-quick-chat-composer-wrap")
                    .evaluate((node) => ({
                      scrollHeight: node.scrollHeight,
                      clientHeight: node.clientHeight,
                      scrollWidth: node.scrollWidth,
                      clientWidth: node.clientWidth,
                      scrollTop: node.scrollTop,
                    }));
                  assert.ok(
                    scroll.scrollHeight > scroll.clientHeight,
                    `${label}: long draft gets a scrollable composer ${JSON.stringify(scroll)}`,
                  );
                  assert.ok(
                    scroll.scrollTop > 0,
                    `${label}: send is reached by scrolling the composer ${JSON.stringify(scroll)}`,
                  );
                  assert.ok(
                    scroll.scrollWidth <= scroll.clientWidth + 1,
                    `${label}: long draft has no horizontal overflow`,
                  );
                  await panel.screenshot({
                    path: path.join(output, `${lang}-${theme}-260x280-long-draft.png`),
                  });
                  await send.click();
                  assert.ok(
                    (await page.evaluate(() => window.actions)).some(
                      (action) => action[0] === "send" && action[1] === longDraft,
                    ),
                    `${label}: full long draft reaches the send callback`,
                  );
                  await reachable(stop, `${label}/long-draft stop`);
                  await stop.click();
                }
              }
              interactionCases++;
              assert.deepEqual(errors.slice(errorCount), [], `${label}: browser errors`);
            } catch (error) {
              const screenshot = path.join(
                output,
                `failure-${lang}-${theme}-${width}x${height}-${state}.png`,
              );
              await page.screenshot({ path: screenshot });
              failures.push({ ...props, error: error.message, screenshot });
              console.error(`${label}: ${error.message}`);
              if (process.argv.includes("--fail-fast")) throw error;
            }
          }
        }
      }
    }
  }
  if (!previewOnly) {
    for (const lang of ["zh", "en"]) {
      for (const theme of ["light", "dark"]) {
        for (const state of ["empty", "inherited"]) {
          for (const height of [480, 360, 220]) {
            const props = { lang, theme, width: 360, height, state };
            await page.setViewportSize({ width: 900, height });
            await page.evaluate((props) => window.renderFixture(props), props);
            await page.waitForFunction(async () => {
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              return !!document.querySelector(".cs-quick-chat-welcome");
            });
            const welcome = await responsiveIntro(page, `${lang}/${theme}/360x${height}/${state}`);
            reports.push({ ...props, welcome });
            if (lang === "zh" && theme === "light") {
              await page.locator("#quick-chat-fixture").screenshot({
                path: path.join(output, `${lang}-${theme}-360x${height}-${state}.png`),
              });
            }
          }
        }
      }
    }
  }
  await page.setViewportSize({ width: 900, height: 680 });
  await page.evaluate(() =>
    window.renderFixture({
      lang: "zh",
      theme: "light",
      width: 360,
      height: 680,
      state: "empty",
      presentation: true,
    }),
  );
  await page.waitForFunction(() =>
    document.querySelector("[data-active-model]")?.getAttribute("aria-label")?.includes("默认模型"),
  );
  await page
    .locator("#quick-chat-fixture")
    .screenshot({ path: path.join(output, "preview-light.png") });
  const result = {
    result: failures.length ? "fail" : "pass",
    layoutCases: reports.length,
    interactionCases,
    responsiveCases,
    failures,
    browserErrors: errors,
    output,
  };
  if (!previewOnly) {
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify({ ...result, reports }, null, 2),
    );
  }
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], "No browser errors");
  assert.equal(failures.length, 0, "Quick-chat browser fixture failed; see report.json");
} finally {
  await browser.close();
}
