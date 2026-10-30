/** Shared Hub/Desktop workbench with synthetic local state and no external requests. */
/* global window, document, getComputedStyle, KeyboardEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-mobile-workbench-"));
const source = `
import React from 'react';import{createRoot}from'react-dom/client';
import{Workbench}from'./Workbench';import{DesktopModelPicker}from'./DesktopModelPicker';import{DesktopSidebar,DesktopApproval}from'./DesktopControls';
const noop=()=>{},long='ownedlongidentifier'.repeat(35);window.sends=[];window.opened=[];window.modelChanges=[];const models=Array.from({length:60},(_,i)=>({key:(i<30?'claude-code':'codex')+'/fixture-'+i,label:(i<30?'Claude Code':'Codex')+' Fixture '+i+(i===58?' '+long:''),kind:i<30?'claude-code':'codex',provider:i<30?'claude-code':'codex',maxContextTokens:1000}));
function Fixture(){const[state,setState]=React.useState({draft:'First line',model:'',running:false,asking:false,retry:false,scope:'initial'});
window.patchFixture=patch=>setState(current=>({...current,...patch}));
const approval={id:'owned-approval',requestId:'owned-approval',toolName:'__ask_user__',description:long,summary:long,risk:'low',options:[long],optionsOnly:false};
const app={status:'online',activeProjectId:'owned-project',activeProjectCwd:'/owned',activeCwd:'/owned',projects:[{id:'owned-project',name:'Owned project',path:'/owned'}],loading:{sessions:false,ccSessions:false},ccCliKind:'codex',ccProbe:{available:true},ccSessions:[{sessionId:'owned-cli',firstMessage:long,cwd:'/owned',messageCount:1}],selectProject:noop,refreshSessions:noop,setCcCliKind:noop,newSession:noop,openCcSession:(...args)=>window.opened.push(args),respondApproval:noop};
const controller={panelSessionId:undefined,host:'desktop',workspaceApi:true,connection:'open',activeId:'owned-session',chat:{goal:long,items:[{kind:'assistant',id:'owned-output',text:'Owned transcript',done:true}],run:state.running?'running':'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:long,configuration:null,configurationVersion:0,sessionsVersion:0,draft:state.draft,files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:state.running,localDrafts:[],approvals:state.asking?[approval]:[],approvalCount:()=>0,approvalContent:state.asking?<DesktopApproval approval={approval} app={app}/>:null,error:'',clearError:noop,setDraft:draft=>setState(current=>({...current,draft})),removeFile:noop,selectSession:noop,newSession:noop,send:()=>{window.sends.push(state.draft);setState(current=>({...current,draft:''}));return true},stop:noop,addFiles:noop,cameraAttachments:true,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:noop,modelSelector:<DesktopModelPicker key={state.scope} models={state.retry?[]:models} value={state.model} defaultLabel='Default' disabled={state.running} onRefresh={noop} onRetryCreation={state.retry?noop:undefined} onChange={model=>{window.modelChanges.push(model);setState(current=>({...current,model}));}}/>,renderSidebar:navigation=><DesktopSidebar app={app} navigation={navigation}/>};
return <Workbench controller={controller}/>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.argv.includes("--development") ? "development" : "production",
    ),
  },
});
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const errors = [],
  blocked = [],
  reports = [];
try {
  for (const theme of ["light", "dark"])
    for (const [initialWidth, initialHeight] of [
      [390, 844],
      [320, 568],
      [320, 360],
    ]) {
      const context = await browser.newContext({
        viewport: { width: initialWidth, height: initialHeight },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === "http://mobile-workbench-owned.test" && url.pathname === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
          });
        if (
          url.origin === "http://mobile-workbench-owned.test" &&
          url.pathname === "/api/v1/environment"
        )
          return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
        blocked.push(route.request().method() + " " + url.href);
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("http://mobile-workbench-owned.test/");
      for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css")))
        await page.addStyleTag({ content: file.text });
      await page.addScriptTag({
        content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
      });
      const input = page.getByRole("textbox", { name: "任务内容", exact: true });
      await input.waitFor();
      const models = page.getByRole("button", { name: "选择模型或外部运行时" });
      const picker = page.getByRole("dialog", { name: "选择模型或外部运行时" });
      const gestures = await context.newCDPSession(page);
      for (const [width, height] of [[initialWidth, initialHeight]]) {
        await models.tap();
        await picker.waitFor();
        const bounds = await picker.boundingBox();
        assert.ok(bounds.x >= 10 && bounds.x + bounds.width <= width - 10);
        assert.ok(bounds.y >= 10 && bounds.y + bounds.height <= height - 10);
        const list = picker.getByRole("listbox");
        const metrics = await list.evaluate((node) => ({
          client: node.clientHeight,
          scroll: node.scrollHeight,
        }));
        assert.ok(
          metrics.client > 60 && metrics.scroll > metrics.client * 2,
          "long model list owns a bounded scroll area",
        );
        await list.evaluate((node) => {
          node.scrollTop = 0;
        });
        const listBounds = await list.boundingBox();
        const x = listBounds.x + listBounds.width / 2;
        const start = listBounds.y + listBounds.height - 20;
        await list.evaluate((node) => {
          window.modelTouchEvents = [];
          for (const type of ["touchstart", "touchmove", "touchend"])
            node.addEventListener(
              type,
              (event) => {
                window.modelTouchEvents.push({ type: event.type, trusted: event.isTrusted });
              },
              { passive: true },
            );
        });
        // Chromium's synthetic scroll gesture can complete without scrolling
        // this surface in headless CI. Feed the browser an actual finger path
        // instead; CSS/hit testing must still scroll this list, with no DOM scroll write.
        await gestures.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y: start, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
        });
        try {
          for (let step = 1; step <= 12; step++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            await gestures.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [
                {
                  x,
                  y: start - ((listBounds.height - 40) * step) / 12,
                  radiusX: 4,
                  radiusY: 4,
                  force: 1,
                  id: 1,
                },
              ],
            });
          }
        } finally {
          await gestures.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        }
        try {
          await page.waitForFunction(
            () => document.querySelector(".model-choice-list").scrollTop > 20,
          );
        } catch (error) {
          console.log(
            JSON.stringify({
              width,
              height,
              listBounds,
              start,
              x,
              debug: await page.evaluate(
                ({ x, start }) => ({
                  hit: document.elementFromPoint(x, start)?.outerHTML.slice(0, 400),
                  viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                    visual: window.visualViewport?.height,
                    scale: window.visualViewport?.scale,
                  },
                  list: document
                    .querySelector(".model-choice-list")
                    ?.getBoundingClientRect()
                    .toJSON(),
                  scroll: document.querySelector(".model-choice-list")?.scrollTop,
                  touches: window.modelTouchEvents,
                }),
                { x, start },
              ),
            }),
          );
          await page.screenshot({
            path: path.join(output, `${theme}-${width}x${height}-touch-failure.png`),
          });
          throw error;
        }
        const touches = await page.evaluate(() => window.modelTouchEvents);
        const touchScrollTop = await list.evaluate((node) => node.scrollTop);
        for (const type of ["touchstart", "touchmove", "touchend"])
          assert.ok(
            touches.some((event) => event.type === type && event.trusted),
            `browser dispatched trusted ${type}`,
          );
        assert.deepEqual(
          await page.evaluate(() => window.modelChanges),
          [],
          "a swipe never selects a model",
        );
        assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0);
        await picker.getByRole("searchbox", { name: "搜索模型" }).fill("fixture 59");
        const last = picker.getByRole("option", { name: "Codex Fixture 59", exact: true });
        await last.tap();
        await picker.waitFor({ state: "detached" });
        assert.equal(await models.getAttribute("value"), "codex/fixture-59");
        assert.equal(await models.evaluate((node) => document.activeElement === node), true);
        assert.equal(await input.inputValue(), "First line");
        assert.deepEqual(await page.evaluate(() => window.sends), []);
        assert.deepEqual(await page.evaluate(() => window.opened), []);
        const controls = await page.locator(".composer-toolbar").evaluate((node) => {
          const controls = [...node.querySelectorAll("button")].filter(
            (button) => button.getBoundingClientRect().width > 0,
          );
          return controls.map((button) => {
            const r = button.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return {
              label: button.getAttribute("aria-label"),
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              hit: button.contains(hit),
            };
          });
        });
        for (const control of controls) {
          assert.ok(control.width >= 44 && control.height >= 44, JSON.stringify(control));
          assert.ok(control.x >= 0 && control.x + control.width <= width, JSON.stringify(control));
          assert.equal(control.hit, true, JSON.stringify(control));
        }
        const composerHeight = await page
          .locator(".composer-wrap")
          .evaluate((node) => node.getBoundingClientRect().height);
        await page.screenshot({
          path: path.join(output, `${theme}-${width}x${height}-layout.png`),
        });
        assert.ok(
          composerHeight <= 152,
          `compact idle composer: ${composerHeight}; ${JSON.stringify(await page.locator(".composer textarea, .composer-toolbar, .composer-caption").evaluateAll((nodes) => nodes.map((node) => ({ className: node.className, height: node.getBoundingClientRect().height, display: getComputedStyle(node).display }))))}`,
        );
        await models.tap();
        await picker.getByRole("searchbox", { name: "搜索模型" }).fill("no matching model");
        await picker.getByText("没有匹配的模型", { exact: true }).waitFor();
        await picker.getByRole("button", { name: "关闭模型选择" }).tap();
        await picker.waitFor({ state: "detached" });
        assert.equal(await models.getAttribute("value"), "codex/fixture-59");
        await models.tap();
        await page.keyboard.press("Escape");
        await picker.waitFor({ state: "detached" });
        assert.equal(await models.evaluate((node) => document.activeElement === node), true);
        await page.screenshot({
          path: path.join(output, `${theme}-${width}x${height}-composer.png`),
        });
        await models.tap();
        await page.screenshot({
          path: path.join(output, `${theme}-${width}x${height}-models.png`),
        });
        await page.evaluate(() => window.patchFixture({ running: true }));
        await picker.waitFor({ state: "detached" });
        assert.equal(await models.isDisabled(), true);
        await page.evaluate(() => window.patchFixture({ running: false }));
        reports.push({
          theme,
          width,
          height,
          modelDialog: bounds,
          scroll: metrics,
          touchScrollTop,
          trustedTouchTypes: [
            ...new Set(touches.filter((event) => event.trusted).map((event) => event.type)),
          ],
          controls,
          composerHeight,
        });
      }
      await gestures.detach();
      await models.tap();
      await picker.getByRole("searchbox", { name: "搜索模型" }).fill("fixture 0");
      await picker.getByRole("option", { name: "Claude Code Fixture 0", exact: true }).tap();
      assert.equal(await models.getAttribute("value"), "claude-code/fixture-0");
      await page.evaluate(() => window.patchFixture({ model: "codex/saved-unavailable" }));
      await models.tap();
      const saved = picker.getByRole("option", {
        name: "codex/saved-unavailable · 当前会话",
        exact: true,
      });
      assert.equal(await saved.getAttribute("aria-selected"), "true");
      await page.keyboard.press("End");
      assert.equal(
        await picker
          .getByRole("option", { name: "Codex Fixture 59", exact: true })
          .evaluate((node) => document.activeElement === node),
        true,
      );
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      assert.equal(await saved.evaluate((node) => document.activeElement === node), true);
      await page.keyboard.press("Escape");
      assert.equal(await models.getAttribute("value"), "codex/saved-unavailable");
      await models.tap();
      await page.evaluate(() => window.patchFixture({ scope: "different-session" }));
      await picker.waitFor({ state: "detached" });
      assert.deepEqual(await page.evaluate(() => window.sends), []);
      assert.deepEqual(await page.evaluate(() => window.opened), []);

      assert.ok(
        await page
          .locator(".composer-toolbar")
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
        "runtime choices and send controls must fit a 320px phone",
      );
      await page.evaluate(() => window.patchFixture({ retry: true }));
      await page.getByRole("button", { name: "重试建立会话" }).waitFor();
      assert.ok(
        await page
          .locator(".composer-toolbar")
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
        "creation and model discovery retry controls must fit a 320px phone",
      );
      await page.evaluate(() => window.patchFixture({ retry: false }));
      assert.ok(
        await page
          .locator(".messages")
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
        "long goal text must stay within the transcript",
      );
      await input.fill("First line");
      await input.press("Enter");
      assert.deepEqual(
        await page.evaluate(() => window.sends),
        [],
        "phone Enter should keep a multiline draft",
      );
      assert.equal(await input.inputValue(), "First line\n");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.sends), ["First line\n"]);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(() => !document.querySelector(".rail")?.hasAttribute("role"));
      await input.fill("Composing draft");
      await input.evaluate((node) =>
        node.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
        ),
      );
      assert.equal(await input.inputValue(), "Composing draft");
      await input.press("Enter");
      assert.deepEqual(await page.evaluate(() => window.sends), [
        "First line\n",
        "Composing draft",
      ]);
      await page.setViewportSize({ width: 320, height: 360 });
      await page.waitForFunction(
        () => document.querySelector(".rail")?.getAttribute("role") === "dialog",
      );
      await page.evaluate(() => window.patchFixture({ asking: true, running: true }));
      const answer = page.getByRole("textbox", { name: "自定义回答", exact: true });
      await answer.waitFor();
      assert.ok(
        await answer.evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 16),
        "phone answer input must avoid focus zoom",
      );
      const approvalBounds = await page.locator(".approval").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, scroll: node.scrollWidth, client: node.clientWidth };
      });
      assert.ok(
        approvalBounds.scroll <= approvalBounds.client + 1,
        "long approval options must wrap",
      );
      await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
      await page.locator(".desktop-cli-sessions summary").click();
      const opener = page.locator(".desktop-cli-sessions .session").first();
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "选择 CLI 权限模式", exact: true });
      await dialog.waitFor();
      const dialogBounds = await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          scroll: node.scrollWidth,
          client: node.clientWidth,
          top: rect.top,
          bottom: rect.bottom,
          viewport: window.innerHeight,
        };
      });
      assert.ok(
        dialogBounds.scroll <= dialogBounds.client + 1,
        "long CLI title must wrap within dialog",
      );
      assert.ok(
        dialogBounds.top >= 15 && dialogBounds.bottom <= dialogBounds.viewport - 15,
        "CLI dialog needs a viewport margin",
      );
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(await opener.evaluate((node) => document.activeElement === node), true);
      await opener.click();
      await dialog.getByRole("button", { name: /逐次确认/ }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.locator(".rail").isVisible(), false);
      assert.equal(
        await page
          .getByRole("button", { name: "展开侧栏", exact: true })
          .evaluate((node) => document.activeElement === node),
        true,
      );
      assert.equal(await page.evaluate(() => window.opened.length), 1);
      await page.screenshot({ path: path.join(output, `${theme}-320x360-approval.png`) });
      reports.push({ theme, approvalBounds, dialogBounds });
      await context.close();
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ output, reports }, null, 2));
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ reports, errors, blocked }, null, 2),
  );
  await browser.close();
}
