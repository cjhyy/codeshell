/** Real native CLI view with an owned IPC bridge; no Electron, user profile or CLI.
 * Run via scripts/run-isolated-node-smoke.mjs. --source-repo bundles another checkout.
 */
/* global window, document, requestAnimationFrame, DataTransfer, DragEvent */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceIndex = process.argv.indexOf("--source-repo");
const repo =
  sourceIndex < 0
    ? fileURLToPath(new URL("../../../../..", import.meta.url))
    : path.resolve(process.argv[sourceIndex + 1]);
const desktop = path.join(repo, "packages/desktop");
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-native-cli-settings-"));
await mkdir(output, { recursive: true });
console.log(`Native CLI browser evidence: ${output}`);
const origin = "http://native-cli-settings-owned.test";
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CCConversationView} from './cc-room/CCConversationView';
import {I18nProvider} from './i18n/I18nProvider';
import {ToastProvider} from './ui/ToastProvider';
import {saveUILanguage} from './uiLanguage';
const long='verylongownedidentifier'.repeat(24),noop=()=>{};
const listeners={state:new Set(),message:new Set(),approval:new Set(),resolved:new Set()};
const listen=(name,cb)=>{listeners[name].add(cb);return()=>listeners[name].delete(cb)};
const emit=(name,event)=>{for(const listener of listeners[name])listener(event)};
let authority={roomId:'owned-room',sessionId:'owned-session-'+long,cwd:'/owned/'+long,kind:'codex',
  permissionMode:'default',modelKey:'codex/owned-a',observing:false};
let pendingSettings,pendingSend,settingsHolds=[],historyHolds=[];
window.fixture={opens:[],sends:[],modelReads:0,holdSettings:true,holdHistory:false};
const snapshot=()=>({active:true,messages:[{role:'assistant',text:'Owned native CLI transcript'}],roomCursor:0});
const readSettings=async()=>window.fixture.holdSettings?new Promise(resolve=>settingsHolds.push(resolve)):{...authority};
window.codeshell={log:noop,externalRuntime:{models:async()=>{window.fixture.modelReads++;return[
  {key:'codex/owned-a',kind:'codex',provider:'codex',label:'Codex Owned A'},
  {key:'codex/owned-b',kind:'codex',provider:'codex',label:'Codex Owned B '+long},
  {key:'claude-code/owned-c',kind:'claude-code',provider:'claude-code',label:'Claude Owned C'},
]}},ccRoom:{
  settingsState:readSettings,
  onRoomState:cb=>listen('state',cb),onRoomMessage:cb=>listen('message',cb),
  onApprovalRequest:cb=>listen('approval',cb),onApprovalResolved:cb=>listen('resolved',cb),
  subscribeTranscript:async()=>window.fixture.holdHistory?new Promise(resolve=>historyHolds.push(resolve)):snapshot(),
  unsubscribeTranscript:async()=>{},
  roomHistoryPage:async(_room,request)=>({snapshotId:'owned-snapshot',throughSeq:request.sinceSeq??0,messages:[],complete:true}),
  openSession:(session,cwd,mode,kind,settings)=>{window.fixture.opens.push({session,cwd,mode,kind,settings});
    return new Promise((resolve,reject)=>{pendingSettings={resolve,reject,mode,settings}})},
  send:(_room,text)=>{window.fixture.sends.push(text);return new Promise(resolve=>{pendingSend=resolve})},
  respondApproval:async()=>{},
}};
window.WebSocket=class {constructor(){throw Error('No socket allowed in owned native CLI fixture')}};
window.fixture.releaseSettings=()=>{window.fixture.holdSettings=false;for(const resolve of settingsHolds.splice(0))resolve({...authority})};
window.fixture.releaseHistory=()=>{window.fixture.holdHistory=false;for(const resolve of historyHolds.splice(0))resolve(snapshot())};
window.fixture.authority=patch=>{authority={...authority,...patch};emit('state',{id:authority.roomId})};
window.fixture.acceptSettings=()=>{const pending=pendingSettings;pendingSettings=undefined;
  authority={...authority,permissionMode:pending.mode,
    ...(Object.hasOwn(pending.settings,'modelKey')?{modelKey:pending.settings.modelKey}:{})};
  pending.resolve({roomId:authority.roomId,status:'running',permissionMode:authority.permissionMode,modelKey:authority.modelKey})};
window.fixture.rejectSettings=()=>{const pending=pendingSettings;pendingSettings=undefined;pending.reject(Error('Owned setting change rejected'))};
window.fixture.finishSend=accepted=>pendingSend(accepted);
window.fixture.approval=active=>emit(active?'approval':'resolved',active
  ?{roomId:'owned-room',requestId:'owned-approval',toolName:'Bash',description:'Owned command',input:{command:'owned command'}}
  :{roomId:'owned-room',requestId:'owned-approval'});
