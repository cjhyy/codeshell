/* Production surfaces compiled in memory; every bridge method is fixture-owned. */
/* global document, window */
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
const output = process.env.CODESHELL_SURFACES_QA_DIR || "/tmp/codeshell-page-surfaces-qa";
const recordOnly = process.argv.includes("--record-only");
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {QuotaPanel} from './cc-room/QuotaPanel';
  import {MarketList} from './extensions/MarketList';
  import {MarketDetail} from './extensions/MarketDetail';
  import {DialogProvider} from './ui/DialogProvider';
  import {ToastProvider,useToast} from './ui/ToastProvider';
  import {NotificationHistory} from './ui/NotificationHistory';
  const makeJobs=count=>Array.from({length:count},(_,i)=>({id:String(i),status:'failed',pluginName:'very-long-plugin-name-'+i,marketplaceName:'marketplace-name',error:'Installation failed: network unavailable. Retry this installation.',createdAt:Date.now()}));
  let jobListener=()=>{};
  window.publishJobs=count=>jobListener(makeJobs(count));
  window.codeshell={
    quota:{get:()=>new Promise(resolve=>{window.resolveQuota=resolve})},
    checkGit:async()=>({available:true}),
    listPluginInstallJobs:async()=>makeJobs(1),
    onPluginInstallJobsChanged:callback=>{jobListener=callback;return ()=>{jobListener=()=>{}}},
    listRecommendedMarketplaces:async()=>({source:'builtin',items:[]}),
    listMarketplaces:async()=>[],
    loadMarketplace:async()=>({name:'marketplace-name',plugins:[]}),
    listPlugins:async()=>[],
    retryPluginInstallJob:async id=>{window.retried=id;return {ok:true}},
    log:()=>{},
  };
  function Notifications({count}) {
    const toast=useToast();
    return <><button id='notify' onClick={()=>{for(let i=0;i<count;i++)toast({message:'Error '+i+'\\n'+'A recoverable installation error occurred while fetching dependencies. Please check your connection and retry.\\n'.repeat(12),variant:'error',durationMs:0})}}>Notify</button><NotificationHistory/></>;
  }
  function Fixture({kind,count=4}) {
    return <DialogProvider><div className='flex h-full flex-col overflow-hidden bg-background'>
      <header className='h-11 shrink-0 border-b'>App header</header>
      <div id='page-scroll' className='flex min-h-0 flex-1 flex-col overflow-y-auto p-4'>
        {kind==='quota'&&<><div className='h-8 shrink-0'>Room switcher</div><div className='flex items-center justify-between gap-2'><h2 className='min-w-0 truncate'>Codex 会话 / long project path</h2><div className='flex shrink-0 items-center gap-2'><QuotaPanel which='codex'/><button className='h-8 w-8'>↻</button><button className='h-8'>新开 session</button></div></div><p>Session list</p></>}
        {(kind==='jobs'||kind==='jobs-detail')&&<><div className='h-36 shrink-0'>Extension module heading and navigation</div>{kind==='jobs'?<MarketList configurationTarget={{noRepo:true}} onInstalled={()=>{}}/>:<MarketDetail configurationTarget={{noRepo:true}} marketName='marketplace-name' onBack={()=>{window.wentBack=true}} onInstalled={()=>{}}/>}</>}
        {kind==='toast'&&<ToastProvider><Notifications count={count}/></ToastProvider>}
      </div>
    </div></DialogProvider>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=props=>root.render(<Fixture key={props.kind+':'+props.count} {...props}/>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
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
const failures = [];
const reports = [];
const check = (condition, message, context) => {
  if (!condition) failures.push({ message, ...context });
};
const geometry = (locator) =>
  locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      rect: rect.toJSON(),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      hit: hit === element || element.contains(hit),
    };
  });
