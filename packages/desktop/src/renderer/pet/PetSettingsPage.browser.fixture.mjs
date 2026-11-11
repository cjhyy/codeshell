/* Production Mimi settings page (shell + sections); all Host calls and network are fixture-owned. */
/* global window, document */
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
const output = process.env.CODESHELL_PET_SETTINGS_QA_DIR || "/tmp/codeshell-pet-settings-qa";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PetSettingsPage} from './pet/PetSettingsPage';
import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';
import {ToastProvider} from './ui/ToastProvider';
import {applyTheme} from './theme';
let reads=[],writes=[],settings={responseLanguage:'中文',userProfile:'Existing profile',communicationStyle:'Concise',customInstructions:'Existing instructions'};
window.fixture={
  get reads(){return reads.length},get writes(){return writes.map(({value})=>value)},
  finishRead(index,success){const operation=reads[index];if(!operation)throw new Error('Missing read');
    if(success)operation.resolve({pet:{personalization:structuredClone(settings)}});
    else operation.reject(new Error('Fixture settings read denied: '+'LongIdentifier'.repeat(40)));},
  finishWrite(index,success){const operation=writes[index];if(!operation)throw new Error('Missing write');
    if(success){settings=structuredClone(operation.value);operation.resolve();}else operation.reject(new Error('Fixture settings write denied'));},
};
const notices={channels:[{id:'wechat',label:'个人微信 '+'LongChannelName'.repeat(6),ready:'ready'}],
  systemRule:{state:'active',channel:'auto',events:['done','failed','blocked']},
  settings:{quietHours:{enabled:true,start:'23:00',end:'08:30'},maxPerHour:6,maxP0PerHour:12,mergeWindowSec:600,presenceIdleSec:120,delegatedFromDesktop:'auto',
    briefs:{morning:{enabled:true,time:'09:00'},evening:{enabled:false,time:'18:30'}},heartbeat:{enabled:true,activeHours:{start:'09:00',end:'22:00'}},digestSlots:['12:00','18:00','21:00']},
  proactive:{briefs:{morning:{lastSentDay:'2026-11-11'},evening:{}},heartbeat:{judgedToday:3,saidToday:1,judgeCap:8,sayCap:4,atJudgeCap:false,atSayCap:false}},
  // Long Session and follow-up titles: the rule list must wrap, not scroll sideways.
  rules:[
    {id:'all-sessions',version:1,kind:'all-sessions',state:'active',source:'system',events:['done','failed','blocked'],target:{kind:'auto',label:'个人微信'},actions:['pause'],updatedAt:1},
    {id:'system-brief-morning',version:2,kind:'system-brief',state:'active',source:'system',brief:'morning',dailyAt:'09:00',schedule:{cron:'0 9 * * *',timezone:'Asia/Shanghai',nextAt:Date.UTC(2026,10,12,1)},lastFiredAt:Date.UTC(2026,10,11,1),lastOutcome:'notified',target:{kind:'auto',label:'个人微信'},actions:['pause'],updatedAt:2},
    {id:'system-heartbeat',version:1,kind:'system-heartbeat',state:'active',source:'system',activeHours:{start:'09:00',end:'22:00'},target:{kind:'auto',label:'个人微信'},actions:['pause'],updatedAt:1},
    {id:'rule-s',version:1,kind:'session',state:'active',source:'watch',sessionId:'s-1',sessionTitle:'修登录 '+'VeryLongSessionTitle'.repeat(8),events:['done','failed','blocked'],scope:'goal',target:{kind:'chat',label:'飞书',direct:false},actions:['pause','cancel'],updatedAt:3},
    {id:'rule-f',version:1,kind:'schedule',state:'paused',source:'follow-up',title:'跟进 '+'LongFollowUpTitle'.repeat(8),followUp:'continue',sessionId:'s-2',schedule:{cron:'0 9 * * 1-5',label:'工作日 09:00',timezone:'Asia/Shanghai'},target:{kind:'channel',label:'Telegram',ready:'unknown'},actions:['resume','cancel'],updatedAt:4},
    {id:'rule-e',version:2,kind:'session',state:'spent',source:'owner',sessionId:'s-3',sessionTitle:'旧会话',events:['done'],scope:'turn',lastFiredAt:Date.UTC(2026,10,10,3),target:{kind:'desktop'},actions:[],updatedAt:1},
  ]};
