/* Production notification history with bounded summaries and full diagnostics. */
/* global window */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const source = String.raw`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {NotificationHistory} from './ui/NotificationHistory';
  import {ToastProvider} from './ui/ToastProvider';
  import {TOAST_HISTORY_STORAGE_KEY} from './ui/toastHistoryStorage';
  import {OPEN_NOTIFICATION_SESSION_EVENT} from './app/notificationSessionNavigation';
  import {I18nProvider} from './i18n';
  import {saveUILanguage} from './uiLanguage';
  const longMessage=('浏览器任务执行失败：目标页面等待超时，请检查页面地址和网络连接。'+
    ' 调试信息保留在通知详情中。'.repeat(150)).slice(0,2000);
  const smallDetail=('Command: node scripts/capture-site.mjs --url=https://example.test/'+
    'path_without_breaks_'.repeat(160)).slice(0,2000);
  const largeDetail=('Command: node scripts/capture-site.mjs --url=https://example.test/'+
    'long_argument_without_spaces_'.repeat(380)+'\n'+
    'Error: navigation timed out at BrowserTask.run (browser-task.ts:120)\n'.repeat(30)).slice(0,10000);
  const records=[
    {id:'info-start',variant:'default',message:'浏览器任务已开始，正在准备页面。'},
    {id:'success-sync',variant:'success',message:'工作区已同步，可以继续当前会话。'},
    {id:'error-small',variant:'error',message:'截图命令执行失败：无法读取目标页面。',detail:smallDetail},
    {id:'success-export',variant:'success',message:'报告已导出到项目文件夹。'},
    {id:'info-settings',variant:'default',message:'模型配置已更新，后续消息将使用新的设置。'},
    {id:'error-large',variant:'error',message:longMessage,detail:largeDetail,sessionId:'fixture-session'},
  ].map((record,index)=>({...record,durationMs:0,createdAt:1792026000000+index*60000,read:false}));
  window.fixture={records,copied:[],sessions:[]};
  window.codeshell={log:()=>{}};
  Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{
    writeText:async(text)=>{window.fixture.copied.push(text)},
  }});
  window.addEventListener(OPEN_NOTIFICATION_SESSION_EVENT,event=>{
    window.fixture.sessions.push(event.detail);
  });
  window.sessionStorage.setItem(TOAST_HISTORY_STORAGE_KEY,JSON.stringify(records));
  window.setFixtureLanguage=saveUILanguage;
  saveUILanguage('en');
  createRoot(document.getElementById('root')).render(
    <React.StrictMode><I18nProvider><ToastProvider>
      <main className="fixed inset-0 bg-background p-4 text-foreground">
        <div className="flex justify-end"><NotificationHistory/></div>
      </main>
    </ToastProvider></I18nProvider></React.StrictMode>
  );
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
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
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://notifications.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://notifications.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const opener = page.locator('[data-notification-action="open"]');
  const dialog = page.getByRole("dialog");
  const entries = page.locator("li[data-notification-id]");
  const detail = page.locator("[data-notification-detail]");
  const detailScroll = detail.locator("pre");
  const large = page.locator('[data-notification-id="error-large"]');
  const small = page.locator('[data-notification-id="error-small"]');
  const toggle = (entry) => entry.locator('[data-notification-action="toggle-details"]');
  const screenshots = await mkdtemp(path.join(tmpdir(), "codeshell-notification-ui-"));
  async function screenshot(name) {
    await page.evaluate(() => window.setFixtureLanguage("zh"));
    await page.getByRole("heading", { name: "通知记录", exact: true }).waitFor();
    const output = path.join(screenshots, name);
    await dialog.screenshot({ path: output });
    await page.evaluate(() => window.setFixtureLanguage("en"));
    await page.getByRole("heading", { name: "Notification history", exact: true }).waitFor();
    return output;
  }
  async function fits() {
    await page.waitForFunction(
      (element) => {
        const box = element.getBoundingClientRect();
        return (
          box.left >= 8 &&
          box.top >= 8 &&
          box.right <= window.innerWidth - 8 &&
          box.bottom <= window.innerHeight - 8
        );
      },
      await dialog.elementHandle(),
    );
    assert.equal(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      "notification panel has no horizontal overflow",
    );
  }

  await opener.click();
  await dialog.waitFor();
  assert.equal(await entries.count(), 6, "production ToastProvider loads the owned history seed");
  assert.equal(await detail.count(), 0, "collapsed entries do not mount diagnostic detail");
  for (const entry of [large, small]) {
    assert.equal(await toggle(entry).getAttribute("aria-expanded"), "false");
    assert.ok(
      (await entry.boundingBox()).height <= 100,
      "long diagnostics keep default rows compact",
    );
    assert.equal(
      await entry.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      "long command content does not widen its collapsed row",
    );
  }
  await fits();
  const defaultScreenshot = await screenshot("notification-default.png");

  await toggle(large).click();
  assert.equal(await toggle(large).getAttribute("aria-expanded"), "true");
  assert.equal(await detail.count(), 1, "one entry expands its diagnostic area");
  const original = await page.evaluate(() =>
    window.fixture.records.find((entry) => entry.id === "error-large"),
  );
  assert.ok(
    (await detail.textContent()).includes(original.message),
    "expanded message remains complete",
  );
  assert.ok(
    (await detail.textContent()).includes(original.detail),
    "expanded 10k detail remains complete",
  );
  await large.getByRole("button", { name: "Copy notification details", exact: true }).click();
  await page.waitForFunction(() => window.fixture.copied.length === 1);
  const copied = await page.evaluate(() => window.fixture.copied[0]);
  assert.ok(copied.includes(original.message), "copy preserves the full message");
  assert.ok(copied.includes(original.detail), "copy preserves the full diagnostic command");

  await toggle(small).click();
  assert.equal(await toggle(large).getAttribute("aria-expanded"), "false");
  assert.equal(await detail.count(), 1, "expanding another entry closes the first");
  await toggle(small).click();
  assert.equal(await detail.count(), 0, "collapsing removes the diagnostic area");

  await page.getByRole("button", { name: /^Errors only\b/ }).click();
  assert.deepEqual(
    await entries.evaluateAll((elements) =>
      elements.map((element) => element.dataset.notificationId),
    ),
    ["error-large", "error-small"],
    "failure filter keeps only errors in newest-first order",
  );
  await toggle(large).click();
  await large.locator('[data-notification-action="open-session"]').click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    await page.evaluate(() => window.fixture.sessions),
    [{ sessionId: "fixture-session" }],
    "open conversation dispatches the original session identity",
  );
  await opener.click();
  await page.getByRole("button", { name: /^All\b/ }).click();
  assert.equal(await entries.count(), 6, "all filter restores the history");
  if ((await toggle(large).getAttribute("aria-expanded")) !== "true") await toggle(large).click();

  await page.setViewportSize({ width: 390, height: 480 });
  await fits();
  assert.equal(
    await detailScroll.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    "long unbroken command wraps inside narrow diagnostic detail",
  );
  assert.equal(
    await detailScroll.evaluate((element) => element.scrollHeight > element.clientHeight),
    true,
    "expanded diagnostics have their own vertical scroll area",
  );
  await detailScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  assert.ok(
    await detailScroll.evaluate((element) => element.scrollTop > 0),
    "detail scroll reaches later output",
  );
  await detailScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(() => window.document.documentElement.classList.add("dark"));
  const darkScreenshot = await screenshot("notification-expanded-dark-narrow.png");
  await fits();

  await page.getByRole("button", { name: "Clear history", exact: true }).click();
  assert.equal(await entries.count(), 0, "clear removes history entries");
  assert.equal(await detail.count(), 0, "clear also removes expanded diagnostics");
  await page.waitForFunction(
    () =>
      JSON.parse(window.sessionStorage.getItem("codeshell.notificationHistory.v1")).length === 0,
  );
  assert.deepEqual(errors, [], "production notification history has no browser page errors");
  console.log(
    "NotificationHistory browser smoke passed: compact 2k/10k diagnostics, exclusive expansion, " +
      "full copy, failure filter, session navigation, clear, dark 390x480 bounds; no page errors.",
  );
  console.log(`Default UI: ${defaultScreenshot}\nExpanded dark UI: ${darkScreenshot}`);
} finally {
  await browser.close();
}