window.fixture.oldHost=()=>{window.codeshell.ccRoom.settingsState=undefined};
function Fixture(){const [props,setProps]=React.useState({observing:false,active:true});
  window.fixture.patch=patch=>setProps(current=>({...current,...patch}));
  return <main style={{height:'100dvh',display:'flex',flexDirection:'column',minWidth:0}}>
    <CCConversationView roomId={authority.roomId} cwd={authority.cwd} sessionId={authority.sessionId}
      mode='default' modelKey='codex/owned-a' cliKind='codex' cliLabel='Codex' onBack={noop} {...props}/>
  </main>;
}
saveUILanguage('zh-CN');
createRoot(document.getElementById('root')).render(<I18nProvider><ToastProvider><Fixture/></ToastProvider></I18nProvider>);
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
const report = { checks: [], errors: [], blocked: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const input = (page) => page.locator("[data-cc-room-composer]");
const model = (page) => page.locator("[data-cc-room-model]");
const permission = (page) => page.locator("[data-cc-room-permission]");
const send = (page) => page.locator("[data-cc-room-send]");
const readModel = (page) => page.locator('select[name="cc-room-model"]').inputValue();
const readPermission = (page) => page.locator('select[name="cc-room-permission"]').inputValue();
const patch = async (page, value) => {
  await page.evaluate((next) => window.fixture.patch(next), value);
  await frames(page);
};
const authority = async (page, value) => {
  await page.evaluate((next) => window.fixture.authority(next), value);
  await frames(page);
};
const choose = async (page, trigger, label) => {
  await trigger.click();
  await page.getByRole("option", { name: label }).click();
  await frames(page);
};
const check = (name, evidence = {}) => report.checks.push({ name, passed: true, ...evidence });
async function layout(page, label, width) {
  await frames(page);
  const measurements = await page.evaluate(() => ({
    page: document.scrollingElement.scrollWidth - window.innerWidth,
    settings: (() => {
      const node = document.querySelector("[data-cc-room-settings]");
      return node.scrollWidth - node.clientWidth;
    })(),
    controls: [
      ...document.querySelectorAll(
        "[data-cc-room-model],[data-cc-room-permission],[data-cc-room-composer],[data-cc-room-send]",
      ),
    ].map((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        label: node.getAttribute("aria-label") || node.textContent,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        // Native Button intentionally removes pointer events when disabled.
        hit: node.disabled || node.contains(hit),
      };
    }),
  }));
  assert.ok(measurements.page <= 1, `${label}: page overflow ${measurements.page}`);
  assert.ok(measurements.settings <= 1, `${label}: settings overflow ${measurements.settings}`);
  for (const control of measurements.controls) {
    assert.ok(
      control.left >= 0 && control.right <= width + 1,
      `${label}: ${JSON.stringify(control)}`,
    );
    assert.ok(control.hit, `${label}: covered ${JSON.stringify(control)}`);
    assert.ok(control.height >= 32, `${label}: usable native control ${JSON.stringify(control)}`);
  }
  check(label, measurements);
}
try {
  for (const [width, height, dark] of [
    [360, 640, false],
    [640, 720, false],
    [1280, 800, true],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      if (route.request().method() === "GET" && route.request().url() === origin + "/")
        return route.fulfill({
          contentType: "text/html",
          body:
            '<!doctype html><html lang="zh-CN"' +
            (dark ? ' class="dark"' : "") +
            '><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
        });
      report.blocked.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto(origin + "/");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await input(page).waitFor();
    assert.equal(await model(page).isDisabled(), true);
    assert.equal(await permission(page).isDisabled(), true);
    await input(page).fill("保留原生 CLI 草稿");
    await page.evaluate(() => window.fixture.releaseSettings());
    await frames(page);
    assert.equal(await model(page).isDisabled(), false);
    assert.equal(await readModel(page), "codex/owned-a");
    await layout(page, `idle-${width}`, width);
    await input(page).evaluate((node) => {
      const transfer = new DataTransfer();
      transfer.setData("application/x-codeshell-path", "/owned/kept-before-settings.png");
      node.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });

    await model(page).click();
    assert.equal(await page.getByRole("option", { name: /Claude Owned C/ }).count(), 0);
    await page.getByRole("option", { name: /Codex Owned B/ }).click();
    await frames(page);
    assert.equal(await readModel(page), "codex/owned-a");
    assert.equal(await model(page).isDisabled(), true);
    assert.equal(await permission(page).isDisabled(), true);
    assert.equal(await send(page).isDisabled(), true);
    assert.equal(await input(page).isDisabled(), false);
    await input(page).fill("切换期间编辑的草稿");
    await input(page).press("Enter");
    assert.deepEqual(await page.evaluate(() => window.fixture.sends), []);
    assert.match(
      await page.locator("[data-cc-room-path-attachments]").textContent(),
      /kept-before-settings.png/,
    );
    await page.evaluate(() => window.fixture.rejectSettings());
    await frames(page);
    assert.equal(await readModel(page), "codex/owned-a");
    assert.equal(await input(page).inputValue(), "切换期间编辑的草稿");
    assert.match(
      await page.locator("[data-cc-room-path-attachments]").textContent(),
      /kept-before-settings.png/,
    );
    assert.match(
      await page.locator("[data-cc-room-settings]").textContent(),
      /Owned setting change rejected/,
    );
    await choose(page, model(page), /Codex Owned B/);
    await page.evaluate(() => window.fixture.acceptSettings());
    await frames(page);
    assert.equal(await readModel(page), "codex/owned-b");
    assert.equal(await input(page).inputValue(), "切换期间编辑的草稿");
    assert.match(
      await page.locator("[data-cc-room-path-attachments]").textContent(),
      /kept-before-settings.png/,
    );
    await layout(page, `long-model-${width}`, width);
    await page.screenshot({ path: path.join(output, `native-cli-${width}.png`) });
    check(`settings-ack-and-rejection-${width}`);

    const dialogs = [];
    const dismiss = async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    };
    page.on("dialog", dismiss);
    await choose(page, permission(page), "工作区读写");
    assert.deepEqual(dialogs, []);
    assert.equal(await readPermission(page), "default");
    await page.evaluate(() => window.fixture.acceptSettings());
    await frames(page);
    assert.equal(await readPermission(page), "acceptEdits");
    await choose(page, permission(page), "完全访问");
    assert.equal(dialogs.length, 1);
    assert.equal(await readPermission(page), "acceptEdits");
    page.off("dialog", dismiss);
    await choose(page, model(page), "CLI 默认模型");
    assert.equal(await page.evaluate(() => window.fixture.opens.at(-1).settings.modelKey), null);
    await page.evaluate(() => window.fixture.acceptSettings());
    await frames(page);
    assert.equal(await readModel(page), "");
    check(`permission-confirmation-and-default-${width}`);

    for (const busyReason of ["turn", "queued", "approval", "switching", "retiring"]) {
      await authority(page, { busyReason });
      assert.equal(await model(page).isDisabled(), true, busyReason);
      assert.equal(await permission(page).isDisabled(), true, busyReason);
      assert.equal(await input(page).inputValue(), "切换期间编辑的草稿");
      assert.ok(
        (await page.locator('[data-cc-room-settings] [role="status"]').textContent()).trim(),
      );
    }
    await authority(page, { busyReason: undefined });
    await page.evaluate(() => window.fixture.approval(true));
    await frames(page);
    assert.equal(await model(page).isDisabled(), true);
    await page.evaluate(() => window.fixture.approval(false));
    await frames(page);
    assert.equal(await model(page).isDisabled(), false);
    await patch(page, { observing: true });
    assert.equal(await model(page).isDisabled(), true);
    assert.equal(await permission(page).isDisabled(), true);
    assert.equal(await input(page).isDisabled(), true);
    assert.equal(await send(page).isDisabled(), true);
    await layout(page, `readonly-${width}`, width);
    await patch(page, { observing: false });
    check(`busy-and-readonly-${width}`);

    // Native CLI attachments are local path references; no file is opened or uploaded.
    await input(page).evaluate((node) => {
      const transfer = new DataTransfer();
      transfer.setData("application/x-codeshell-path", "/owned/" + "longfile".repeat(35) + ".png");
      node.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await frames(page);
    await layout(page, `attachment-${width}`, width);
    await send(page).click();
    await frames(page);
    assert.equal(await model(page).isDisabled(), true);
    assert.equal(await permission(page).isDisabled(), true);
    await input(page).fill("发送期间继续编辑的草稿");
    await page.evaluate(() => window.fixture.finishSend(true));
    await frames(page);
    assert.equal(await input(page).inputValue(), "发送期间继续编辑的草稿");
    assert.equal(await model(page).isDisabled(), false);
    check(`in-flight-send-preserves-new-draft-${width}`);

    await patch(page, { active: false });
    assert.equal(await model(page).isDisabled(), true);
    await page.evaluate(() => {
      window.fixture.holdHistory = true;
    });
    await patch(page, { active: true });
    assert.equal(await model(page).isDisabled(), true);
    assert.equal(await send(page).isDisabled(), true);
    await page.evaluate(() => window.fixture.releaseHistory());
    await frames(page);
    assert.equal(await model(page).isDisabled(), false);
    await page.evaluate(() => window.fixture.oldHost());
    await patch(page, { active: false });
    await patch(page, { active: true });
    assert.equal(await model(page).isDisabled(), true);
    assert.equal(await permission(page).isDisabled(), true);
    check(`history-and-old-host-${width}`);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blocked, []);
  console.log(`Native CLI settings browser passed: ${report.checks.length} checks; ${output}`);
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