const presence={visible:true,mode:'docked',effectiveMode:'docked',size:200,appearance:'mimi-sprite',shown:'docked',movingAvailable:true,previewing:false};
window.codeshell={
  getSettings:scope=>{if(scope!=='user')throw new Error('Wrong settings scope');return new Promise((resolve,reject)=>reads.push({resolve,reject}));},
  updateSettings:(scope,patch)=>{if(scope!=='user')throw new Error('Wrong write scope');return new Promise((resolve,reject)=>writes.push({value:structuredClone(patch.pet.personalization),resolve,reject}));},
  log:()=>{},
  pet:{
    getNoticesState:async()=>structuredClone(notices),onNoticesChanged:()=>()=>{},setSystemNoticeRule:async patch=>({...notices.systemRule,...patch}),updateNoticeRule:async()=>({ok:true}),
    listMemories:async()=>[{id:'m1',text:'Likes concise updates',source:'user'},{id:'m2',text:'Works on CodeShell',source:'auto'}],
    listJournal:async()=>[],onMemoriesChanged:()=>()=>{},onJournalChanged:()=>()=>{},
    getMemoryAutoExtract:async()=>true,setMemoryAutoExtract:async value=>value,
  },
  imGateway:{
    status:async()=>({running:true,configPath:'/fixture/.code-shell/im-gateway/config.json',configExists:true,channels:['wechat','telegram'],wechatConnected:true,
      channelStatuses:[{channel:'wechat',enabled:true,state:'running'},{channel:'telegram',enabled:true,state:'retrying',error:'Fixture telegram error '+'LongIdentifier'.repeat(12)}],
      recentActivity:[{id:'a1',channel:'wechat',direction:'inbound',status:'ok',text:'Fixture message '+'LongWord'.repeat(20),createdAt:0,senderId:'owner',target:'mimi'}]}),
    onEvent:()=>()=>{},start:async()=>undefined,stop:async()=>undefined,ensureConfig:async()=>'/fixture/config.json',
  },
  openInEditor:async()=>undefined,openPath:async()=>undefined,openExternal:async()=>undefined,
};
const root=createRoot(document.getElementById('root'));
function Fixture(){
  const [open,setOpen]=React.useState(true);
  const [section,setSection]=React.useState('conversation');
  window.leaveFixture=()=>setOpen(false);window.reopenFixture=()=>setOpen(true);
  return <div className='flex h-screen flex-col bg-background text-foreground'>
    {open?<PetSettingsPage section={section} onSectionChange={setSection} backLabel='Back' onBack={()=>setOpen(false)}
      activeModelKey='fixture-model' modelOptions={[{key:'fixture-model',label:'Fixture model',provider:'Fixture'}]} hasModelOverride={false}
      onSelectModel={()=>{}} onResetModel={()=>{}} widgetVisible presence={presence}
      presenceError={'Fixture presence failure '+'LongIdentifier'.repeat(10)} onDismissPresenceError={()=>{}}
      onWidgetVisibleChange={()=>{}} onPresenceChange={()=>{}} onPreviewMoving={async()=>{}} onRetryPresence={()=>{}}
      onOpenMemoryCenter={()=>{}}/>:<p id='left-page'>Left personalization</p>}
  </div>;
}
window.renderFixture=({lang,mode})=>{
  saveUILanguage(lang);applyTheme(mode);
  root.render(<React.StrictMode><I18nProvider><ToastProvider><Fixture/></ToastProvider></I18nProvider></React.StrictMode>);
};
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  // The page shows the Mimi sprite; inline images keep the fixture off the network.
  loader: { ".png": "dataurl", ".webp": "dataurl", ".wav": "empty", ".css": "empty" },
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
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const errors = [],
  blocked = [],
  reports = [];
