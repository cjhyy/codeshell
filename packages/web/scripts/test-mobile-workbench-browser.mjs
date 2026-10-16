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
import{Workbench}from'./Workbench';import{DesktopSidebar,DesktopApproval}from'./DesktopControls';
const noop=()=>{},long='ownedlongidentifier'.repeat(35);window.sends=[];window.opened=[];
function Fixture(){const[state,setState]=React.useState({draft:'First line',running:false,asking:false});
window.patchFixture=patch=>setState(current=>({...current,...patch}));
const approval={id:'owned-approval',requestId:'owned-approval',toolName:'__ask_user__',description:long,summary:long,risk:'low',options:[long],optionsOnly:false};
const app={status:'online',activeProjectId:'owned-project',activeProjectCwd:'/owned',activeCwd:'/owned',projects:[{id:'owned-project',name:'Owned project',path:'/owned'}],loading:{sessions:false,ccSessions:false},ccCliKind:'codex',ccProbe:{available:true},ccSessions:[{sessionId:'owned-cli',firstMessage:long,cwd:'/owned',messageCount:1}],selectProject:noop,refreshSessions:noop,setCcCliKind:noop,newSession:noop,openCcSession:(...args)=>window.opened.push(args),respondApproval:noop};
const controller={host:'desktop',workspaceApi:true,connection:'open',activeId:'owned-session',chat:{goal:long,items:[{kind:'assistant',id:'owned-output',text:'Owned transcript',done:true}],run:state.running?'running':'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:long,configuration:null,configurationVersion:0,sessionsVersion:0,draft:state.draft,files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:state.running,localDrafts:[],approvals:state.asking?[approval]:[],approvalCount:()=>0,approvalContent:state.asking?<DesktopApproval approval={approval} app={app}/>:null,error:'',clearError:noop,setDraft:draft=>setState(current=>({...current,draft})),removeFile:noop,selectSession:noop,newSession:noop,send:()=>{window.sends.push(state.draft);setState(current=>({...current,draft:''}));return true},stop:noop,addFiles:noop,cameraAttachments:true,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:noop,renderSidebar:navigation=><DesktopSidebar app={app} navigation={navigation}/>};
return <Workbench controller={controller}/>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
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
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 320, height: 568 },
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
    assert.ok(
      await page.locator(".messages").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
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
    assert.deepEqual(await page.evaluate(() => window.sends), ["First line\n", "Composing draft"]);
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
