/**
 * Remote-control workbench with a Host turn queue: synthetic local state only,
 * no network and no real session data. Captures phone/tablet/desktop screenshots
 * (320/390/768/1280, light and dark, six scenes) and checks layout bounds and
 * touch targets of the top bar, composer toolbar and queue list.
 *
 * Run: node scripts/run-isolated-node-smoke.mjs packages/web/scripts/test-remote-queue-browser.mjs
 * Screenshots and report.json go to a fresh temporary directory, printed at the
 * end. Pass --out=<dir> (or CODESHELL_VISUAL_OUT) to write them to a stable
 * directory instead; existing files with the same names are overwritten.
 */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const requestedOutput =
  process.argv.find((argument) => argument.startsWith("--out="))?.slice("--out=".length) ||
  process.env.CODESHELL_VISUAL_OUT;
const output = requestedOutput
  ? path.resolve(requestedOutput)
  : await mkdtemp(path.join(tmpdir(), "codeshell-remote-queue-"));
await mkdir(output, { recursive: true });

const source = `
import React from 'react';import{createRoot}from'react-dom/client';
import{Workbench}from'./Workbench';import{DesktopChatControls}from'./DesktopControls';import{DesktopModelPicker}from'./DesktopModelPicker';
const noop=()=>{};window.actions=[];
const code='const value = '+JSON.stringify('x'.repeat(220))+';\\nconsole.log(value.length);';
const long='这是一段较长的说明文字，用来检查手机上消息的阅读宽度、行高与换行是否舒适。'.repeat(3);
const items=[
 {kind:'user',id:'u1',text:'帮我检查一下 packages/web 的移动端布局，并修复输入框被键盘遮挡的问题。'},
 {kind:'assistant',id:'a1',text:long+'\\n\\n\`\`\`ts\\n'+code+'\\n\`\`\`\\n\\n| 列 | 说明 |\\n|---|---|\\n| composer | 固定在底部，适配安全区 |',done:true},
 {kind:'tool',id:'t1',name:'Bash',args:{command:'bun test packages/web --timeout 30000 '+'--very-long-flag '.repeat(12)},done:true,result:'ok '.repeat(200)},
 {kind:'assistant',id:'a2',text:'正在继续处理…',done:false},
];
const entries=(paused)=>[
 {id:'q1',clientMessageId:'c1',text:'完成后顺便把 README 里的截图说明更新一下',attachments:[],status:paused==='failed'?'failed':'queued',message:paused==='failed'?'请选择有效的外部运行时模型。':undefined,createdAt:1,ownDevice:true},
 {id:'q2',clientMessageId:'c2',text:'再跑一遍类型检查，失败的话告诉我是哪个包。'.repeat(2),attachments:[{clientId:'i',name:'screen.png',mime:'image/png',size:2048}],status:'queued',createdAt:2,ownDevice:false,permissionMode:'acceptEdits'},
 {id:'q3',clientMessageId:'c3',text:'最后总结改动',attachments:[],status:'waiting',message:'等待提交设备回到此会话后继续（不会跳过或重复执行）。',createdAt:3,ownDevice:true},
 {id:'q4',clientMessageId:'c4',text:'第四条（折叠时隐藏）',attachments:[],status:'queued',createdAt:4,ownDevice:true},
];
function Fixture(){
 const[state,setState]=React.useState({scene:'running',draft:'',room:false});
 window.scene=(patch)=>setState(current=>({...current,...patch}));
 const running=state.scene==='running'||state.scene==='failed-running'||state.scene==='approval';
 const paused=state.scene==='paused'?'stopped':state.scene==='failed-running'?'failed':undefined;
 const queueEntries=state.scene==='empty'||state.scene==='idle'?[]:entries(paused);
 const queueState={target:state.room?{kind:'room',roomId:'room-1'}:{kind:'session',sessionId:'s-1'},epoch:'e',revision:1,...(paused?{paused}:{}),entries:queueEntries};
 const app={status:'online',sessions:[],activeSessionId:'s-1',turnQueueSupported:true,turnQueue:queueState,setCcRoomPermissionMode:noop,permissionMode:'default',setPermissionMode:noop,activeRoomId:state.room?'room-1':undefined,activeRoom:state.room?{id:'room-1',name:'Claude Code · repo',cwd:'/repo',kind:'claude-code',permissionMode:'default',open:true,observing:false}:undefined,leaveRoom:noop,outputHistoryFailed:false};
 const controller={panelSessionId:undefined,host:'desktop',workspaceApi:true,connection:'open',activeId:'s-1',chat:{items:state.scene==='empty'?[]:items,run:running?'running':'idle'},sessions:[],workspaceCwd:'/repo',workspaceName:'repo',workspaceKey:'repo',title:'移动端布局检查',configuration:null,configurationVersion:0,sessionsVersion:0,draft:state.draft,files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:state.scene==='failed-running'?'队首消息未执行：请选择有效的外部运行时模型。':'',clearError:noop,setDraft:draft=>setState(current=>({...current,draft})),removeFile:noop,selectSession:noop,newSession:noop,send:()=>{window.actions.push(['send',state.draft]);setState(current=>({...current,draft:''}));return true},stop:()=>window.actions.push(['stop']),addFiles:noop,cameraAttachments:true,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:noop,
  composerControls:<DesktopChatControls app={app}/>,
  modelSelector:state.room?undefined:<DesktopModelPicker models={[]} nativeChoices={[]} value='' defaultLabel='默认模型' disabled={running||queueEntries.length>0} onRefresh={noop} onChange={noop}/>,
  statusBadges:state.room?[{label:'Claude Code CLI',tone:'accent'}]:undefined,
  turnQueue:{canQueue:true,state:queueState,online:true,currentPermissionMode:'default',cancel:id=>window.actions.push(['cancel',id]),retry:id=>window.actions.push(['retry',id]),resume:()=>window.actions.push(['resume']),clear:()=>window.actions.push(['clear'])}};
 return <Workbench controller={controller}/>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;

const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const origin = "http://remote-queue-owned.test";
const errors = [];
const blocked = [];
const reports = [];
try {
  for (const theme of ["light", "dark"])
    for (const [width, height, mobile] of [
      [320, 640, true],
      [390, 844, true],
      [768, 1024, true],
      [1280, 800, false],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: theme,
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><div id="root"></div>',
          });
        if (url.origin === origin && url.pathname === "/api/v1/environment")
          return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
        blocked.push(route.request().method() + " " + url.href);
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => {
        errors.push(error.message);
        // The real render stack, not a later unrelated locator timeout.
        console.error(`[pageerror ${theme} ${width}x${height}] ${error.stack ?? error}`);
      });
      await page.goto(`${origin}/`);
      for (const file of bundle.outputFiles.filter((item) => item.path.endsWith(".css")))
        await page.addStyleTag({ content: file.text });
      await page.addScriptTag({
        content: bundle.outputFiles.find((item) => item.path.endsWith(".js")).text,
      });
      await page
        .getByRole("textbox", { name: "任务内容", exact: true })
        .waitFor()
        .catch((error) => {
          throw new Error(`${error.message}\npage errors:\n${errors.join("\n") || "(none)"}`, {
            cause: error,
          });
        });
      for (const scene of ["running", "paused", "failed-running", "idle", "empty", "room"]) {
        await page.evaluate(
          (value) =>
            window.scene(
              value === "room"
                ? { scene: "running", room: true, draft: "" }
                : { scene: value, room: false, draft: value === "running" ? "下一步做什么" : "" },
            ),
          scene,
        );
        await page.waitForTimeout(50);
        const layout = await page.evaluate(() => {
          const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
          const overflow = (selector) => {
            const node = document.querySelector(selector);
            return node ? node.scrollWidth - node.clientWidth : 0;
          };
          const targets = [
            ...document.querySelectorAll(
              ".workbench-topbar > button, .composer-toolbar button, .composer-toolbar select, .turn-queue button",
            ),
          ]
            .filter((node) => node.getBoundingClientRect().width > 0)
            .map((node) => {
              const r = node.getBoundingClientRect();
              const x = r.x + r.width / 2;
              const y = r.y + r.height / 2;
              // A row scrolled out of the bounded queue list is reachable by scrolling.
              const list = node.closest(".turn-queue-list")?.getBoundingClientRect();
              const clipped = Boolean(list && (y < list.top || y > list.bottom));
              const hit = document.elementFromPoint(x, y);
              return {
                label: node.getAttribute("aria-label") || node.textContent?.trim(),
                width: Math.round(r.width),
                height: Math.round(r.height),
                right: Math.round(r.right),
                hit: clipped || node.contains(hit),
              };
            });
          return {
            page: document.scrollingElement.scrollWidth - window.innerWidth,
            messages: overflow(".messages"),
            toolbar: overflow(".composer-toolbar"),
            queue: overflow(".turn-queue"),
            composer: rect(".composer-wrap")?.height ?? 0,
            queueHeight: rect(".turn-queue")?.height ?? 0,
            viewport: window.innerWidth,
            targets,
          };
        });
        await page.screenshot({
          path: path.join(output, `${theme}-${width}x${height}-${scene}.png`),
        });
        assert.ok(layout.page <= 1, `${scene}@${width}: page must not scroll horizontally`);
        assert.ok(layout.messages <= 1, `${scene}@${width}: transcript must not overflow`);
        assert.ok(layout.toolbar <= 1, `${scene}@${width}: composer toolbar must fit`);
        assert.ok(layout.queue <= 1, `${scene}@${width}: queue list must fit`);
        for (const target of layout.targets) {
          assert.ok(
            target.right <= layout.viewport,
            `${scene}@${width}: ${JSON.stringify(target)}`,
          );
          assert.ok(target.hit, `${scene}@${width}: covered ${JSON.stringify(target)}`);
          if (mobile && width < 768)
            assert.ok(
              target.width >= 44 && target.height >= 44,
              `${scene}@${width}: touch target ${JSON.stringify(target)}`,
            );
        }
        reports.push({ theme, width, height, scene, ...layout });
      }
      // Busy conversation: queue and stop are distinct controls.
      await page.evaluate(() => window.scene({ scene: "running", room: false, draft: "排队消息" }));
      await page.getByRole("button", { name: "加入队列", exact: true }).click();
      await page.getByRole("button", { name: "停止", exact: true }).click();
      await page.getByRole("button", { name: "取消第 1 条排队消息", exact: true }).click();
      const actions = await page.evaluate(() => window.actions.splice(0));
      assert.deepEqual(actions, [["send", "排队消息"], ["stop"], ["cancel", "q1"]]);
      await page.evaluate(() => window.scene({ scene: "paused" }));
      await page.getByRole("button", { name: "继续执行", exact: true }).click();
      await page.getByRole("button", { name: "全部取消", exact: true }).click();
      await page.getByRole("button", { name: /确认清空/ }).click();
      assert.deepEqual(await page.evaluate(() => window.actions.splice(0)), [
        ["resume"],
        ["clear"],
      ]);
      await context.close();
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ output, scenes: reports.length }, null, 2));
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