async function mount(width, lang, mode) {
  const page = await browser.newPage({
    viewport: { width, height: 600 },
    serviceWorkers: "block",
    colorScheme: mode,
  });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://pet-settings-fixture.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://pet-settings-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((options) => window.renderFixture(options), { lang, mode });
  await page.waitForFunction(() => window.fixture.reads === 2);
  return page;
}
const SECTIONS = ["appearance", "conversation", "notifications", "rules", "memory", "connections"];
async function noHorizontalOverflow(page, phase) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("[data-pet-settings-section]");
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  if (overflow.document > 1 || overflow.main > 1) {
    await page.screenshot({ path: path.join(output, `overflow-${phase}.png`), fullPage: true });
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll("[data-pet-settings-section] *")]
        .filter(
          (element) => element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0,
        )
        .slice(0, 5)
        .map((element) => `${element.tagName}.${element.className}`.slice(0, 160)),
    );
    assert.fail(`${phase}: horizontal overflow ${JSON.stringify(overflow)} ${wide.join(" | ")}`);
  }
}
// Wide windows show the section list; narrow ones a picker above the section.
async function shellSections(page, width, lang, mode) {
  const nav = page
    .locator("nav[aria-label]")
    .filter({ has: page.locator("[data-pet-settings-nav-item]") });
  const picker = page.locator("[data-pet-settings-section-picker]");
  const wide = width >= 720;
  assert.equal(await nav.isVisible(), wide, `${width}: section list visibility`);
  assert.equal(await picker.isVisible(), !wide, `${width}: section picker visibility`);
  for (const section of SECTIONS) {
    if (wide) await page.locator(`[data-pet-settings-nav-item="${section}"]`).click();
    else {
      await picker.click();
      await page.getByRole("option").nth(SECTIONS.indexOf(section)).click();
    }
    await page.locator(`[data-pet-settings-section="${section}"]`).waitFor();
    // Let async section content (notices, memory, gateway) arrive before measuring.
    await page.waitForTimeout(50);
    await noHorizontalOverflow(page, `${width}-${lang}-${mode}-${section}`);
    await page.screenshot({
      path: path.join(output, `shell-${section}-${width}-${lang}-${mode}.png`),
    });
  }
  if (wide) {
    await page.locator('[data-pet-settings-nav-item="appearance"]').focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-pet-settings-nav-item")),
      "conversation",
      "Arrow keys move through the section list",
    );
    await page.locator('[data-pet-settings-nav-item="conversation"]').click();
  } else {
    await picker.click();
    await page.getByRole("option").nth(1).click();
  }
  await page.locator('[data-pet-settings-section="conversation"]').waitFor();
  return SECTIONS.length;
}
async function geometry(page, phase) {
  const snapshot = await page.locator("[data-pet-personalization-fields]").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: window.innerWidth,
      left: rect.left,
      right: rect.right,
      client: element.clientWidth,
      scroll: element.scrollWidth,
    };
  });
  assert(
    snapshot.left >= 0 && snapshot.right <= snapshot.width + 1,
    `${phase}: form within viewport`,
  );
  assert(snapshot.scroll <= snapshot.client + 1, `${phase}: long text wraps`);
}
try {
  for (const width of [390, 1000])
    for (const lang of ["zh", "en"]) {
      const mode = lang === "zh" ? "light" : "dark";
      const page = await mount(width, lang, mode);
      const fields = page.locator("[data-pet-personalization-fields]").locator("input,textarea");
      for (const field of await fields.all())
        assert(await field.isDisabled(), "Fields wait for the settings snapshot");
      await page.evaluate(() => window.fixture.finishRead(1, false));
      await page.getByRole("alert").first().waitFor();
      await geometry(page, "read-error");
      const retry = page.getByRole("button", {
        name: lang === "zh" ? "重试" : "Retry",
        exact: true,
      });
      await retry.click();
      await page.waitForFunction(() => window.fixture.reads === 3);
      for (const field of await fields.all())
        assert(await field.isDisabled(), "Retry keeps uninitialized fields disabled");
      await page.evaluate(() => window.fixture.finishRead(2, true));
      await page.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
      assert.equal(await page.locator("#pet-user-profile").inputValue(), "Existing profile");
      await page.locator("#pet-user-profile").fill("My latest profile");
      await page.locator("#pet-user-profile").blur();
      await page.waitForFunction(() => window.fixture.writes.length === 1);
      // A StrictMode read from the discarded mount cannot replace the edited form.
      await page.evaluate(() => window.fixture.finishRead(0, true));
      assert.equal(await page.locator("#pet-user-profile").inputValue(), "My latest profile");
      await page.evaluate(() => window.fixture.finishWrite(0, false));
      await page.locator('[data-pet-personalization-fields] [role="alert"]').waitFor();
      assert.equal(
        await page.locator("#pet-custom-instructions").inputValue(),
        "Existing instructions",
      );
      await retry.click();
      await page.waitForFunction(() => window.fixture.writes.length === 2);
      const retryDraft = await page.evaluate(() => window.fixture.writes[1]);
      assert.deepEqual(retryDraft, {
        responseLanguage: "中文",
        userProfile: "My latest profile",
        communicationStyle: "Concise",
        customInstructions: "Existing instructions",
      });
      // Save a newer draft while the previous write is still in flight.
      await page.locator("#pet-user-profile").fill("Newest profile");
      await page.locator("#pet-user-profile").blur();
      await page.waitForTimeout(650);
      assert.equal(
        await page.evaluate(() => window.fixture.writes.length),
        2,
        "Writes are serialized",
      );
      await page.evaluate(() => window.fixture.finishWrite(1, true));
      await page.waitForFunction(() => window.fixture.writes.length === 3);
      assert.equal(
        await page.evaluate(() => window.fixture.writes[2].userProfile),
        "Newest profile",
      );
      await page.evaluate(() => window.fixture.finishWrite(2, true));
      await page
        .locator('[data-pet-personalization-fields] [role="alert"]')
        .waitFor({ state: "hidden" });
      await geometry(page, "ready");
      await page.screenshot({
        path: path.join(output, `personalization-${width}-${lang}-${mode}.png`),
      });
      const sections = await shellSections(page, width, lang, mode);
      reports.push({
        width,
        lang,
        mode,
        readRecovery: true,
        draftPreserved: true,
        orderedWrites: true,
        sections,
      });
      await page.close();
    }
  // Leaving the page flushes a debounce to its original draft and handles rejection.
  const page = await mount(390, "zh", "light");
  await page.evaluate(() => window.fixture.finishRead(1, true));
  await page.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
  await page.locator("#pet-user-profile").fill("Navigation draft");
  // Programmatic navigation avoids blur, so this exercises cleanup's flush.
  await page.evaluate(() => window.leaveFixture());
  await page.locator("#left-page").waitFor();
  await page.waitForFunction(() => window.fixture.writes.length === 1);
  assert.equal(await page.evaluate(() => window.fixture.writes[0].userProfile), "Navigation draft");
  await page.evaluate(() => window.fixture.finishWrite(0, false));
  await page.getByRole("status").filter({ hasText: "个性化设置保存失败" }).waitFor();
  await page.close();

  // A reopened form waits for the previous instance's queued snapshots.
  const reopened = await mount(390, "zh", "light");
  await reopened.evaluate(() => window.fixture.finishRead(1, true));
  await reopened.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
  await reopened.locator("#pet-user-profile").fill("First pending draft");
  await reopened.locator("#pet-user-profile").blur();
  await reopened.waitForFunction(() => window.fixture.writes.length === 1);
  await reopened.locator("#pet-custom-instructions").fill("Latest pending instructions");
  await reopened.evaluate(() => window.leaveFixture());
  await reopened.locator("#left-page").waitFor();
  await reopened.evaluate(() => window.reopenFixture());
  await reopened.locator("#pet-user-profile").waitFor();
  assert(await reopened.locator("#pet-user-profile").isDisabled());
  assert.equal(
    await reopened.evaluate(() => window.fixture.reads),
    2,
    "New reads wait for the queue",
  );
  await reopened.evaluate(() => window.fixture.finishWrite(0, true));
  await reopened.waitForFunction(() => window.fixture.writes.length === 2);
  assert.equal(await reopened.evaluate(() => window.fixture.reads), 2);
  await reopened.evaluate(() => window.fixture.finishWrite(1, true));
  await reopened.waitForFunction(() => window.fixture.reads === 4);
  await reopened.evaluate(() => window.fixture.finishRead(3, true));
  await reopened.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
  assert.equal(await reopened.locator("#pet-user-profile").inputValue(), "First pending draft");
  assert.equal(
    await reopened.locator("#pet-custom-instructions").inputValue(),
    "Latest pending instructions",
  );
  await reopened.close();
  assert.deepEqual(errors, [], "No unhandled renderer errors");
  assert.deepEqual(blocked, [], "No external network requests");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ reports, errors, blocked }, null, 2),
  );
  console.log(
    JSON.stringify(
      { result: "pass", scenarios: reports.length + 2, errors, blocked, output },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
