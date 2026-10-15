/* Chat → real bucket hook → retained dock → registry → selected child transcript. */
/* global document, window, requestAnimationFrame */
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
const output = "/tmp/codeshell-subagent-chat-navigation-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {MessageStream} from './MessageStream';
  import {usePanelBuckets} from './app/usePanelBuckets';
  import {SessionPanelDock} from './app/SessionPanelDock';
  import {foldTranscript} from './automation/foldTranscript';
  import {bucketKey} from './transcripts';
  import {I18nProvider,useT} from './i18n/I18nProvider';
  import {saveUILanguage} from './uiLanguage';
  const noop=()=>{};
  const off=()=>()=>{};
  const ids=['first','second','third'];
  function raw(parent){return [
    {kind:'stream',event:{type:'session_started',sessionId:parent,promptTokens:0}},
    {kind:'user',text:'Parent conversation '+parent},
    ...ids.flatMap(id=>[
      {kind:'stream',event:{type:'agent_start',agentId:parent+'-'+id,name:'Link '+id,description:id==='third'?'Investigate third source':'Repeated task'}},
      {kind:'stream',event:{type:'agent_end',agentId:parent+'-'+id,description:id==='third'?'Investigate third source':'Repeated task'}},
    ]),
    ...[1,2].flatMap(index=>[
      {kind:'stream',event:{type:'tool_use_start',toolCall:{id:'ambiguous-'+index,toolName:'Agent',args:{description:'Repeated task',subagent_type:'explorer'}}}},
      {kind:'stream',event:{type:'tool_result',result:{id:'ambiguous-'+index,toolName:'Agent',result:'Completed repeated task'}}},
    ]),
    {kind:'turn_stopped'},
  ];}
  function childTranscript(id){return [
    {kind:'stream',event:{type:'session_started',sessionId:id,promptTokens:0}},
    {kind:'user',text:'Exact transcript '+id},
    {kind:'stream',event:{type:'stream_request_start',turnNumber:0}},
    {kind:'stream',event:{type:'text_delta',text:'Result from '+id}},
    {kind:'stream',event:{type:'assistant_message',message:{role:'assistant',content:'Result from '+id}}},
    {kind:'stream',event:{type:'turn_complete',reason:'completed'}},
  ];}
  window.codeshell={
    onBrowserAnchorFromPopout:off,onBrowserAnchorRemoveFromPopout:off,onBrowserAnchorUpdateFromPopout:off,
    syncBrowserAnchors:noop,onWorkspaceChanged:off,onStreamEvent:off,
    listDiskSessions:async(options)=>{
      window.actions.push(['catalog',options]);
      return {sessions:ids.map(id=>({engineSessionId:options.parentSessionId+'-'+id,title:'Link '+id,status:'completed'})),nextCursor:null};
    },
    getSessionTranscript:async(id)=>{window.actions.push(['transcript',id]);return childTranscript(id)},
  };
  function Fixture({paneWidth}){
    const {t}=useT();
    window.fixtureLabels={openFromChat:t('msg.agent.openFromChat')};
    const [session,setSession]=React.useState('parent-a');
    const [draft,setDraft]=React.useState('Unsent draft');
    const [sessionIndices,setSessionIndices]=React.useState({project:{sessions:['parent-a','parent-b'].map(id=>({id,engineSessionId:id,title:id,createdAt:1,updatedAt:1})),activeSessionId:'parent-a'}});
    const activeBucket=bucketKey('project',session);
    const activeBucketRef=React.useRef(activeBucket);activeBucketRef.current=activeBucket;
    const sessionIndicesRef=React.useRef(sessionIndices);sessionIndicesRef.current=sessionIndices;
    const [quickChatSessions,setQuickChatSessions]=React.useState({});
    const quickChatSessionsRef=React.useRef(quickChatSessions);quickChatSessionsRef.current=quickChatSessions;
    const controls={gitReviewAvailable:false,engineToBucketRef:React.useRef(new Map()),setPermissionOverrides:noop,setModelOverrides:noop,
      defaultPermissionMode:'default',quickChatDefaultModelKey:null,resolveEngineSessionIdForBucket:bucket=>bucket.endsWith('parent-b')?'parent-b':'parent-a',
      dispatch:noop,approvalBucketsRef:React.useRef(new Map()),setApprovalQueue:noop,setApproval:noop,setBusyForKey:noop};
    const stream={runningBucketRef:React.useRef(null),coalescersRef:React.useRef(new Map()),coalescerSeqRef:React.useRef(new Map()),appliedSeqRef:React.useRef(new Map())};
    const panels=usePanelBuckets({sessions:{activeBucket,activeProjectId:'project',activeBucketRef,sessionIndices,sessionIndicesRef,setSessionIndices,
      materializeActiveSessionForPanel:()=>{window.actions.push(['materialize']);return activeBucketRef.current}},
      quickChat:{quickChatSessions,setQuickChatSessions,setQuickChatDrafts:noop,setQuickChatAttachments:noop,quickChatSessionsRef},
      controls,stream,shell:{toast:noop,t,setViewMode:noop}});
    window.fixtureState={session,activeBucket,panelByBucket:panels.panelByBucket};
    window.tryGenericNavigation=()=>panels.openSubagent({parentSessionId:session,label:'Generic child list'});
    const messages=React.useMemo(()=>foldTranscript(raw(session)).messages,[session]);
    return <main id="dock-fixture" className="fixed inset-0 flex min-h-0 min-w-0 bg-background text-foreground">
      <section id="parent-chat" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap gap-2 border-b border-border p-3 text-xs">
          <button onClick={panels.togglePanel}>Toggle panels</button>
          <button onClick={()=>{const next=session==='parent-a'?'parent-b':'parent-a';setSession(next);setSessionIndices(current=>({...current,project:{...current.project,activeSessionId:next}}))}}>Switch parent</button>
        </header>
        <MessageStream engineSessionId={session} messages={messages} onViewSubagent={panels.openSubagent}/>
        <textarea aria-label="Parent draft" value={draft} onChange={event=>setDraft(event.target.value)} className="m-3 h-16 shrink-0 rounded-lg border border-border bg-background p-2 text-sm"/>
      </section>
      <SessionPanelDock panelBuckets={panels.panelBuckets} panelByBucket={panels.panelByBucket} activeBucket={activeBucket} isChatView={true}
        projects={[]} updatePanelBucket={panels.updatePanelBucket} onRevealConsumed={panels.onRevealConsumed} onOpenCliSessionConsumed={panels.onOpenCliSessionConsumed}
        panelWidth={paneWidth} beginPanelResize={noop} onAttachImage={noop} anchorsByBucket={panels.anchorsByBucket} removeAnchor={panels.removeAnchor}
        updateAnchorComment={panels.updateAnchorComment} resolveEngineSessionIdForBucket={controls.resolveEngineSessionIdForBucket}
        quickChatSessions={quickChatSessions} transcripts={{}} busyKeys={new Set()} approvalForBucket={()=>null} noRepoCwd={null}
        permissionOverrides={{}} defaultPermissionMode="default" modelOverrides={{}} defaultSessionModelKey={null} defaultActiveModelKey={null}
        quickChatDrafts={{}} quickChatAttachments={{}} modelOptions={[]} imageDetail={undefined} setQuickChatPermission={noop} setQuickChatModel={noop}
        ensureQuickChatSession={noop} cleanupQuickChatPanelSession={noop} restartQuickChatSession={noop} setQuickChatDraft={noop} setQuickChatAttachmentState={noop}
        sendQuickChat={noop} stop={noop} handleAskUserAnswer={noop} decideEnvelope={noop}/>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));let generation=0;
  window.renderFixture=props=>{
    root.render(null);localStorage.clear();saveUILanguage(props.lang);document.documentElement.classList.toggle('dark',props.mode==='dark');window.actions=[];
    if(props.legacy)localStorage.setItem('codeshell.panelState.'+bucketKey('project','parent-a'),JSON.stringify({open:true,tabs:[{id:'legacy-child-tab',kind:'subagent'}],activeId:'legacy-child-tab'}));
    root.render(<I18nProvider key={++generation}><Fixture {...props}/></I18nProvider>);
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
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
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
const failures = [],
  errors = [],
  blocked = [],
  reports = [];
const context = await browser.newContext({ reducedMotion: "reduce", serviceWorkers: "block" });
await context.route("**/*", (route) => {
  if (route.request().url() === "http://subagent-dock.test/")
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
    });
  blocked.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(5000);
await page.goto("http://subagent-dock.test/");

async function settle() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function reveal(id) {
  const heading = page.locator(`#parent-chat [aria-controls="agent-body-${id}"]`);
  for (let attempt = 0; !(await heading.count()) && attempt < 6; attempt++) {
    const outer = page.locator(
      '#parent-chat .cs-process-heading[aria-expanded="false"],#parent-chat .cs-agent-group-heading[aria-expanded="false"]',
    );
    assert.ok(await outer.count(), `parent fold can expose ${id}`);
    await outer.first().click();
    await settle();
  }
  await heading.waitFor();
  return heading.locator("..").locator(".cs-agent-transcript");
}
async function exactChild(parent, id, label) {
  const target = `${parent}-${id}`;
  const action = await reveal(target);
  await action.focus();
  await action.press("Enter");
  const dock = page.locator(
    '[data-theme-surface="panel"]:not([aria-hidden="true"]) [data-panel-id="subagent"][data-panel-active="true"]',
  );
  await dock.getByText(`Exact transcript ${target}`, { exact: true }).waitFor();
  assert.equal(
    await dock.getByRole("combobox").count(),
    0,
    `${label}: exact child has no sibling picker`,
  );
  assert.equal(await page.getByRole("tab").count(), 1, `${label}: one retained subagent tab`);
  const state = await page.evaluate(() => window.fixtureState);
  const selection = state.panelByBucket[state.activeBucket].subagentSelection;
  assert.equal(selection.agentId, target, `${label}: real bucket selection carries exact child`);
  assert.equal(selection.parentSessionId, parent, `${label}: real bucket retains parent identity`);
  const actions = await page.evaluate(() => window.actions);
  assert.ok(
    actions.some((item) => item[0] === "transcript" && item[1] === target),
    `${label}: bridge reads exact child`,
  );
  assert.ok(
    actions.some((item) => item[0] === "catalog" && item[1].parentSessionId === parent),
    `${label}: catalog uses parent identity`,
  );
  assert.equal(
    await page
      .locator("#parent-chat")
      .getByText(`Exact transcript ${target}`, { exact: true })
      .count(),
    0,
    `${label}: child never replaces main conversation`,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Parent draft" }).inputValue(),
    "Preserved draft",
    `${label}: main draft preserved`,
  );
  reports.push({ label, parent, target, tabId: await page.getByRole("tab").getAttribute("id") });
  return dock;
}
try {
  for (const lang of ["zh", "en"])
    for (const mode of ["light", "dark"]) {
      const label = `${lang}-${mode}`;
      try {
        await page.setViewportSize({
          width: lang === "zh" ? 1100 : 760,
          height: lang === "zh" ? 680 : 420,
        });
        await page.evaluate((props) => window.renderFixture(props), {
          lang,
          mode,
          paneWidth: lang === "zh" ? 420 : 320,
        });
        await page.getByRole("textbox", { name: "Parent draft" }).fill("Preserved draft");
        for (
          let attempt = 0;
          (await page.locator('#parent-chat [data-tool-name="Agent"]').count()) < 2 && attempt < 6;
          attempt++
        ) {
          const outer = page.locator(
            '#parent-chat button[aria-expanded="false"]:not(.cs-agent-heading)',
          );
          assert.ok(await outer.count(), `${label}: ambiguous tools can be exposed`);
          await outer.first().click();
        }
        const ambiguous = page.locator('#parent-chat [data-tool-name="Agent"]');
        assert.equal(
          await ambiguous.count(),
          2,
          `${label}: two real folded ambiguous tools present`,
        );
        assert.equal(
          await ambiguous.getByRole("button", { name: /^(完整对话|Full conversation)$/ }).count(),
          0,
          `${label}: ambiguous tools have no generic conversation action`,
        );
        await page.evaluate(() => {
          window.parentDraftNode = document.querySelector("textarea");
          window.parentStreamNode = document.querySelector("#parent-chat .cs-chat-transcript");
        });
        await page.getByRole("button", { name: "Toggle panels", exact: true }).click();
        await settle();
        assert.equal(
          await page.locator('[data-panel-menu-kind="subagent"]').count(),
          0,
          `${label}: no generic landing action`,
        );
        const landing = page.locator('[data-theme-surface="panel"]');
        assert.equal(
          await landing.getByRole("button", { name: /子代理|Sub.?agents?/i }).count(),
          0,
          `${label}: no subagent landing card`,
        );
        await page.locator('[data-panel-action="new-tab"]').click();
        await page.locator("[data-panel-launcher]").waitFor();
        assert.equal(
          await page.locator('[data-panel-launcher-kind="subagent"]').count(),
          0,
          `${label}: no generic new-tab option`,
        );
        await page.getByRole("tab").focus();
        await page.getByRole("tab").press("Delete");
        await page.getByRole("button", { name: "Toggle panels", exact: true }).click();
        const before = await page.evaluate(() => JSON.stringify(window.fixtureState.panelByBucket));
        await page.evaluate(() => window.tryGenericNavigation());
        await settle();
        assert.equal(
          await page.evaluate(() => JSON.stringify(window.fixtureState.panelByBucket)),
          before,
          `${label}: generic navigation does not open a list`,
        );
        let dock = await exactChild("parent-a", "second", `${label}-second`);
        const firstTab = await page.getByRole("tab").getAttribute("id");
        const firstNonce = await page.evaluate(() => {
          const state = window.fixtureState;
          return state.panelByBucket[state.activeBucket].subagentSelection.navigationNonce;
        });
        await dock.locator('[data-subagent-action="back-to-list"]').click();
        await dock.locator('[data-subagent-list-id="parent-a-third"]').waitFor();
        const readsBeforeReopen = (await page.evaluate(() => window.actions)).filter(
          (item) => item[0] === "transcript",
        ).length;
        dock = await exactChild("parent-a", "second", `${label}-same-child-reopen`);
        assert.equal(
          await dock.locator("[data-subagent-list]").count(),
          0,
          `${label}: repeating the same chat action leaves the list for the exact conversation`,
        );
        assert.equal(
          await page.getByRole("tab").getAttribute("id"),
          firstTab,
          `${label}: repeating the same child retains the tab`,
        );
        const repeated = await page.evaluate(() => {
          const state = window.fixtureState;
          return {
            nonce: state.panelByBucket[state.activeBucket].subagentSelection.navigationNonce,
            reads: window.actions.filter((item) => item[0] === "transcript").length,
          };
        });
        assert.ok(
          repeated.nonce > firstNonce,
          `${label}: real hook issues a fresh navigation nonce`,
        );
        assert.equal(
          repeated.reads,
          readsBeforeReopen + 1,
          `${label}: repeated child gets one fresh transcript read`,
        );
        await dock.screenshot({
          path: path.join(output, `preview-${label}-second.png`),
          animations: "disabled",
        });
        dock = await exactChild("parent-a", "third", `${label}-third`);
        assert.equal(
          await page.getByRole("tab").getAttribute("id"),
          firstTab,
          `${label}: child switch reuses same tab`,
        );
        assert.equal(
          await dock.getByText("Exact transcript parent-a-second", { exact: true }).count(),
          0,
          `${label}: old child content removed`,
        );
        await page.getByRole("button", { name: "Toggle panels", exact: true }).click();
        assert.equal(
          await page.locator('[data-theme-surface="panel"]:not([aria-hidden="true"])').count(),
          0,
          `${label}: dock closes`,
        );
        await page.getByRole("button", { name: "Toggle panels", exact: true }).click();
        await dock.getByText("Exact transcript parent-a-third", { exact: true }).waitFor();
        assert.equal(
          await page.getByRole("tab").getAttribute("id"),
          firstTab,
          `${label}: close/reopen retains exact child`,
        );
        await page.getByRole("button", { name: "Switch parent", exact: true }).click();
        await settle();
        assert.equal(
          await page.locator('[data-theme-surface="panel"]:not([aria-hidden="true"])').count(),
          0,
          `${label}: other parent starts without inherited dock`,
        );
        await exactChild("parent-b", "second", `${label}-other-parent`);
        await page.getByRole("button", { name: "Switch parent", exact: true }).click();
        await page
          .locator(
            '[data-theme-surface="panel"]:not([aria-hidden="true"]) [data-panel-id="subagent"][data-panel-active="true"]',
          )
          .getByText("Exact transcript parent-a-third", { exact: true })
          .waitFor();
        assert.ok(
          await page.evaluate(
            () =>
              document.querySelector("textarea") === window.parentDraftNode &&
              document.querySelector("#parent-chat .cs-chat-transcript") ===
                window.parentStreamNode,
          ),
          `${label}: parent composer and stream remain mounted`,
        );
        const geometry = await page.evaluate(() => ({
          width: window.innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert.ok(geometry.scroll <= geometry.width + 1, `${label}: no horizontal page overflow`);
        await page.screenshot({
          path: path.join(output, `integration-${label}.png`),
          animations: "disabled",
        });
      } catch (error) {
        failures.push({ label, error: error.stack });
        await page.screenshot({ path: path.join(output, `failure-${label}.png`) });
        if (process.argv.includes("--fail-fast")) break;
      }
    }
  for (const lang of ["zh", "en"]) {
    try {
      await page.setViewportSize({ width: 900, height: 560 });
      await page.evaluate((props) => window.renderFixture(props), {
        lang,
        mode: "light",
        paneWidth: 360,
        legacy: true,
      });
      const dock = page.locator('[data-panel-id="subagent"][data-panel-active="true"]');
      const hint = await page.evaluate(() => window.fixtureLabels.openFromChat);
      await dock.getByText(hint, { exact: true }).waitFor();
      await settle();
      assert.equal(
        await dock.getByRole("combobox").count(),
        0,
        `${lang}: legacy tab has no sibling picker`,
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.actions.filter((item) => item[0] === "catalog" || item[0] === "transcript"),
        ),
        [],
        `${lang}: legacy tab never guesses or reads a child`,
      );
      assert.equal(
        await dock.getByRole("button").last().isDisabled(),
        true,
        `${lang}: legacy tab cannot refresh a generic list`,
      );
      await dock.screenshot({
        path: path.join(output, `legacy-${lang}.png`),
        animations: "disabled",
      });
    } catch (error) {
      failures.push({ label: `legacy-${lang}`, error: error.stack });
    }
  }
} finally {
  await browser.close();
}
const result = {
  result: failures.length || errors.length || blocked.length ? "fail" : "pass",
  navigationCases: reports.length,
  workflows: 4,
  legacyCases: 2,
  reports,
  failures,
  browserErrors: errors,
  blockedRequests: blocked,
  output,
};
await writeFile(path.join(output, "report.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (result.result !== "pass") process.exitCode = 1;
