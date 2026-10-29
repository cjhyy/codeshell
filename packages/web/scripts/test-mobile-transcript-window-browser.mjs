/** Real Workbench, synthetic history, no provider requests or user state. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const source = `
import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';
const noop=()=>{};
window.fixtureMessages=(count,prefix='history')=>Array.from({length:count},(_,i)=>({kind:i%2?'assistant':'user',id:prefix+'-'+i,text:prefix+' '+i+(i%2?': **saved output**\\n\\nA synthetic paragraph with enough text to wrap on a narrow phone screen.':' saved input'),done:true}));
function Fixture(){const[state,setState]=React.useState({items:window.fixtureMessages(2000),activeId:'owned-session',connection:'open',loading:false});
window.patchFixture=patch=>setState(current=>({...current,...patch}));window.fixtureItemCount=state.items.length;
const controller={host:'desktop',workspaceApi:false,connection:state.connection,activeId:state.activeId,loading:state.loading,chat:{items:state.items,run:'idle'},sessions:[],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:'owned',title:'Synthetic history',configuration:null,configurationVersion:0,sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,error:'',clearError:noop,setDraft:noop,removeFile:noop,selectSession:noop,newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:noop};
return <Workbench controller={controller}/>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: "out",
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
  blocked = [];
try {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://transcript-window-owned.test" && url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
      });
    if (
      url.origin === "http://transcript-window-owned.test" &&
      url.pathname === "/api/v1/environment"
    )
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://transcript-window-owned.test/");
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  const started = Date.now();
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
  });
  await page.locator(".msg").first().waitFor();
  const initial = {
    messages: await page.locator(".msg").count(),
    elapsedMs: Date.now() - started,
    retained: await page.evaluate(() => window.fixtureItemCount),
  };
  if (process.argv.includes("--baseline")) {
    console.log(JSON.stringify({ baseline: initial }));
  } else {
    assert.equal(initial.messages, 80, "initial DOM must contain only the recent history window");
    assert.equal(initial.retained, 2000, "the full recovered history remains available");
    const earlier = page.getByRole("button", { name: /显示更早消息/ });
    await page.locator(".messages").evaluate((node) => {
      node.scrollTop = 0;
    });
    await earlier.scrollIntoViewIfNeeded();
    const firstText = await page.locator(".msg").first().textContent();
    const anchor = page.getByText(firstText, { exact: true });
    const before = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    await earlier.click();
    await page.waitForFunction(() => document.querySelectorAll(".msg").length === 160);
    const after = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(
      Math.abs(after - before) <= 2,
      `older history moved the reading anchor: ${before} -> ${after}`,
    );
    await page.evaluate(() =>
      window.patchFixture({
        items: [
          ...window.fixtureMessages(2000),
          { kind: "assistant", id: "live", text: "New live output", done: false },
        ],
      }),
    );
    await page.waitForFunction(() => document.querySelectorAll(".msg").length === 161);
    assert.equal(
      await page.locator(".msg").nth(80).textContent(),
      firstText,
      "appends must not move the retained boundary",
    );
    const beforeReconnect = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    await page.evaluate(() => window.patchFixture({ connection: "connecting", loading: true }));
    await page.evaluate(() => window.patchFixture({ connection: "open", loading: false }));
    assert.equal(await page.locator(".msg").count(), 161);
    assert.ok(
      Math.abs(
        (await anchor.evaluate((node) => node.getBoundingClientRect().top)) - beforeReconnect,
      ) <= 2,
      "reconnect must retain the reading position",
    );
    await page.evaluate(() =>
      window.patchFixture({
        activeId: "other-session",
        items: window.fixtureMessages(2000, "other"),
      }),
    );
    await page.waitForFunction(() => document.querySelectorAll(".msg").length === 80);
    assert.match(await page.locator(".msg").first().textContent(), /^other 1920/);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    console.log(
      JSON.stringify({
        initial,
        expanded: 160,
        appended: 161,
        anchorDelta: after - before,
        switched: 80,
      }),
    );
  }
} finally {
  await browser.close();
}
