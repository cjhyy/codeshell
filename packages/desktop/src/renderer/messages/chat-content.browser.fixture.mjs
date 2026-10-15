/* Real subagent summaries and main-session thinking/process cards over chat wallpaper. */
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
const output = "/tmp/codeshell-subagent-summary-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {AgentMessageView} from './messages/AgentMessageView';
  import {AgentGroupCard} from './messages/AgentGroupCard';
  import {ThinkingMessageView} from './messages/ThinkingMessageView';
  import {TurnProcessGroupCard} from './messages/TurnProcessGroupCard';
  import {SubagentNavigationContext} from './subagents/SubagentNavigation';
  import {SubagentSessionDetail} from './subagents/SubagentSessionDetail';
  import {I18nProvider} from './i18n/I18nProvider';
  import {translate} from './i18n/translate';
  import {saveUILanguage} from './uiLanguage';
  const started=Date.now()-65000;
  const completeResult={zh:'检查完成，已验证调用关系与相关测试。',en:'Review complete. Callers and related tests are verified.'};
  const task=lang=>(lang==='zh'?'检查 schema 的调用关系，核对相关类型和错误处理。\\n然后运行受影响的测试，并整理可以直接执行的修改建议。\\n':'Inspect the schema, its callers, types, and error handling.\\nThen run affected tests and summarize actionable changes.\\n')+'/fixture/project/'+('long-directory-name/'.repeat(10))+'schema.ts';
  function tools(id,state,count=38){return Array.from({length:count},(_,index)=>{
    const last=index===count-1;
    const toolName=last?'Bash':['Read','Grep','Bash'][index%3];
    const pending=last&&(state==='running'||state==='background'||state==='waiting');
    const failed=last&&state==='failed';
    return {kind:'tool',id:id+'-tool-'+index,toolName,
      args:JSON.stringify(toolName==='Bash'?{command:'bun test fixture-operation-'+(index+1)}:toolName==='Read'?{file_path:'/fixture/project/src/module-'+(index+1)+'.ts'}:{pattern:'schema',path:'/fixture/project/src'}),
      status:pending?'running':failed?'failed':'succeeded',startedAt:started+index*10,
      ...(pending?{}:{endedAt:started+index*10+12,durationMs:12}),
      result:last?(pending?'Operation '+count+' is running':failed?'Operation '+count+' failed: expected fixture failure':'Operation '+count+' completed: all checks passed'):'Fixture operation '+(index+1)+' completed',
      ...(failed?{error:'Exit code 1: expected fixture failure'}:{})};
  })}
  function agent(id,state,lang,count=38){return {kind:'agent',id,name:lang==='zh'?'调用关系检查':'Call graph review',agentType:'general-purpose',
    description:task(lang),done:state==='completed'||state==='failed',startedAt:started,endedAt:state==='completed'||state==='failed'?started+65000:undefined,
    backgrounded:state==='background',lastHeartbeat:Date.now(),toolCalls:tools(id,state,count),toolCount:count,
    text:state==='completed'?'**'+completeResult[lang]+'**\\n\\n- '+(lang==='zh'?'相关测试已通过。':'Related tests passed.'):'',
    textBuffer:state==='running'||state==='background'?(lang==='zh'?'已检查主要调用点，正在完成最后一项验证。':'The main callers are checked; the final verification is running.'):'',
    ...(state==='failed'?{error:'Command failed after repeated retries.\\n'+('LongFailureIdentifier'.repeat(15))}:{})};}
  const thinking=lang=>(lang==='zh'?'先明确输入和输出，再沿着调用链核对约束。把验证拆成可以独立确认的小步骤。':'Clarify inputs and outputs, then follow the call chain and verify each constraint in a small step.')+'\\n\\n'+('Reasoning notes with a very long identifier: '+('LongIdentifier'.repeat(20))+'\\n').repeat(4);
  window.codeshell={
    listDiskSessions:async(options)=>{window.actions.push(['catalog',options]);return {sessions:[{engineSessionId:'agent-main',title:'Schema review transcript',status:'completed'}],nextCursor:null}},
    getSessionTranscript:async(id)=>{window.actions.push(['transcript',id]);return [
      {kind:'stream',event:{type:'session_started',sessionId:id,promptTokens:0}},
      {kind:'user',text:'Inspect the schema in the child session.'},
      {kind:'stream',event:{type:'stream_request_start',turnNumber:0}},
      {kind:'stream',event:{type:'text_delta',text:'Full child transcript: schema and callers verified.'}},
      {kind:'stream',event:{type:'assistant_message',message:{role:'assistant',content:'Full child transcript: schema and callers verified.'}}},
      {kind:'stream',event:{type:'turn_complete',reason:'completed'}},
    ]},
  };
  function Fixture({kind,phase,lang,wallpaper=true,presentation=false}) {
    const [current,setCurrent]=React.useState(phase);
    const [stale,setStale]=React.useState(false);
    const [epoch,setEpoch]=React.useState(0);
    const [detail,setDetail]=React.useState(null);
    window.completeFixture=()=>setCurrent('completed');window.staleFixture=()=>setStale(true);window.bumpEpoch=()=>setEpoch(value=>value+1);
    const main=agent('agent-main',current,lang);
    window.currentAgent=main;
    if(presentation){
      main.name=lang==='zh'?'Link 调研':'Link research';main.agentType='explorer';
      main.description=lang==='zh'?'追踪 Figma Link 的读取链，核对设计稿内容如何进入会话。\\n检查授权、数据解析与错误反馈，并整理验证结果。':'Trace the Figma Link read flow and how design content reaches a conversation.\\nCheck authorization, parsing, and error feedback.';
      main.text=lang==='zh'?'**调研完成。**\\n\\n读取流程分为访问授权、设计节点解析和上下文整理三个阶段。\\n\\n- 已核对主要读取链和相关调用。\\n- 错误反馈应区分授权失败与内容不可用。\\n- 建议补充这两类异常路径的回归验证。':'**Research complete.**\\n\\nThe read flow covers authorization, node parsing, and context preparation.\\n\\n- Main calls are reviewed.\\n- Distinguish access failures from unavailable content.\\n- Add regression coverage for both error paths.';
    }
    if(stale)main.lastHeartbeat=Date.now()-120000;
    const members=[agent('group-running',phase==='mixed'?'running':'completed',lang),agent('group-completed','completed',lang),agent('group-failed','failed',lang)];
    const group={kind:'agent_group',id:'fixture-group',agents:members};
    const process={kind:'turn_process_group',id:'fixture-process',isLive:current==='running',startedAt:started,firstToolStartedAt:started,durationMs:65000,toolCount:2,
      items:[{kind:'assistant',id:'process-intro',done:true,text:lang==='zh'?'先检查实现，再核对测试。':'Inspect the implementation, then verify the tests.'},
        {kind:'thinking',id:'process-thinking',done:true,text:thinking(lang)},...tools('process','completed',2),agent('process-agent','completed',lang,2)]};
    const navigation={sessionId:'fixture-parent',agents:[main],onView:selection=>{window.actions.push(['view',selection]);setDetail(selection)}};
    const surface=wallpaper?{'--cs-surface-chat-image':'repeating-conic-gradient(from 12deg at 25% 15%, #0c4a6e 0deg 25deg, #f8fafc 25deg 65deg, #1e293b 65deg 100deg)','--cs-surface-chat-opacity':'1','--cs-surface-chat-background-opacity':'0'}:{};
    return <main id="chat-content-fixture" data-theme-surface="chat" className="fixed inset-0 flex min-h-0 min-w-0 flex-col text-foreground" style={surface}>
      <SubagentNavigationContext.Provider value={navigation}>
        {detail?<div className="flex min-h-0 flex-1 flex-col bg-background"><SubagentSessionDetail {...detail} onBack={()=>setDetail(null)}/></div>
        :<div id="content-scroll" className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4">
          <div className="cs-chat-transcript mx-auto w-full min-w-0 max-w-3xl">
            {kind==='agent'?<AgentMessageView message={main}/>:kind==='group'?<div id="group-fixture"><AgentGroupCard group={group}/></div>
            :kind==='thinking'?<div id="thinking-fixture"><ThinkingMessageView message={{kind:'thinking',id:'thinking-main',text:thinking(lang),done:current==='completed'}}/></div>
            :kind==='process'?<div id="process-fixture"><TurnProcessGroupCard group={process} turnEpoch={epoch}/></div>
            :<>
              {['running','completed','failed','background'].map(state=><AgentMessageView key={state} message={agent('overview-'+state,state,lang)}/>)}
              <AgentGroupCard group={{...group,agents:[agent('overview-g1','completed',lang),agent('overview-g2','completed',lang),agent('overview-g3','failed',lang)]}}/>
              <ThinkingMessageView message={{kind:'thinking',id:'overview-thinking',text:thinking(lang),done:true}}/>
              <TurnProcessGroupCard group={{...process,isLive:false}}/>
            </>}
          </div>
        </div>}
      </SubagentNavigationContext.Provider>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  let generation=0;
  window.renderFixture=props=>{
    saveUILanguage(props.lang);document.documentElement.classList.toggle('dark',props.mode==='dark');window.actions=[];
    window.expected={description:task(props.lang),complete:completeResult[props.lang],lost:translate(props.lang,'msg.agent.mayBeLost'),
      waiting:translate(props.lang,'msg.agent.waitingForResult'),
      transcript:translate(props.lang,'msg.agent.transcript'),back:translate(props.lang,'msg.agent.back')};
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
const reports = [],
  failures = [],
  errors = [],
  blocked = [];
let hiddenToolCases = 0;

async function noSubagentTools(scope, label) {
  assert.equal(
    await scope
      .locator(
        '[data-message-kind="tool"],.cs-agent-tool-list,.cs-agent-operation,.cs-agent-activity,.cs-agent-operation-count,.cs-agent-live',
      )
      .count(),
    0,
    `${label}: summary contains no tool nodes or live tool activity`,
  );
  const text = await scope.textContent();
  assert.ok(
    !/(?:\d+\s*(?:tools?|tool calls?|operations?|次工具调用|项操作|次操作)|(?:tools?|operations?)\s*[·:]?\s*\d+)/i.test(
      text,
    ),
    `${label}: summary contains no tool counter`,
  );
  assert.ok(
    !text.includes("bun test fixture-operation") &&
      !/msg\.agent\.(?:toolCount|activity|operationCount)/.test(text),
    `${label}: hidden operations and removed translation keys do not leak`,
  );
  hiddenToolCases++;
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function fits(page, label) {
  const geometry = await page.locator("#chat-content-fixture").evaluate((node) => ({
    width: node.clientWidth,
    scrollWidth: node.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(
    geometry.scrollWidth <= geometry.width + 1 && geometry.documentWidth <= geometry.viewport + 1,
    `${label}: no horizontal pane overflow ${JSON.stringify(geometry)}`,
  );
  for (const card of await page
    .locator(
      ".cs-agent-card,.cs-agent-group-card,.cs-thinking-heading,.cs-thinking-body,.cs-process-heading",
    )
    .all()) {
    assert.ok(
      await card.evaluate((node) => {
        const style = getComputedStyle(node);
        return style.backgroundColor !== "rgba(0, 0, 0, 0)" && parseFloat(style.borderRadius) > 0;
      }),
      `${label}: imported reading-surface CSS is applied`,
    );
  }
  reports.push({ label, geometry });
}
async function reachable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const geometry = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      box: box.toJSON(),
      width: window.innerWidth,
      height: window.innerHeight,
      hit: hit === node || node.contains(hit),
    };
  });
  assert.ok(
    geometry.box.width > 0 &&
      geometry.box.height > 0 &&
      geometry.box.left >= 0 &&
      geometry.box.right <= geometry.width + 1 &&
      geometry.box.top >= 0 &&
      geometry.box.bottom <= geometry.height + 1 &&
      geometry.hit,
    `${label}: control is visible and reachable ${JSON.stringify(geometry)}`,
  );
}
async function keyboardToggle(header, label) {
  await reachable(header, label);
  await header.focus();
  await header.press("Enter");
  assert.ok(
    await header.evaluate(
      (node) =>
        document.activeElement === node && parseFloat(getComputedStyle(node).outlineWidth) >= 2,
    ),
    `${label}: keyboard focus remains visible`,
  );
}

try {
  const page = await browser.newPage({
    viewport: { width: 900, height: 760 },
    serviceWorkers: "block",
  });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://chat-content.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://chat-content.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const lang of ["zh", "en"])
    for (const mode of ["light", "dark"])
      for (const viewport of [
        { width: 900, height: 760 },
        { width: 320, height: 420 },
      ]) {
        await page.setViewportSize(viewport);
        const context = { lang, mode, viewport };
        const prefix = `${lang}/${mode}/${viewport.width}`;
        const mount = async (kind, phase) => {
          await page.evaluate((props) => window.renderFixture(props), {
            lang,
            mode,
            kind,
            phase,
            wallpaper: true,
          });
          await settle(page);
          return page.evaluate(() => window.expected);
        };
        const capture = async (name) => {
          if (lang === "zh")
            await page.screenshot({
              path: path.join(output, `${lang}-${mode}-${viewport.width}-${name}.png`),
              animations: "disabled",
            });
        };
        try {
          for (const phase of ["running", "completed", "failed", "background", "waiting"]) {
            const expected = await mount("agent", phase);
            const label = `${prefix}/agent-${phase}`;
            const header = page.locator('[aria-controls="agent-body-agent-main"]');
            const body = page.locator("#agent-body-agent-main");
            await header.waitFor();
            assert.deepEqual(
              await page.evaluate(() => [
                window.currentAgent.toolCalls.length,
                window.currentAgent.toolCount,
              ]),
              [38, 38],
              label + ": complete underlying operation data is retained",
            );
            assert.equal(await header.getAttribute("aria-expanded"), "false");
            await noSubagentTools(page.locator(".cs-agent-card"), label + " collapsed");
            await fits(page, label + " collapsed");
            await capture("agent-" + phase + "-collapsed");
            await keyboardToggle(header, label + " header");
            await body.waitFor();
            assert.ok(
              (await body.textContent()).includes(expected.description),
              label + ": full multiline task is available",
            );
            await noSubagentTools(body, label + " expanded");
            if (phase === "completed") {
              assert.ok(
                (await body.locator(".cs-agent-output").textContent()).includes(expected.complete),
              );
            }
            if (phase === "waiting")
              assert.ok(
                (await body.textContent()).includes(expected.waiting),
                label + ": running agent waits for its result despite existing tools",
              );
            if (phase === "failed")
              assert.ok(
                (await body.textContent()).includes("LongFailureIdentifier".repeat(15)),
                label + ": full error remains available",
              );
            await fits(page, label + " expanded");
            await capture("agent-" + phase + "-expanded");
            if (phase === "running") {
              await page.evaluate(() => window.completeFixture());
              await settle(page);
              assert.equal(await header.getAttribute("aria-expanded"), "true");
              assert.ok(
                (await body.locator(".cs-agent-output").textContent()).includes(expected.complete),
              );
              await noSubagentTools(body, label + " completed");
            }
            if (phase === "background") {
              await page.evaluate(() => window.staleFixture());
              await settle(page);
              assert.ok(
                (await header.textContent()).includes(expected.lost),
                label + ": stale background state is visible",
              );
            }
            if (phase === "completed") {
              const transcript = body.getByRole("button", {
                name: expected.transcript,
                exact: true,
              });
              await reachable(transcript, label + " transcript");
              await transcript.click();
              await page
                .getByText("Full child transcript: schema and callers verified.", { exact: true })
                .waitFor();
              const actions = await page.evaluate(() => window.actions);
              assert.ok(
                actions.some(
                  (action) =>
                    action[0] === "view" &&
                    action[1].agentId === "agent-main" &&
                    action[1].parentSessionId === "fixture-parent",
                ),
              );
              assert.ok(
                actions.some((action) => action[0] === "transcript" && action[1] === "agent-main"),
              );
              await fits(page, label + " full transcript");
              await capture("full-transcript");
              await page.getByRole("button", { name: expected.back, exact: true }).click();
              await header.waitFor();
            } else {
              await keyboardToggle(header, label + " collapse");
              await body.waitFor({ state: "detached" });
              assert.equal(await page.locator('[data-message-kind="tool"]').count(), 0);
            }
          }
          for (const phase of ["mixed", "completed"]) {
            await mount("group", phase);
            const group = page.locator("#group-fixture");
            const header = group.locator(".cs-agent-group-heading");
            assert.equal(
              await header.getAttribute("aria-expanded"),
              phase === "mixed" ? "true" : "false",
            );
            if (phase === "mixed") await keyboardToggle(header, prefix + "/group close");
            assert.equal(await group.locator(".cs-agent-heading").count(), 0);
            await keyboardToggle(header, prefix + "/group open");
            assert.equal(await group.locator(".cs-agent-heading").count(), 3);
            const child = group.locator('[aria-controls="agent-body-group-completed"]');
            await keyboardToggle(child, prefix + "/group child");
            assert.equal(
              await group.locator(".cs-agent-body").count(),
              1,
              prefix + ": sibling activity stays independent",
            );
            await noSubagentTools(group, prefix + "/group " + phase);
            await fits(page, prefix + "/group " + phase);
            await capture("group-" + phase);
            await keyboardToggle(header, prefix + "/group collapse");
            assert.equal(await group.locator(".cs-agent-heading").count(), 0);
          }
          await mount("thinking", "running");
          const thinking = page.locator("#thinking-fixture");
          const thinkingHeader = thinking.getByRole("button").first();
          assert.equal(await thinkingHeader.getAttribute("aria-expanded"), "false");
          await keyboardToggle(thinkingHeader, prefix + "/thinking open");
          assert.equal(
            await thinking.locator(".cs-thinking-body").getAttribute("aria-busy"),
            "true",
          );
          await fits(page, prefix + "/thinking running");
          await capture("thinking-running");
          await page.evaluate(() => window.completeFixture());
          await settle(page);
          assert.equal(await thinkingHeader.getAttribute("aria-expanded"), "true");
          assert.equal(
            await thinking.locator(".cs-thinking-body").getAttribute("aria-busy"),
            "false",
          );
          await keyboardToggle(thinkingHeader, prefix + "/thinking close");
          assert.equal(await thinking.locator(".cs-thinking-body").count(), 0);
          await mount("process", "running");
          const process = page.locator("#process-fixture");
          const processHeader = process.locator(".cs-process-heading");
          assert.equal(await processHeader.getAttribute("aria-expanded"), "true");
          assert.equal(
            await process.locator('[data-message-kind="tool"]').count(),
            2,
            prefix + ": main-session process retains its own tool cards",
          );
          await fits(page, prefix + "/process running");
          await capture("process-running");
          await page.evaluate(() => window.completeFixture());
          await settle(page);
          assert.equal(
            await processHeader.getAttribute("aria-expanded"),
            "false",
            prefix + ": own completed turn collapses",
          );
          await keyboardToggle(processHeader, prefix + "/process open");
          await page.evaluate(() => window.bumpEpoch());
          await settle(page);
          assert.equal(
            await processHeader.getAttribute("aria-expanded"),
            "true",
            prefix + ": a later turn preserves historical expansion",
          );
          const lastMainTool = process.locator('[data-message-kind="tool"]').last();
          const lastMainHeader = lastMainTool.getByRole("button").first();
          await reachable(lastMainHeader, prefix + "/last main tool");
          await lastMainHeader.click();
          assert.ok(
            (await lastMainTool.locator("pre").count()) >= 2 &&
              (await lastMainTool.textContent()).includes(
                "Operation 2 completed: all checks passed",
              ),
            prefix + ": main-session command and result remain available",
          );
          const nestedAgent = process.locator('[aria-controls="agent-body-process-agent"]');
          await keyboardToggle(nestedAgent, prefix + "/nested agent summary");
          await noSubagentTools(
            process.locator("#agent-body-process-agent"),
            prefix + "/nested agent",
          );
          assert.equal(await process.locator('[data-message-kind="tool"]').count(), 2);
          await fits(page, prefix + "/process completed");
          await capture("process-completed");
          await keyboardToggle(processHeader, prefix + "/process close");
        } catch (error) {
          const screenshot = path.join(output, `failure-${lang}-${mode}-${viewport.width}.png`);
          await page.screenshot({ path: screenshot });
          failures.push({ ...context, error: error.message, screenshot });
          console.error(`${prefix}: ${error.message}`);
          if (process.argv.includes("--fail-fast")) throw error;
        }
      }
  let reducedMotionCases = 0;
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const kind of ["thinking", "group"]) {
    await page.evaluate((props) => window.renderFixture(props), {
      lang: "en",
      mode: "dark",
      kind,
      phase: kind === "thinking" ? "running" : "mixed",
      wallpaper: true,
    });
    await settle(page);
    const spinner = page.locator(
      kind === "thinking"
        ? ".cs-thinking-icon .animate-spin"
        : ".cs-agent-group-status .animate-spin",
    );
    assert.equal(
      await spinner.evaluate((node) => getComputedStyle(node).animationName),
      "none",
      `${kind}: reduced motion disables the computed spinner animation`,
    );
    reducedMotionCases++;
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 900, height: 900 });
  for (const mode of ["light", "dark"])
    for (const wallpaper of [false, true]) {
      await page.evaluate((props) => window.renderFixture(props), {
        lang: "zh",
        mode,
        kind: "overview",
        phase: "completed",
        wallpaper,
      });
      await settle(page);
      await page.screenshot({
        path: path.join(output, `preview-${mode}${wallpaper ? "-wallpaper" : ""}.png`),
        animations: "disabled",
      });
    }
  for (const mode of ["light", "dark"]) {
    await page.evaluate((props) => window.renderFixture(props), {
      lang: "zh",
      mode,
      kind: "agent",
      phase: "completed",
      wallpaper: false,
      presentation: true,
    });
    await settle(page);
    const header = page.locator('[aria-controls="agent-body-agent-main"]');
    await keyboardToggle(header, `presentation/${mode}`);
    await page.evaluate(() => document.activeElement?.blur());
    await noSubagentTools(page.locator(".cs-agent-card"), `presentation/${mode}`);
    await page.locator(".cs-agent-card").screenshot({
      path: path.join(output, `preview-link-${mode}.png`),
      animations: "disabled",
    });
  }
  const result = {
    result: failures.length ? "fail" : "pass",
    workflows: 8,
    geometryCases: reports.length,
    reducedMotionCases,
    hiddenToolCases,
    failures,
    browserErrors: errors,
    blockedRequests: blocked,
    output,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ ...result, reports }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], "No browser errors");
  assert.deepEqual(blocked, [], "No external requests attempted");
  assert.equal(failures.length, 0, "Chat content browser fixture failed; see report.json");
} finally {
  await browser.close();
}
