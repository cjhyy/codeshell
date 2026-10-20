/** Production approval/tool cards in the real main/Quick Chat CSS columns.
 * All actions end at owned callbacks. Network and actual authorization are blocked.
 * node .../ToolCardShell.browser.fixture.mjs [--source-desktop /path/to/packages/desktop]
 */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2),
  measureOnly = args.includes("--measure-status-only"),
  measureChat = args.includes("--measure-chat-only");
const sourceIndex = args.indexOf("--source-desktop");
const ownDesktop = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = sourceIndex < 0 ? ownDesktop : path.resolve(args[sourceIndex + 1]);
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(ownDesktop, "package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const twRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = twRequire("@tailwindcss/node"),
  { Scanner } = twRequire("@tailwindcss/oxide");
const output =
  process.env.CODESHELL_TOOL_CARDS_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-tool-cards-")));
await mkdir(output, { recursive: true });
const toolName = "mcp__workspace_assets__create_selected_design_preview__" + "scope".repeat(5);
const description =
  "Review the explicitly selected workspace resources and preserve the operation target. " +
  "https://owned.invalid/" +
  "resource_segment_".repeat(12);
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ToolCardShell} from './tool-cards/ToolCardShell';import {ApprovalCard} from './approvals/ApprovalCard';
import {ChatView} from './ChatView';import {StatusDot} from './ui/StatusDot';import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';import {applyTheme,saveTheme} from './theme';
const root=createRoot(document.getElementById('root'));let generation=0;
function ChatFixture({variant,envelope,longDraft,message,queued}){
 const [pending,setPending]=React.useState(envelope);
 const [size,setSize]=React.useState({width:'100vw',height:360});window.resizeChatPane=(width,height)=>setSize({width,height});
 const [draft,setDraft]=React.useState(longDraft?('Preserved long composer draft'+String.fromCharCode(10)).repeat(30):'');
 window.replaceApproval=()=>setPending(current=>({...current,requestId:'approval-b',request:{...current.request,toolName:current.request.toolName+'_B'}}));
 const noop=()=>{};
 return <div data-owned-chat-pane style={{position:'fixed',inset:'0 auto auto 0',width:size.width,height:size.height,overflow:'hidden'}}>
  <ChatView variant={variant} messages={[...Array.from({length:30},(_,index)=>[{kind:'user',id:'user-'+index,text:'Owned earlier question '+index},{kind:'assistant',id:'history-'+index,text:'Owned earlier conversation. '.repeat(12),done:true}]).flat(),message]}
   queuedInputItems={queued?Array.from({length:12},(_,index)=>'Owned queued input '+index):[]}
   pendingApproval={pending} onApprovalDecide={(...wire)=>window.calls.decisions.push({requestId:pending.requestId,wire})}
   onSend={text=>window.calls.sends.push(text)} onStop={noop} busy={false} activeProjectId='fixture'
   permissionMode='default' onPermissionChange={noop} goalEnabled={false} onGoalToggle={noop}
   modelOptions={[]} activeModelKey={null} onModelChange={noop} contextTokens={0}
   projects={[]} onSelectProject={noop} onAddProject={noop} configurationTarget={{noRepo:true}}
   configurationAvailable conversationRoot={null} conversationRootId={null}
   draft={draft} onDraftChange={setDraft} attachments={[]} onAttachmentsChange={noop}/>
 </div>;
}
window.mountFixture=({language='en',theme='light',variant='main',risk='high',allowScopes=true,status='failed',surface='cards',longDraft=false,shortApproval=false,queued=false}={})=>{
 localStorage.clear();saveUILanguage(language);saveTheme(theme);applyTheme(theme);
 window.calls={decisions:[],actions:0,selections:0,sends:[]};window.codeshell={sttAvailable:async()=>({available:false}),listPluginCommands:async()=>[],onPluginCommandsChanged:()=>()=>{},listSkills:async()=>[],inspectAttachments:async()=>[],getProjectGitBranches:async()=>({isRepo:false}),log:()=>{}};
 const current=++generation;
 const message={kind:'tool',id:'owned-tool',toolName:${JSON.stringify(toolName)},args:'{}',status,startedAt:0,durationMs:65432};
 const envelope={requestId:'owned-approval',sessionId:'owned-session',request:{toolName:${JSON.stringify(toolName)},description:${JSON.stringify(description)},riskLevel:risk,args:{path:'/owned/workspace/'+ 'target_'.repeat(16)}}};
 root.render(<I18nProvider key={current}><main data-generation={current} data-chat-variant={surface==='chat'?undefined:variant} className="min-w-0 p-4">
  {surface==='chat'?<ChatFixture variant={variant} envelope={shortApproval?{...envelope,request:{...envelope.request,toolName:'Bash',description:'Owned command',args:{command:'printf owned'}}}:envelope} longDraft={longDraft} message={message} queued={queued}/>:<div className="cs-chat-transcript w-full min-w-0 space-y-4">
   <section aria-label="Owned tool card"><ToolCardShell message={message} summary={'Selected target '+ 'long_summary_'.repeat(24)}
    details={<div>Owned expanded details: preserve the exact resource.</div>} preview={<p>Owned result preview</p>}
    headerBadge={<span data-owned-badge className="shrink-0 rounded border px-1 text-xs">MCP</span>}
    headerAction={<button type="button" className="size-8" aria-label="Owned header action" onClick={event=>{event.stopPropagation();window.calls.actions++}}>↗</button>}
    onSelect={()=>window.calls.selections++}/></section>
   <section aria-label="Owned approval card"><ApprovalCard envelope={envelope} allowScopes={allowScopes}
    onDecide={(...decision)=>window.calls.decisions.push(decision)}/></section>
   <section aria-label="Status indicators" className="flex flex-wrap gap-4">
    {['idle','running','ok','warn','err'].map(status=><div key={status} data-owned-status={status} className="flex items-center gap-2"><StatusDot status={status}/><span>{status}</span></div>)}
   </section>
  </div>}
 </main></I18nProvider>);return current;
};`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty", ".png": "empty", ".wav": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
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
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin" && existsSync(macChrome) ? macChrome : undefined),
});
const context = await browser.newContext({
  viewport: { width: 390, height: 700 },
  serviceWorkers: "block",
});
const errors = [],
  blocked = [],
  reports = [],
  cases = [];
await context.route("**/*", (route) => {
  if (route.request().url() === "http://tool-cards-owned.test/")
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div></body></html>',
    });
  blocked.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on("pageerror", (error) => errors.push(error.message));
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const mount = async (config) => {
  const id = await page.evaluate((config) => window.mountFixture(config), config);
  await page.locator(`[data-generation="${id}"]`).waitFor();
  await frames();
  assert.equal(
    await page.locator("[data-chat-variant]").count(),
    1,
    "Only the actual chat root owns its variant",
  );
};
const dots = () =>
  page.locator(".status-dot").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect(),
        css = window.getComputedStyle(node);
      return {
        status: node.getAttribute("aria-label"),
        role: node.getAttribute("role"),
        animation: css.animationName,
        width: box.width,
        height: box.height,
        display: css.display,
        color: css.backgroundColor,
        borderRadius: css.borderRadius,
      };
    }),
  );
const tool = () => page.getByRole("region", { name: "Owned tool card", exact: true });
const approval = () => page.getByRole("region", { name: "Owned approval card", exact: true });
const hit = (locator) =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return Boolean(target && node.contains(target));
  });
const paneControl = async (locator) => {
  const result = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      pane = node.closest("[data-owned-chat-pane]").getBoundingClientRect();
    const clip =
      node.closest(".cs-chat-sticky") ??
      node.closest(".cs-chat-composer-wrap") ??
      node.closest("[data-owned-chat-pane]");
    const bounds = clip.getBoundingClientRect();
    return {
      label: node.getAttribute("aria-label") ?? node.textContent.trim(),
      box: box.toJSON(),
      pane: pane.toJSON(),
      bounds: bounds.toJSON(),
    };
  });
  assert.ok(
    result.box.width > 0 &&
      result.box.height > 0 &&
      result.box.left >= result.pane.left - 1 &&
      result.box.right <= result.pane.right + 1 &&
      result.box.top >= Math.max(result.bounds.top, result.pane.top) - 1 &&
      result.box.bottom <= Math.min(result.bounds.bottom, result.pane.bottom) + 1,
    JSON.stringify(result),
  );
  assert.equal(await hit(locator), true, JSON.stringify(result));
  return result;
};
const fullText = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      card = node.closest("section").getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    return {
      text: node.textContent,
      box: box.toJSON(),
      card: card.toJSON(),
      client: node.clientWidth,
      scroll: node.scrollWidth,
      lines: [...range.getClientRects()].map((rect) => rect.toJSON()),
    };
  });
  assert.ok(result.box.width > 0 && result.scroll <= result.client + 1, JSON.stringify(result));
  for (const line of result.lines)
    assert.ok(
      line.left >= result.card.left - 1 && line.right <= result.card.right + 1,
      JSON.stringify(result),
    );
  return result;
};
const compactToolLabel = async () => {
  const locator = tool().getByText(toolName, { exact: true });
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      card = node.closest("[data-tool-card]"),
      style = window.getComputedStyle(node);
    return {
      text: node.textContent,
      title: node.getAttribute("title"),
      box: box.toJSON(),
      card: card.getBoundingClientRect().toJSON(),
      client: card.clientWidth,
      scroll: card.scrollWidth,
      overflow: style.overflowX,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  // Tool records deliberately use one compact row. The full name remains in
  // the native tooltip and accessible toggle name while its visual label clips.
  assert.equal(result.text, toolName);
  assert.equal(result.title, toolName);
  assert.equal(result.overflow, "hidden");
  assert.equal(result.textOverflow, "ellipsis");
  assert.equal(result.whiteSpace, "nowrap");
  assert.ok(
    result.box.width > 0 &&
      result.box.height > 0 &&
      result.box.left >= result.card.left - 1 &&
      result.box.right <= result.card.right + 1 &&
      result.scroll <= result.client + 1,
    JSON.stringify(result),
  );
  assert.equal(await tool().getByRole("button", { name: toolName }).count(), 1);
  return result;
};
const critical = async (locator) => {
  const result = await fullText(locator);
  const viewport = page.viewportSize();
  assert.ok(
    result.box.top >= -1 && result.box.bottom <= viewport.height + 1,
    JSON.stringify(result),
  );
  assert.equal(await hit(locator), true, result.text);
  return result;
};
try {
  await page.goto("http://tool-cards-owned.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await mount({});
  const statusDots = await dots();
  reports.push({ kind: "status-dots", statusDots });
  console.log(JSON.stringify({ output, desktop, statusDots }, null, 2));
  if (!measureOnly && !measureChat) {
    for (const dot of statusDots) {
      assert.ok(dot.width >= 6 && dot.height >= 6, JSON.stringify(dot));
      assert.ok(!["rgba(0, 0, 0, 0)", "transparent"].includes(dot.color), JSON.stringify(dot));
    }
  }
  if (measureChat) {
    await page.setViewportSize({ width: 320, height: 360 });
    for (const variant of ["main", "quickChat"]) {
      await mount({ surface: "chat", variant, longDraft: true });
      await frames();
      const geometry = await page.locator("[data-owned-chat-pane]").evaluate((pane) => ({
        variant: pane.querySelector("[data-chat-variant]")?.getAttribute("data-chat-variant"),
        pane: pane.getBoundingClientRect().toJSON(),
        sticky: pane.querySelector(".cs-chat-sticky")?.getBoundingClientRect().toJSON(),
        composer: pane.querySelector("textarea")?.getBoundingClientRect().toJSON(),
        buttons: [...pane.querySelectorAll("button")]
          .filter((node) =>
            ["Approve once", "Deny", "Send"].includes(
              node.getAttribute("aria-label") ?? node.textContent.trim(),
            ),
          )
          .map((node) => ({
            label: node.getAttribute("aria-label") ?? node.textContent.trim(),
            box: node.getBoundingClientRect().toJSON(),
          })),
      }));
      reports.push({ kind: "chat-geometry", ...geometry });
      console.log(JSON.stringify(geometry, null, 2));
      await page.screenshot({ path: path.join(output, `chat-${variant}-320x360.png`) });
    }
  }
  if (measureChat) {
    for (const variant of ["main", "quickChat"]) {
      await mount({ surface: "chat", variant, shortApproval: true });
      await page.getByRole("button", { name: "Approve once", exact: true }).last().click();
      await page.evaluate(() => window.replaceApproval());
      await page.locator('[data-request-id="approval-b"]').waitFor();
      await frames();
      assert.ok(await page.getByRole("button", { name: "Approve once", exact: true }).count());
      await page.getByRole("button", { name: "Deny", exact: true }).last().click();
      const decisions = await page.evaluate(() =>
        window.calls.decisions.map(({ requestId, wire }) => ({
          requestId,
          decision: wire[0],
          scope: wire[2] ?? null,
        })),
      );
      assert.deepEqual(decisions, [
        { requestId: "owned-approval", decision: "approve", scope: "once" },
        { requestId: "approval-b", decision: "deny", scope: null },
      ]);
      reports.push({ kind: "approval-identity", variant, decisions });
      console.log(JSON.stringify({ kind: "approval-identity", variant, decisions }));
    }
  }
  if (!measureOnly && !measureChat) {
    for (const language of ["zh", "en"])
      for (const theme of ["light", "dark"])
        for (const variant of ["main", "quickChat"])
          for (const width of [320, 390, 760, 1280]) {
            await page.setViewportSize({ width, height: 700 });
            await mount({ language, theme, variant });
            const toolLabel = await compactToolLabel();
            const approvalLabel = await fullText(approval().getByText(toolName, { exact: true }));
            const approvalDescription = await fullText(
              approval().getByText(description, { exact: true }),
            );
            const risk = await critical(
              approval().getByText(language === "zh" ? "高风险" : "High risk", { exact: true }),
            );
            const error = await critical(tool().getByText("error", { exact: true }));
            const duration = await critical(tool().getByText("1m 5s", { exact: true }));
            await critical(tool().locator("[data-owned-badge]"));
            const action = tool().getByRole("button", { name: "Owned header action", exact: true });
            await critical(action);
            await action.focus();
            await page.keyboard.press("Enter");
            assert.equal(await page.evaluate(() => window.calls.actions), 1);
            const toggle = tool().locator("button[aria-expanded]");
            assert.equal(await toggle.getAttribute("aria-expanded"), "false");
            await toggle.focus();
            await page.keyboard.press("Enter");
            assert.equal(await toggle.getAttribute("aria-expanded"), "true");
            await tool()
              .getByText("Owned expanded details: preserve the exact resource.", { exact: true })
              .waitFor();
            const detailsId = await toggle.getAttribute("aria-controls");
            assert.equal(
              await page.evaluate((id) => document.getElementById(id).hidden, detailsId),
              false,
            );
            await page.keyboard.press("Space");
            assert.equal(await toggle.getAttribute("aria-expanded"), "false");
            assert.equal(
              await tool()
                .getByText("Owned expanded details: preserve the exact resource.", { exact: true })
                .count(),
              0,
            );
            const raw = approval().getByRole("button", {
              name: language === "zh" ? "展开原始参数" : "Show raw arguments",
              exact: true,
            });
            await raw.click();
            await approval().locator("pre").waitFor();
            assert.match(await approval().locator("pre").innerText(), /owned\/workspace/);
            await approval()
              .getByRole("button", {
                name: language === "zh" ? "收起原始参数" : "Hide raw arguments",
                exact: true,
              })
              .click();
            assert.equal(await approval().locator("pre").count(), 0);
            const geometry = await page.evaluate(() => ({
              width: window.innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
            }));
            assert.ok(
              geometry.scrollWidth <= width + 1,
              JSON.stringify({ language, theme, variant, ...geometry }),
            );
            const statusDots = await dots();
            for (const dot of statusDots) {
              assert.equal(dot.role, "img");
              assert.equal(dot.width, 8);
              assert.equal(dot.height, 8);
              assert.ok(parseFloat(dot.borderRadius) >= 4);
              assert.ok(!["transparent", "rgba(0, 0, 0, 0)"].includes(dot.color));
            }
            await page.screenshot({
              path: path.join(output, `cards-${variant}-${language}-${theme}-${width}.png`),
              fullPage: true,
            });
            reports.push({
              kind: "header-layout",
              language,
              theme,
              variant,
              width,
              toolLabel,
              approvalLabel,
              approvalDescription,
              risk,
              error,
              duration,
              statusDots,
            });
          }
    for (const reducedMotion of ["reduce", "no-preference"]) {
      await page.emulateMedia({ reducedMotion });
      await mount({ status: "running" });
      const animation = await page
        .locator(".status-running")
        .first()
        .evaluate((node) => window.getComputedStyle(node).animationName);
      assert.equal(animation === "none", reducedMotion === "reduce");
      cases.push(`running-animation-${reducedMotion}`);
    }
    for (const language of ["zh", "en"])
      for (const allowScopes of [true, false]) {
        await mount({ language, allowScopes });
        const once = approval().getByRole("button", {
          name: language === "zh" ? "仅本次批准" : "Approve once",
          exact: true,
        });
        await once.focus();
        await page.keyboard.press("Enter");
        assert.deepEqual(
          await page.evaluate(() =>
            window.calls.decisions.map((wire) => ({
              decision: wire[0],
              reason: wire[1] ?? null,
              scope: wire[2] ?? null,
              pathScope: wire[3] ?? null,
            })),
          ),
          [{ decision: "approve", reason: null, scope: "once", pathScope: null }],
        );
        assert.equal(await once.count(), 0);
        await mount({ language, allowScopes });
        await approval().getByRole("combobox").click();
        await page.getByRole("option", { name: "wrong target", exact: true }).click();
        const deny = approval().getByRole("button", {
          name: language === "zh" ? "拒绝" : "Deny",
          exact: true,
        });
        await deny.focus();
        await page.keyboard.press("Space");
        assert.deepEqual(
          await page.evaluate(() =>
            window.calls.decisions.map((wire) => ({
              decision: wire[0],
              reason: wire[1] ?? null,
              scope: wire[2] ?? null,
              pathScope: wire[3] ?? null,
            })),
          ),
          [{ decision: "deny", reason: "wrong target", scope: null, pathScope: null }],
        );
        assert.equal(await deny.count(), 0);
        cases.push(`approval-wire-${language}-scopes-${allowScopes}`);
      }
    for (const risk of ["low", "medium", "high"]) {
      await mount({ risk });
      const label = { low: "Low risk", medium: "Medium risk", high: "High risk" }[risk];
      await critical(approval().getByText(label, { exact: true }));
    }
    for (const language of ["zh", "en"])
      for (const theme of ["light", "dark"])
        for (const variant of ["main", "quickChat"])
          for (const width of [320, 390]) {
            await page.setViewportSize({ width, height: 360 });
            await mount({ surface: "chat", language, theme, variant, longDraft: true });
            const sticky = page.locator(".cs-chat-sticky");
            if (!(await sticky.count())) {
              const viewport = await page
                .locator(".cs-chat-transcript")
                .locator("..")
                .boundingBox();
              assert.ok(viewport.height > 0);
              await page.mouse.move(
                viewport.x + viewport.width / 2,
                viewport.y + viewport.height / 2,
              );
              await page.mouse.wheel(0, -20000);
            }
            await sticky.waitFor();
            await frames();
            const once = sticky.getByRole("button", {
              name: language === "zh" ? "仅本次批准" : "Approve once",
              exact: true,
            });
            const deny = sticky.getByRole("button", {
              name: language === "zh" ? "拒绝" : "Deny",
              exact: true,
            });
            await once.focus();
            await paneControl(once);
            await deny.focus();
            await paneControl(deny);
            await page.keyboard.press("Tab");
            assert.equal(
              await sticky
                .getByRole("combobox")
                .evaluate((node) => node === document.activeElement),
              true,
            );
            await page.keyboard.press("Tab");
            assert.equal(
              await page.locator("textarea").evaluate((node) => node === document.activeElement),
              true,
            );
            let foundSend = false;
            for (let index = 0; index < 20; index++) {
              await page.keyboard.press("Tab");
              const name = await page.evaluate(() =>
                document.activeElement?.getAttribute("aria-label"),
              );
              if (name === (language === "zh" ? "发送" : "Send")) {
                foundSend = true;
                break;
              }
            }
            assert.equal(foundSend, true, "Real Tab traversal reaches composer Send");
            const send = page.getByRole("button", {
              name: language === "zh" ? "发送" : "Send",
              exact: true,
            });
            const sendBefore = await paneControl(send);
            await page.evaluate((width) => window.resizeChatPane(width, 240), width);
            await frames();
            assert.equal(await send.evaluate((node) => node === document.activeElement), true);
            const sendAfter = await paneControl(send);
            await page.evaluate((width) => window.resizeChatPane(width, 360), width);
            await frames();
            await deny.focus();
            await paneControl(deny);
            await page.evaluate((width) => window.resizeChatPane(width, 200), width);
            await frames();
            assert.equal(await deny.evaluate((node) => node === document.activeElement), true);
            const denyAfter = await paneControl(deny);
            const draft = await page.locator("textarea").inputValue();
            assert.ok(draft.startsWith("Preserved long composer draft"));
            await once.focus();
            await paneControl(once);
            await page.keyboard.press("Enter");
            await page.evaluate(() => window.replaceApproval());
            await page.locator('[data-request-id="approval-b"]').waitFor();
            await frames();
            const nextDeny = page
              .locator(".cs-chat-sticky")
              .getByRole("button", { name: language === "zh" ? "拒绝" : "Deny", exact: true });
            await nextDeny.focus();
            await paneControl(nextDeny);
            await page.keyboard.press("Enter");
            assert.deepEqual(
              await page.evaluate(() =>
                window.calls.decisions.map(({ requestId, wire }) => ({
                  requestId,
                  decision: wire[0],
                  scope: wire[2] ?? null,
                })),
              ),
              [
                { requestId: "owned-approval", decision: "approve", scope: "once" },
                { requestId: "approval-b", decision: "deny", scope: null },
              ],
            );
            assert.deepEqual(await page.evaluate(() => window.calls.sends), []);
            await page.screenshot({
              path: path.join(output, `chat-${variant}-${language}-${theme}-${width}.png`),
            });
            reports.push({
              kind: "chat-layout",
              language,
              theme,
              variant,
              width,
              sendBefore,
              sendAfter,
              denyAfter,
            });
          }
    for (const variant of ["main", "quickChat"]) {
      await page.setViewportSize({ width: 800, height: 480 });
      await mount({ surface: "chat", variant, longDraft: true, shortApproval: true, queued: true });
      await page.evaluate(() => window.resizeChatPane(800, 480));
      const states = await page.evaluate(async () => {
        for (let index = 0; index < 20; index++) await new Promise(requestAnimationFrame);
        const values = [];
        for (let index = 0; index < 120; index++) {
          await new Promise(requestAnimationFrame);
          const root = document.querySelector("[data-owned-chat-pane] [data-chat-variant]");
          const composer = root.querySelector(".cs-chat-composer-wrap").getBoundingClientRect();
          values.push({
            pending: root.getAttribute("data-pending-interaction"),
            sticky: Boolean(root.querySelector(".cs-chat-sticky")),
            composerHeight: composer.height,
          });
        }
        return values;
      });
      assert.equal(states.length, 120);
      assert.equal(
        new Set(states.map((state) => JSON.stringify(state))).size,
        1,
        "Native inline approval visibility must settle without layout feedback",
      );
      assert.equal(states[0].pending, "true");
      assert.ok(states[0].composerHeight <= 480 * 0.4 + 1);
      const send = page.getByRole("button", { name: "Send", exact: true });
      await send.focus();
      await paneControl(send);
      reports.push({
        kind: "approval-io-stability",
        variant,
        frames: states.length,
        state: states[0],
      });
      cases.push(`queued-approval-native-io-stable-${variant}`);
    }
    for (const variant of ["main", "quickChat"]) {
      await page.setViewportSize({ width: 800, height: 480 });
      await mount({ surface: "chat", variant, longDraft: true, shortApproval: true, queued: true });
      await page.evaluate(() => window.resizeChatPane(800, 480));
      await frames();
      const sticky = page.locator(".cs-chat-sticky");
      if (!(await sticky.count())) {
        const viewport = await page.locator(".cs-chat-transcript").locator("..").boundingBox();
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
        await page.mouse.wheel(0, -20000);
      }
      await sticky.waitFor();
      const trigger = sticky.getByRole("combobox");
      await trigger.focus();
      await paneControl(trigger);
      await trigger.click();
      await page.getByRole("listbox").waitFor();
      await page.setViewportSize({ width: 320, height: 360 });
      await page.evaluate(() => window.resizeChatPane(320, 360));
      await frames();
      if (await page.getByRole("listbox").count()) await page.keyboard.press("Escape");
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await frames();
      assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
      const restored = await paneControl(trigger);
      assert.deepEqual(await page.evaluate(() => window.calls.decisions), []);
      reports.push({ kind: "approval-portal-resize", variant, restored });
      cases.push(`approval-select-resize-restores-visible-trigger-${variant}`);
      await page.screenshot({ path: path.join(output, `approval-portal-${variant}-320x360.png`) });
    }
    console.log(
      JSON.stringify(
        {
          output,
          desktop,
          layouts: reports.filter((report) => report.kind === "header-layout").length,
          chatLayouts: reports.filter((report) => report.kind === "chat-layout").length,
          cases,
        },
        null,
        2,
      ),
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ desktop, reports, cases, errors, blocked }, null, 2),
  );
  await browser.close();
}