async function inspect(page, locator, context, requireHit = false) {
  const box = await geometry(locator);
  const viewport = page.viewportSize();
  reports.push({ ...context, viewport, box });
  check(
    box.rect.left >= 8 &&
      box.rect.top >= 8 &&
      box.rect.right <= viewport.width - 8 &&
      box.rect.bottom <= viewport.height - 8,
    "Surface remains within viewport",
    { ...context, viewport, box },
  );
  check(box.scrollWidth <= box.clientWidth + 1, "Content has no horizontal clipping", {
    ...context,
    viewport,
    box,
  });
  if (requireHit) check(box.hit, "Action receives pointer hits", { ...context, viewport, box });
  return box;
}
async function mount(viewport, props) {
  const page = await browser.newPage({ viewport, serviceWorkers: "block" });
  page.on("pageerror", (error) => failures.push({ ...props, message: error.message }));
  // Supply a local origin for storage; deny every other network request.
  await page.route("**/*", (route) =>
    route.request().url() === "http://codeshell-fixture.test/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://codeshell-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((props) => window.renderFixture(props), props);
  return page;
}
try {
  for (const viewport of [
    { width: 390, height: 600 },
    { width: 640, height: 480 },
    { width: 1024, height: 600 },
  ]) {
    const quota = await mount(viewport, { kind: "quota" });
    await quota.getByRole("button", { name: "额度", exact: true }).click();
    await quota.waitForFunction(() => typeof window.resolveQuota === "function");
    await quota.evaluate(() =>
      window.resolveQuota({
        codex: {
          planType: "Pro",
          windows: [
            { kind: "5h", usedPercent: 35, resetsAt: null },
            { kind: "7d", usedPercent: 45, resetsAt: null },
          ],
        },
      }),
    );
    const quotaSurface = quota.getByRole("dialog", { name: "剩余额度" });
    await quota.getByText("Pro", { exact: true }).waitFor();
    await inspect(quota, quotaSurface, { kind: "quota", phase: "loaded" });
    await quota.getByRole("button", { name: "刷新", exact: true }).click();
    await quota.evaluate(() =>
      window.resolveQuota({ codex: { error: "Provider quota request failed: ".repeat(90) } }),
    );
    await quota.getByText(/查询失败/).waitFor();
    await inspect(quota, quotaSurface, { kind: "quota", phase: "late-error" });
    const footer = quotaSurface.locator("p").last();
    await footer.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    await inspect(quota, footer, { kind: "quota", phase: "footer" }, true);
    await quota.setViewportSize({ width: 390, height: 480 });
    await quota.waitForTimeout(80);
    await inspect(quota, quotaSurface, { kind: "quota", phase: "resize" });
    await quota.screenshot({ path: path.join(output, `quota-${viewport.width}.png`) });
    await quota.keyboard.press("Escape");
    await quotaSurface.waitFor({ state: "hidden" });
    await quota.close();

    for (const kind of ["jobs", "jobs-detail"]) {
      const page = await mount(viewport, { kind });
      const trigger = page.getByRole("button", { name: "查看安装列表", exact: true });
      await trigger.waitFor();
      await inspect(page, trigger, { kind, phase: "trigger" }, true);
      if (kind === "jobs") {
        const input = page.getByPlaceholder("owner/repo 或 git URL");
        const inputBox = await geometry(input);
        check(inputBox.rect.width >= 100, "Marketplace input retains usable width", {
          kind,
          viewport,
          box: inputBox,
        });
        await input.focus();
      }
      await trigger.hover();
      const surface = page.getByRole("dialog", { name: "安装列表", exact: true });
      await surface.waitFor();
      await inspect(page, surface, { kind, phase: "hover" });
      if (kind === "jobs")
        check(
          await page
            .getByPlaceholder("owner/repo 或 git URL")
            .evaluate((element) => document.activeElement === element),
          "Hover keeps the current input focus",
          { kind, viewport },
        );
      await surface.hover();
      if (kind === "jobs") {
        await page.mouse.move(0, 0);
        await surface.waitFor({ state: "hidden" });
        await trigger.hover();
        await surface.waitFor();
      }
      await trigger.click();
      await page.evaluate(() => window.publishJobs(18));
      await surface.getByRole("button", { name: "重试", exact: true }).nth(17).waitFor();
      await inspect(page, surface, { kind, phase: "late-jobs" });
      await page.setViewportSize({ width: 390, height: 480 });
      await page.waitForTimeout(80);
      await inspect(page, surface, { kind, phase: "resize" });
      await page.screenshot({ path: path.join(output, `${kind}-${viewport.width}.png`) });
      const retry = surface.getByRole("button", { name: "重试", exact: true }).last();
      await retry.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
      await inspect(page, retry, { kind, phase: "retry" }, true);
      await retry.click();
      check((await page.evaluate(() => window.retried)) === "17", "Last job can be retried", {
        kind,
        viewport,
      });
      await page.keyboard.press("Escape");
      await surface.waitFor({ state: "hidden" });
      await page.waitForTimeout(80);
      check(
        await trigger.evaluate((element) => document.activeElement === element),
        "Keyboard dismissal returns focus to trigger",
        { kind, viewport },
      );
      await page.mouse.move(0, 0);
      await trigger.press("Enter");
      await surface.waitFor();
      await page.waitForTimeout(80);
      const firstRetry = surface.getByRole("button", { name: "重试", exact: true }).first();
      check(
        await firstRetry.evaluate((element) => document.activeElement === element),
        "Keyboard opening focuses the first retry action",
        { kind, viewport },
      );
      await page.keyboard.press("Tab");
      check(
        await surface
          .getByRole("button", { name: "重试", exact: true })
          .nth(1)
          .evaluate((element) => document.activeElement === element),
        "Tab traverses retry actions",
        { kind, viewport },
      );
      await page.keyboard.press("Escape");
      await surface.waitFor({ state: "hidden" });
      await trigger.hover();
      await trigger.click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(180);
      check(await surface.isVisible(), "Click pins a hovered job list", { kind, viewport });
      await page.locator("header").click({ position: { x: 4, y: 4 } });
      await surface.waitFor({ state: "hidden" });
      await trigger.hover();
      await trigger.click();
      await page.evaluate(() => window.publishJobs(0));
      await trigger.waitFor({ state: "hidden" });
      await page.mouse.move(0, 0);
      await page.evaluate(() => window.publishJobs(1));
      await trigger.waitFor();
      check(!(await surface.isVisible()), "A later install starts with the list closed", {
        kind,
        viewport,
      });
      await page.close();
    }

    for (const count of [1, 4]) {
      const page = await mount(viewport, { kind: "toast", count });
      await page.locator("#notify").click();
      const stack = page.locator('[role="status"][aria-live="polite"]');
      await stack.locator("button").last().waitFor();
      await page.waitForTimeout(200);
      await inspect(page, stack, { kind: "toast", count, phase: "stack" });
      for (const button of await stack.locator("button").all())
        await inspect(page, button, { kind: "toast", count, phase: "dismiss" }, true);
      const message = stack.locator("span.select-text").first();
      const messageBox = await geometry(message);
      check(
        messageBox.scrollHeight > messageBox.clientHeight,
        "Long message remains independently scrollable",
        { kind: "toast", count, viewport },
      );
      if (count === 1)
        check(messageBox.clientHeight === 192, "One toast retains its original 12rem message cap", {
          viewport,
          box: messageBox,
        });
      await page.setViewportSize({ width: 390, height: 480 });
      await page.waitForTimeout(80);
      await inspect(page, stack, { kind: "toast", count, phase: "resize" });
      for (const button of await stack.locator("button").all())
        await inspect(page, button, { kind: "toast", count, phase: "resized-dismiss" }, true);
      await page.screenshot({ path: path.join(output, `toast-${viewport.width}-${count}.png`) });
      await stack.locator("button").first().click();
      check(
        (await stack.locator("button").count()) === count - 1,
        "Oldest toast can be dismissed",
        { viewport, count },
      );
      await page.close();
    }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify({ reports, failures }, null, 2));
  if (!recordOnly) assert.deepEqual(failures, [], "Page surface geometry regressions");
  console.log(
    JSON.stringify({
      scenarios: 15,
      observations: reports.length,
      failures: failures.length,
      output,
    }),
  );
} finally {
  await browser.close();
}
