/* Production UsagePage/CSS with owned discovery, history and quota replies; no provider calls. */
/* global document, window */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const tailwind = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwind("@tailwindcss/node");
const { Scanner } = tailwind("@tailwindcss/oxide");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  "/tmp/codeshell-provider-usage-page-qa";
await mkdir(output, { recursive: true });

const source = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {UsagePage} from './activity/UsagePage';
import {ActivityNavigation} from './activity/ActivityNavigation';
import {I18nProvider} from './i18n/I18nProvider';
import {translate} from './i18n/translate';
import {saveUILanguage} from './uiLanguage';
import {applyTheme,saveTheme} from './theme';
const fields=['requests','promptTokens','completionTokens','totalTokens','cacheReadTokens','cacheCreationTokens','knownEstimatedCostUsd','unknownCostRequests','unknownUsageRequests','notSentRequests'];
const zero=()=>Object.fromEntries(fields.map(key=>[key,0]));
const api={...zero(),provider:'openai',model:'api-reference-model',requests:7,notSentRequests:2,promptTokens:1000,completionTokens:200,totalTokens:1200,cacheReadTokens:400,cacheCreationTokens:50,knownEstimatedCostUsd:0.125,unknownCostRequests:2,unknownUsageRequests:1};
const cli={...zero(),provider:'codex',providerKind:'external-cli',model:'cli-turn-aggregate',requests:3,promptTokens:2400,completionTokens:600,totalTokens:3000,cacheReadTokens:1200,unknownCostRequests:3,unknownUsageRequests:1};
function summary(rows,patch={}){
 const totals=zero();for(const row of rows)for(const key of fields)totals[key]+=row[key]??0;
 return {...totals,version:1,scope:'store',includesChildren:false,partial:false,persistenceErrors:0,invalidReceipts:0,scannedReceipts:rows.length,byModel:rows,bySession:[],byPurpose:[],...patch};
}
function providers(){
 return [
  {id:'cli:codex',displayName:'Codex',source:'cli',quota:{supported:true,queryCost:'none'}},
  {id:'cli:claude',displayName:'Claude Code',source:'cli',quota:{supported:true,queryCost:'minimal-usage'}},
  {id:'cli:future',displayName:'Future Agent',source:'cli',quota:{supported:true,queryCost:'none'}},
  {id:'model:fixture',displayName:'Fixture model connection',source:'model-connection',connectionCount:2,quota:{supported:false}},
 ];
}
function quotas(){
 const now=Math.floor(Date.now()/1000);
 return {
  'cli:codex':{provider:'codex',planType:'Plus',windows:[{kind:'5h',usedPercent:35,resetsAt:now+3600},{kind:'7d',usedPercent:68,resetsAt:now+86400}]},
  'cli:claude':{provider:'claude',planType:'Pro',windows:[{kind:'5h',usedPercent:12,resetsAt:now+7200},{kind:'7d',usedPercent:54,resetsAt:now+172800},{kind:'7d_sonnet',usedPercent:30,resetsAt:null}]},
  'cli:future':{provider:'future',planType:'Fixture plan',windows:[{kind:'monthly',usedPercent:42,resetsAt:now+86400}]},
 };
}
const pendingQuota=new Map();let pendingDiscovery;
window.fixture={calls:[],historyMode:'ready',quotaMode:'ready',quotaModes:{},discoveryMode:'ready',
 finishQuota(id='cli:codex'){const resolve=pendingQuota.get(id);if(!resolve)throw new Error('No pending quota query: '+id);pendingQuota.delete(id);resolve(quotas()[id])},
 finishDiscovery(){if(!pendingDiscovery)throw new Error('No pending discovery');const resolve=pendingDiscovery;pendingDiscovery=undefined;resolve(providers())},
};
window.codeshell={
 getUsageSummary:async query=>{
  window.fixture.calls.push({kind:'usage',query});
  if(window.fixture.historyMode==='error')throw new Error('Owned history read failure');
  if(window.fixture.historyMode==='empty')return summary([],{scannedReceipts:0});
  if(window.fixture.historyMode==='all-unknown')return summary([{...cli,...zero(),requests:2,unknownUsageRequests:2,unknownCostRequests:2}],{partial:true});
  if(window.fixture.historyMode==='unknown-and-not-sent')return summary([{...api,...zero(),requests:2,notSentRequests:1,unknownUsageRequests:1,unknownCostRequests:1}]);
  if(window.fixture.historyMode==='long-model')return summary([{...api,model:'model-'+('a'.repeat(240))}],{partial:true});
  if(window.fixture.historyMode==='repeated-cursor')return summary([api],{partial:true,nextCursor:'a'.repeat(64)});
  if(!query.cursor)return summary([api],{partial:true,invalidReceipts:window.fixture.historyMode==='early-invalid'?1:0,scannedReceipts:10000,nextCursor:'a'.repeat(64)});
  if(query.cursor!=='a'.repeat(64))throw new Error('Unexpected fixture cursor');
  return summary([cli],{scannedReceipts:3});
 },
 quota:{
  listProviders:async()=>{
   window.fixture.calls.push({kind:'discovery'});
   switch(window.fixture.discoveryMode){
    case 'error':throw new Error('Owned discovery failure');
    case 'empty':return [];
    case 'future-only':return providers().slice(2);
    case 'pending':return new Promise(resolve=>{pendingDiscovery=resolve});
    default:return providers();
   }
  },
  query:async id=>{
   window.fixture.calls.push({kind:'quota',id});
   if(!providers().some(provider=>provider.id===id&&provider.quota.supported))throw new Error('Unexpected fixture provider: '+id);
   const provider=quotas()[id].provider;
   switch(window.fixture.quotaModes[id]??window.fixture.quotaMode){
    case 'error':throw new Error('Owned quota failure');
    case 'missing':return {};
    case 'provider-empty':return {provider,windows:[]};
    case 'provider-invalid':return {provider,windows:[{kind:'5h',usedPercent:NaN,resetsAt:null}]};
    case 'provider-error':return {provider,error:'Fixture provider failure'};
    case 'auth-required':return {provider,error:'Fixture missing subscription sign-in',errorCode:'auth-required'};
    case 'pending':return new Promise(resolve=>{pendingQuota.set(id,resolve)});
    default:return quotas()[id];
   }
  },
 },
 openExternal:async url=>{window.fixture.calls.push({kind:'openExternal',url})},
};
const root=createRoot(document.getElementById('root'));let generation=0;
window.mountFixture=({lang='zh',mode='light',historyMode='ready',quotaMode='ready',quotaModes={},discoveryMode='ready'}={})=>{
 localStorage.clear();saveUILanguage(lang);saveTheme(mode);applyTheme(mode);
 window.fixture.calls=[];window.fixture.historyMode=historyMode;window.fixture.quotaMode=quotaMode;window.fixture.quotaModes=quotaModes;window.fixture.discoveryMode=discoveryMode;pendingQuota.clear();pendingDiscovery=undefined;
 window.label=(key,params)=>translate(lang,key,params);
 const current=++generation;
 root.render(<I18nProvider key={current}><div className='flex h-screen min-h-0 flex-col bg-background text-foreground' data-fixture-generation={current}>
  <ActivityNavigation page='usage' onNavigate={page=>window.fixture.calls.push({kind:'navigate',page})} taskInboxEnabled />
  <UsagePage />
 </div></I18nProvider>);
 return current;
};
`;
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
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
const errors = [],
  blocked = [],
  cases = [],
  layouts = [];
let currentPage;
const label = (page, key, params) =>
  page.evaluate(({ key, params }) => window.label(key, params), { key, params });
const calls = (page, kind) =>
  page.evaluate((kind) => window.fixture.calls.filter((call) => call.kind === kind), kind);
const quotaSection = (page) =>
  page.locator('section[aria-labelledby="subscription-usage-heading"]');
const providerCard = (page, id) => page.locator(`article[data-usage-provider="${id}"]`);
const queryButton = (page, id) => providerCard(page, id).getByRole("button");
const historySection = (page) => page.locator('section[aria-labelledby="recorded-usage-heading"]');

async function mount(options = {}) {
  const page = await browser.newPage({
    viewport: options.viewport || { width: 1200, height: 1000 },
    serviceWorkers: "block",
    colorScheme: options.mode || "light",
  });
  currentPage = page;
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://usage-page-fixture.test/")
      return route.fulfill({
        contentType: "text/html",
        body: '<style>html,body,#root{height:100%;overflow:hidden}</style><div id="root"></div>',
      });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://usage-page-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const generation = await page.evaluate((options) => window.mountFixture(options), options);
  await page.locator(`[data-fixture-generation="${generation}"]`).waitFor();
  await page
    .getByRole("heading", { level: 1, name: await label(page, "usagePage.title"), exact: true })
    .waitFor();
  if (options.historyMode === "error" || options.historyMode === "repeated-cursor")
    await historySection(page).getByRole("alert").waitFor();
  else await page.getByRole("table").waitFor();
  if (options.discoveryMode !== "pending")
    await page
      .getByRole("button", { name: await label(page, "usagePage.rediscover"), exact: true })
      .waitFor();
  return page;
}
async function click(page, key) {
  await page.getByRole("button", { name: await label(page, key), exact: true }).click();
}
async function metric(page, key) {
  const caption = historySection(page)
    .locator(".grid > div")
    .getByText(await label(page, key), { exact: true });
  return caption.locator("..").locator("p").last().innerText();
}
async function assertNoOverflow(page) {
  const result = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      mainWidth: main.clientWidth,
      mainScrollWidth: main.scrollWidth,
      mainHeight: main.clientHeight,
      rootHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
  assert.ok(result.documentWidth <= result.width + 1, JSON.stringify(result));
  assert.ok(result.mainScrollWidth <= result.mainWidth + 1, JSON.stringify(result));
  assert.ok(result.rootHeight <= result.viewportHeight + 1, JSON.stringify(result));
  assert.ok(result.mainHeight > 100);
  return result;
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name + ".png") });
}

try {
  for (const viewport of [
    { width: 320, height: 540 },
    { width: 390, height: 844 },
    { width: 1200, height: 1000 },
  ])
    for (const lang of ["zh", "en"])
      for (const mode of ["light", "dark"]) {
        const page = await mount({ viewport, lang, mode });
        assert.equal(
          (await calls(page, "quota")).length,
          0,
          "Mount never queries subscription limits",
        );
        const initialReads = await calls(page, "usage");
        assert.equal(initialReads.length, 2);
        assert.equal(initialReads[0].query.until, initialReads[1].query.until);
        assert.equal(initialReads[0].query.until - initialReads[0].query.since, 30 * 86400000);
        assert.equal(initialReads[1].query.cursor, "a".repeat(64));
        for (const [key, value] of [
          ["total", "4,200"],
          ["input", "3,400"],
          ["output", "800"],
          ["cached", "1,600"],
          ["requests", "5"],
          ["turns", "3"],
        ])
          assert.equal(await metric(page, "usagePage." + key), value, key);
        assert.equal(
          await historySection(page)
            .getByText(await label(page, "usagePage.partial"), { exact: true })
            .count(),
          0,
          "A fully read paginated history is complete despite intermediate pagination flags",
        );
        await historySection(page)
          .getByText(await label(page, "usagePage.unknownUsage", { count: "2" }), { exact: true })
          .waitFor();
        await historySection(page)
          .getByText(await label(page, "usagePage.notSent", { count: "2" }), { exact: true })
          .waitFor();
        const cliRow = page
          .getByRole("row")
          .filter({ hasText: await label(page, "usagePage.cliAggregate") });
        assert.equal(await cliRow.count(), 1);
        assert.ok((await cliRow.innerText()).includes("3 " + (await label(page, "usagePage.cli"))));
        assert.ok(
          (
            await page.getByRole("row").filter({ hasText: "api-reference-model" }).innerText()
          ).includes("5 API"),
        );
        assert.equal(
          (await page.locator("body").innerText()).includes("$0"),
          false,
          "Unknown costs are never rendered as free usage",
        );
        const nav = page.getByRole("navigation");
        assert.equal(
          await nav
            .getByRole("button", { name: await label(page, "usagePage.title"), exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        await click(page, "usagePage.refresh");
        await page.waitForFunction(
          () => window.fixture.calls.filter((call) => call.kind === "usage").length === 4,
        );
        await page.getByRole("table").waitFor();
        assert.equal(
          (await calls(page, "quota")).length,
          0,
          "Refreshing tokens never probes quota",
        );
        const select = page.getByRole("combobox", { name: await label(page, "usagePage.range") });
        await select.selectOption("all");
        await page.waitForFunction(
          () => window.fixture.calls.filter((call) => call.kind === "usage").length === 6,
        );
        await page.getByRole("table").waitFor();
        const allReads = await calls(page, "usage");
        assert.equal("since" in allReads.at(-1).query, false);
        assert.equal((await calls(page, "quota")).length, 0, "Date changes never probe quota");
        assert.equal(
          (await calls(page, "discovery")).length,
          1,
          "History controls never rediscover providers",
        );
        assert.deepEqual(
          await quotaSection(page)
            .locator("article")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-usage-provider"))),
          ["cli:codex", "cli:claude", "cli:future", "model:fixture"],
        );
        await providerCard(page, "cli:codex")
          .getByText(await label(page, "usagePage.quotaFreeQuery"), { exact: true })
          .waitFor();
        await providerCard(page, "cli:claude")
          .getByText(await label(page, "usagePage.quotaProbeCost"), { exact: true })
          .waitFor();
        await providerCard(page, "model:fixture")
          .getByText(await label(page, "usagePage.providerConfigured", { count: "2" }), {
            exact: true,
          })
          .waitFor();
        await providerCard(page, "model:fixture")
          .getByText(await label(page, "usagePage.quotaUnsupported"), { exact: true })
          .waitFor();
        assert.equal(await queryButton(page, "model:fixture").count(), 0);
        const queried = [];
        for (const id of ["cli:codex", "cli:claude", "cli:future"]) {
          await queryButton(page, id).click();
          await providerCard(page, id).getByRole("progressbar").first().waitFor();
          queried.push(id);
          assert.deepEqual(
            (await calls(page, "quota")).map((call) => call.id),
            queried,
            "Only the clicked provider is queried",
          );
          assert.equal(
            (await calls(page, "discovery")).length,
            1,
            "Queries do not trigger discovery",
          );
        }
        assert.deepEqual(
          await quotaSection(page)
            .getByRole("progressbar")
            .evaluateAll((nodes) =>
              nodes.map((node) => Number(node.getAttribute("aria-valuenow"))),
            ),
          [35, 68, 12, 54, 30, 42],
        );
        if (lang === "en")
          assert.equal(
            /[\u3400-\u9fff]/u.test(await quotaSection(page).innerText()),
            false,
            "English subscription limits contain no untranslated labels",
          );
        await page.getByRole("main").evaluate((node) => {
          node.scrollTop = 0;
        });
        const dimensions = await assertNoOverflow(page);
        await screenshot(page, `${lang}-${mode}-${viewport.width}-limits`);
        await page.getByRole("table").scrollIntoViewIfNeeded();
        await screenshot(page, `${lang}-${mode}-${viewport.width}-tokens`);
        const tableScroller = page.getByRole("table").locator("..");
        const scroll = await tableScroller.evaluate((node) => {
          node.scrollLeft = node.scrollWidth;
          return { left: node.scrollLeft, scrollWidth: node.scrollWidth, width: node.clientWidth };
        });
        if (scroll.scrollWidth > scroll.width)
          assert.ok(scroll.left > 0, "Narrow tables scroll locally");
        assert.equal((await calls(page, "quota")).length, 3);
        layouts.push({ viewport, lang, mode, dimensions, table: scroll });
        await page.close();
      }
  cases.push(
    "12 responsive/light-dark/language layouts, paginated totals, API/CLI units, dynamic providers, independent queries and query-cost hints",
  );

  for (const quotaMode of [
    "error",
    "missing",
    "provider-empty",
    "provider-error",
    "provider-invalid",
    "auth-required",
  ]) {
    const page = await mount({ lang: "en", quotaMode, viewport: { width: 390, height: 844 } });
    const card = providerCard(page, "cli:codex");
    await queryButton(page, "cli:codex").click();
    if (["missing", "provider-empty", "provider-invalid"].includes(quotaMode))
      await card
        .getByText(await label(page, "usagePage.quotaUnavailable"), { exact: true })
        .waitFor();
    else if (quotaMode === "auth-required")
      await card
        .getByRole("alert")
        .getByText(await label(page, "usagePage.quotaAuthRequired"), { exact: true })
        .waitFor();
    else await card.locator(".text-status-err").first().waitFor();
    assert.equal(await quotaSection(page).getByRole("progressbar").count(), 0);
    assert.equal(
      (await card.innerText()).includes("0%"),
      false,
      "Failed/empty quota is unknown, never zero",
    );
    assert.equal(await queryButton(page, "cli:codex").isEnabled(), true);
    await screenshot(page, "quota-" + quotaMode);
    await page.evaluate(() => {
      window.fixture.quotaMode = "ready";
    });
    await queryButton(page, "cli:codex").click();
    await card.getByRole("progressbar").first().waitFor();
    assert.deepEqual(
      (await calls(page, "quota")).map((call) => call.id),
      ["cli:codex", "cli:codex"],
    );
    assert.equal((await calls(page, "discovery")).length, 1);
    await page.close();
  }
  cases.push(
    "Failed, missing, empty-window, non-finite and auth-required provider queries stay unknown and independently retryable",
  );

  const pending = await mount({ quotaModes: { "cli:codex": "pending" } });
  await queryButton(pending, "cli:codex").click();
  const loading = queryButton(pending, "cli:codex");
  assert.equal(await loading.isDisabled(), true);
  await loading.dispatchEvent("click");
  assert.equal(await queryButton(pending, "cli:claude").isEnabled(), true);
  await queryButton(pending, "cli:claude").click();
  await providerCard(pending, "cli:claude").getByRole("progressbar").first().waitFor();
  await click(pending, "usagePage.rediscover");
  await pending
    .getByRole("button", { name: await label(pending, "usagePage.rediscover"), exact: true })
    .waitFor();
  assert.equal(
    await loading.isDisabled(),
    true,
    "Rediscovery retains the same provider's in-flight query",
  );
  await click(pending, "usagePage.refresh");
  await pending.getByRole("table").waitFor();
  assert.deepEqual(
    (await calls(pending, "quota")).map((call) => call.id),
    ["cli:codex", "cli:claude"],
  );
  assert.equal((await calls(pending, "discovery")).length, 2);
  await screenshot(pending, "independent-query-pending");
  await pending.evaluate(() => window.fixture.finishQuota());
  await providerCard(pending, "cli:codex").getByRole("progressbar").first().waitFor();
  assert.equal(await loading.isEnabled(), true);
  await pending.close();
  cases.push(
    "An in-flight provider blocks duplicate clicks but not another provider; rediscovery and token refresh never repeat a probe",
  );

  for (const discoveryMode of ["empty", "error", "future-only"]) {
    const page = await mount({ discoveryMode, lang: "en", viewport: { width: 390, height: 844 } });
    if (discoveryMode === "empty") {
      await quotaSection(page)
        .getByText(await label(page, "usagePage.noProviders"), { exact: true })
        .waitFor();
      assert.equal(await quotaSection(page).locator("article").count(), 0);
    } else if (discoveryMode === "error") {
      await quotaSection(page)
        .getByRole("alert")
        .getByText(await label(page, "usagePage.discoveryFailed"), { exact: true })
        .waitFor();
      assert.equal(await quotaSection(page).locator("article").count(), 0);
    } else {
      assert.deepEqual(
        await quotaSection(page)
          .locator("article")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-usage-provider"))),
        ["cli:future", "model:fixture"],
      );
      assert.equal(
        /Codex|Claude/.test(await quotaSection(page).innerText()),
        false,
        "Absent providers never appear as fixed cards or hints",
      );
      await queryButton(page, "cli:future").click();
      await providerCard(page, "cli:future").getByRole("progressbar").waitFor();
      assert.deepEqual(
        (await calls(page, "quota")).map((call) => call.id),
        ["cli:future"],
      );
    }
    await assertNoOverflow(page);
    await screenshot(page, "discovery-" + discoveryMode);
    const oldQueries = await calls(page, "quota");
    await page.evaluate(() => {
      window.fixture.discoveryMode = "ready";
    });
    await click(page, "usagePage.rediscover");
    await providerCard(page, "cli:codex").waitFor();
    assert.equal(await quotaSection(page).locator("article").count(), 4);
    assert.deepEqual(
      await calls(page, "quota"),
      oldQueries,
      "Rediscovery never queries a provider",
    );
    assert.equal((await calls(page, "discovery")).length, 2);
    await page.close();
  }
  cases.push(
    "Empty/failed discovery is retryable; only discovered providers render, including a future adapter and unsupported model connection",
  );

  const rediscovery = await mount({ lang: "en" });
  await queryButton(rediscovery, "cli:future").click();
  await providerCard(rediscovery, "cli:future").getByRole("progressbar").waitFor();
  await rediscovery.evaluate(() => {
    window.fixture.discoveryMode = "error";
  });
  await click(rediscovery, "usagePage.rediscover");
  await quotaSection(rediscovery).getByRole("alert").waitFor();
  assert.equal(await quotaSection(rediscovery).locator("article").count(), 4);
  assert.equal(
    await providerCard(rediscovery, "cli:future")
      .getByRole("progressbar")
      .getAttribute("aria-valuenow"),
    "42",
  );
  await screenshot(rediscovery, "rediscovery-failed-retains-cards");
  await rediscovery.evaluate(() => {
    window.fixture.discoveryMode = "pending";
  });
  await click(rediscovery, "usagePage.rediscover");
  const detecting = quotaSection(rediscovery).getByRole("button", {
    name: await label(rediscovery, "usagePage.discovering"),
    exact: true,
  });
  assert.equal(await detecting.isDisabled(), true);
  assert.equal(await queryButton(rediscovery, "cli:codex").isEnabled(), true);
  await queryButton(rediscovery, "cli:codex").click();
  await providerCard(rediscovery, "cli:codex").getByRole("progressbar").first().waitFor();
  await rediscovery.evaluate(() => window.fixture.finishDiscovery());
  await rediscovery
    .getByRole("button", { name: await label(rediscovery, "usagePage.rediscover"), exact: true })
    .waitFor();
  assert.deepEqual(
    (await calls(rediscovery, "quota")).map((call) => call.id),
    ["cli:future", "cli:codex"],
  );
  assert.equal((await calls(rediscovery, "discovery")).length, 3);
  await rediscovery.close();
  cases.push(
    "A failed rediscovery retains existing cards and quota; discovery loading remains independent from provider queries",
  );

  for (const historyMode of ["error", "repeated-cursor"]) {
    const page = await mount({ historyMode, lang: "en" });
    assert.equal(await page.getByRole("table").count(), 0);
    assert.equal(
      await historySection(page)
        .getByText(await label(page, "usagePage.total"), { exact: true })
        .count(),
      0,
    );
    assert.equal((await calls(page, "quota")).length, 0);
    await screenshot(page, "history-" + historyMode);
    await page.evaluate(() => {
      window.fixture.historyMode = "ready";
    });
    await click(page, "usagePage.refresh");
    await page.getByRole("table").waitFor();
    assert.equal(await metric(page, "usagePage.total"), "4,200");
    await page.close();
  }
  cases.push(
    "Failed/repeated-cursor history shows an error without fabricated zero totals and can retry",
  );

  const empty = await mount({ historyMode: "empty", lang: "en" });
  await historySection(empty)
    .getByText(await label(empty, "usagePage.noRecords"), { exact: true })
    .waitFor();
  assert.equal(await metric(empty, "usagePage.total"), "0");
  assert.equal(await historySection(empty).getByRole("alert").count(), 0);
  await empty.close();
  cases.push("A successful empty history is distinct from a read error");

  const unknown = await mount({ historyMode: "all-unknown", lang: "en" });
  for (const key of ["total", "input", "output", "cached"])
    assert.equal(
      await metric(unknown, "usagePage." + key),
      "—",
      "Missing provider token usage is unknown, never zero",
    );
  assert.equal(await metric(unknown, "usagePage.requests"), "0");
  assert.equal(await metric(unknown, "usagePage.turns"), "2");
  await historySection(unknown)
    .getByText(await label(unknown, "usagePage.unknownUsage", { count: "2" }), { exact: true })
    .waitFor();
  const unknownRow = unknown
    .getByRole("row")
    .filter({ hasText: await label(unknown, "usagePage.cliAggregate") });
  assert.deepEqual((await unknownRow.getByRole("cell").allTextContents()).slice(-3), [
    "—",
    "—",
    "—",
  ]);
  await screenshot(unknown, "history-all-unknown");
  await unknown.close();
  cases.push(
    "All-unknown CLI tokens stay unknown while the known submission count remains visible",
  );

  const notSent = await mount({ historyMode: "unknown-and-not-sent", lang: "en" });
  for (const key of ["total", "input", "output", "cached"])
    assert.equal(
      await metric(notSent, "usagePage." + key),
      "—",
      "A known-zero request that was not sent cannot make the actual unknown request look free",
    );
  assert.equal(await metric(notSent, "usagePage.requests"), "1");
  assert.equal(await metric(notSent, "usagePage.turns"), "0");
  const notSentRow = notSent.getByRole("row").filter({ hasText: "api-reference-model" });
  assert.deepEqual((await notSentRow.getByRole("cell").allTextContents()).slice(-3), [
    "—",
    "—",
    "—",
  ]);
  assert.ok((await notSentRow.innerText()).includes("1 API"));
  await historySection(notSent)
    .getByText(await label(notSent, "usagePage.unknownUsage", { count: "1" }), { exact: true })
    .waitFor();
  await historySection(notSent)
    .getByText(await label(notSent, "usagePage.notSent", { count: "1" }), { exact: true })
    .waitFor();
  await screenshot(notSent, "history-unknown-and-not-sent");
  await notSent.close();
  cases.push("Unknown actual usage stays unknown when another request ended before transmission");

  const partial = await mount({ historyMode: "early-invalid", lang: "en" });
  assert.equal((await calls(partial, "usage")).length, 2);
  assert.equal(await metric(partial, "usagePage.total"), "4,200");
  await historySection(partial)
    .getByText(await label(partial, "usagePage.partial"), { exact: true })
    .waitFor();
  await screenshot(partial, "history-early-invalid");
  await partial.close();
  cases.push("An invalid receipt on an earlier page remains partial after a clean final page");

  const long = await mount({ historyMode: "long-model", viewport: { width: 320, height: 540 } });
  await long.getByRole("table").scrollIntoViewIfNeeded();
  await assertNoOverflow(long);
  await screenshot(long, "narrow-long-model");
  await long.close();
  cases.push("Long model identifiers remain inside the local table scroller");

  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ cases, layouts, errors, blocked }, null, 2),
  );
  console.log(
    JSON.stringify({ result: "pass", layouts: layouts.length, cases, errors, blocked, output }),
  );
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await screenshot(currentPage, "failure");
    await writeFile(
      path.join(output, "failure.txt"),
      await currentPage.locator("body").innerText(),
    );
  }
  throw error;
} finally {
  await browser.close();
}
