/** Production React/Workbench/HubFiles and CSS in Chromium, with an owned HTTP
 * fixture API. Every other browser origin and unexpected API path is blocked.
 * Run: bun run --cwd packages/web test:files-browser
 */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(web, "../desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = process.env.CODESHELL_WEB_FILES_EVIDENCE_DIR
  ? path.resolve(process.env.CODESHELL_WEB_FILES_EVIDENCE_DIR)
  : await mkdtemp(path.join(tmpdir(), "codeshell-web-files-"));
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {Workbench} from './Workbench';
  const noop=()=>{};
  const controller={host:'desktop',workspaceApi:true,connection:'open',activeId:'fixture',
    chat:{items:[{kind:'assistant',id:'linked-file',done:true,text:'[Open linked file](/fixture/reports/report.md)'}],run:'idle'},
    sessions:[],workspaceCwd:'/fixture',workspaceName:'File browser',
    workspaceKey:'fixture',title:'Fixture conversation',configuration:null,configurationVersion:0,
    sessionsVersion:0,draft:'',files:[],uploading:false,uploadBusy:false,hasUnsent:false,
    uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,
    approvalContent:null,error:'',clearError:noop,setDraft:noop,removeFile:noop,
    selectSession:noop,newSession:noop,send:()=>false,stop:noop,addFiles:noop,
    refreshSessions:noop,refreshConfiguration:noop,onAuthLost:()=>{window.authLost=true}};
  createRoot(document.getElementById('root')).render(<Workbench controller={controller}/>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(web, "app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: path.join(output, "bundle"),
  platform: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const file = (name, parent = "") => ({
  name,
  path: parent ? `${parent}/${name}` : name,
  kind: "file",
  size: 1024,
  modifiedAt: 0,
});
const folder = (name, parent = "") => ({ ...file(name, parent), kind: "directory" });
const directories = {
  "": [folder("reports"), folder("archive"), folder("lots"), file("old-root.txt")],
  reports: [folder("nested", "reports"), file("report.md", "reports")],
  "reports/nested": [file("late-report.md", "reports/nested")],
  archive: [file("pending.txt", "archive"), file("retry.md", "archive")],
  lots: Array.from({ length: 35 }, (_, index) => file(`report-${index}.md`, "lots")),
};
const content =
  "# Preview body is immediately visible\n\n" +
  "LongFileLine".repeat(100) +
  "\n" +
  "Scrollable content\n".repeat(100);
const requests = [];
const unexpected = [];
const blocked = [];
const errors = [];
const held = new Map();
let rejectReports = true;
let rejectPreview = true;
let holdNested = false;
let holdPreview = false;
const json = (response, body, status = 200) => {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
};
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  requests.push(url.pathname + url.search);
  if (request.method !== "GET") {
    unexpected.push(`${request.method} ${request.url}`);
    return json(response, { error: "Unexpected method" }, 405);
  }
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
    );
  }
  if (url.pathname === "/fixture.js" || url.pathname === "/fixture.css") {
    response.writeHead(200, {
      "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css",
    });
    return response.end(url.pathname.endsWith(".js") ? js : css);
  }
  if (url.pathname === "/api/v1/environment") return json(response, {}, 404);
  const target = (url.searchParams.get("path") ?? "").replace(/^\/fixture\//, "");
  if (url.pathname === "/api/v1/files" && Object.hasOwn(directories, target)) {
    if (target === "reports" && rejectReports) {
      rejectReports = false;
      return json(response, { error: "Directory read denied" }, 403);
    }
    const reply = () =>
      json(response, { path: target, files: directories[target], truncated: false });
    if (target === "reports/nested" && holdNested) held.set("directory", reply);
    else reply();
    return;
  }
  if (url.pathname === "/api/v1/files/content" && url.searchParams.get("preview") === "true") {
    if (target === "archive/retry.md" && rejectPreview) {
      rejectPreview = false;
      return json(response, { error: "Preview read unavailable" }, 503);
    }
    const reply = () =>
      json(response, {
        path: target,
        name: target.split("/").at(-1),
        kind: "text",
        size: 1024,
        content,
      });
    if (target === "archive/pending.txt" && holdPreview) held.set("preview", reply);
    else reply();
    return;
  }
  unexpected.push(request.url);
  json(response, { error: "Unexpected fixture route" }, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium
  .launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin" && existsSync(macChrome) ? macChrome : undefined),
  })
  .catch(async (cause) => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw cause;
  });
const reports = [];
const context = await browser.newContext({
  viewport: { width: 390, height: 540 },
  serviceWorkers: "block",
});
await context.route("**/*", (route) => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  blocked.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
page.on("pageerror", (error) => errors.push(String(error)));
const entry = (name) =>
  page.locator(".file-entry").filter({
    has: page.locator(".file-entry-name", {
      hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    }),
  });
const directory = () => page.getByRole("region", { name: /^文件夹：/ });
const preview = () => page.getByRole("article", { name: /^文件预览：/ });
const rootCrumb = () =>
  page
    .getByRole("navigation", { name: "文件位置" })
    .getByRole("button", { name: "工作区", exact: true });
const close = () => preview().getByRole("button", { name: /返回文件列表|关闭预览/ });
const waitForHeld = async (key) => {
  const deadline = Date.now() + 5000;
  while (!held.has(key) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(held.has(key), `Expected held ${key} request`);
};

try {
  await page.goto(`${origin}/?view=files`);
  await entry("old-root.txt").waitFor();
  await entry("reports").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Directory read denied" }).waitFor();
  assert.equal(
    await entry("old-root.txt").count(),
    0,
    "A failed destination never displays the preceding directory",
  );
  assert.equal(await directory().getAttribute("aria-label"), "文件夹：reports");
  assert.equal(await page.locator('[aria-current="location"]').textContent(), "reports");
  await page.getByRole("button", { name: "重新读取文件夹" }).focus();
  await page.keyboard.press("Enter");
  await entry("report.md").waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(
    await directory().evaluate((node) => node === document.activeElement),
    true,
    "Retry hands focus to its directory",
  );
  assert.equal(requests.filter((url) => url === "/api/v1/files?path=reports").length, 2);

  holdNested = true;
  await entry("nested").click();
  await waitForHeld("directory");
  await rootCrumb().click();
  await entry("archive").click();
  await entry("pending.txt").waitFor();
  held.get("directory")();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await directory().getAttribute("aria-label"), "文件夹：archive");
  assert.equal(
    await entry("late-report.md").count(),
    0,
    "A late old-directory response cannot replace the latest target",
  );

  holdPreview = true;
  await entry("pending.txt").click();
  await waitForHeld("preview");
  await preview().getByRole("status").waitFor();
  await close().click();
  assert.equal(
    await entry("pending.txt").evaluate((node) => node === document.activeElement),
    true,
  );
  held.get("preview")();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await preview().count(), 0, "Closing a pending preview ignores its late reply");

  await entry("retry.md").click();
  await preview().getByRole("alert").filter({ hasText: "Preview read unavailable" }).waitFor();
  assert.equal(await preview().getAttribute("aria-label"), "文件预览：archive/retry.md");
  await page.getByRole("button", { name: "重新读取文件" }).focus();
  await page.keyboard.press("Enter");
  await preview().locator("pre").waitFor();
  assert.equal(await preview().evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  await preview().waitFor({ state: "hidden" });
  assert.equal(await preview().count(), 0);
  assert.equal(await entry("retry.md").evaluate((node) => node === document.activeElement), true);

  for (const width of [320, 390, 760, 1280]) {
    await page.setViewportSize({ width, height: width < 760 ? 540 : 820 });
    await rootCrumb().click();
    await entry("lots").click();
    const selected = entry("report-34.md");
    await selected.waitFor();
    await selected.scrollIntoViewIfNeeded();
    const scrollBefore = await page.locator(".hub-files").evaluate((node) => node.scrollTop);
    await selected.focus();
    await page.keyboard.press("Enter");
    const body = preview().locator("pre");
    await body.waitFor();
    const metrics = await body.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        right: rect.right,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    assert.ok(
      metrics.top < metrics.viewportHeight - 60 && metrics.bottom > 0,
      `Preview text is immediately visible at ${width}px`,
    );
    assert.ok(
      metrics.right <= width + 1 && metrics.pageOverflow <= 1,
      `No page overflow at ${width}px`,
    );
    assert.equal(
      await directory().isVisible(),
      width > 1000,
      `Mobile shows preview; desktop retains two columns at ${width}px`,
    );
    assert.equal(await close().isVisible(), true);
    assert.equal(
      await preview()
        .getByRole("button", {
          name: width > 1000 ? "关闭预览" : "返回文件列表",
          exact: true,
        })
        .count(),
      1,
    );
    assert.equal(await body.evaluate((node) => node.scrollTop), 0);
    await page.screenshot({ path: path.join(output, `preview-${width}.png`) });
    await page.keyboard.press("Tab");
    assert.equal(
      await preview()
        .getByRole("link", { name: "下载" })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(await close().evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await body.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.querySelector(".file-preview pre").scrollTop > 0);
    await page.keyboard.press("Escape");
    await preview().waitFor({ state: "hidden" });
    assert.equal(
      await selected.evaluate((node) => node === document.activeElement),
      true,
      "Closing returns keyboard focus to the file",
    );
    assert.ok(
      Math.abs(
        (await page.locator(".hub-files").evaluate((node) => node.scrollTop)) - scrollBefore,
      ) <= 1,
      "Closing restores list scroll position",
    );
    reports.push({ width, metrics, scrollBefore });
  }
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "Open linked file", exact: true }).click();
  await preview().locator("pre").waitFor();
  await entry("report.md").waitFor();
  assert.equal(await preview().getAttribute("aria-label"), "文件预览：reports/report.md");
  assert.equal(await directory().getAttribute("aria-label"), "文件夹：reports");
  assert.equal(await page.locator('[aria-current="location"]').textContent(), "reports");
  assert.equal(await entry("report.md").getAttribute("aria-current"), "true");
  assert.ok(requests.some((url) => url.includes("path=%2Ffixture%2Freports%2Freport.md")));
  await close().click();
  await rootCrumb().click();
  await entry("old-root.txt").waitFor();
  assert.deepEqual(errors, [], "No renderer errors");
  assert.deepEqual(unexpected, [], "Only owned, declared API endpoints were contacted");
  assert.deepEqual(blocked, [], "No external network was attempted");
  const report = {
    production: true,
    directoryFailureRetry: true,
    rapidDirectorySwitch: true,
    cancelledPreview: true,
    previewFailureRetry: true,
    absoluteFileLink: true,
    reports,
    requests,
    rendererErrors: errors,
    externalRequests: blocked,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    `PASS Web file browser: production Chromium, scoped failures/retries, stale responses, cancellation, focus/scroll at 320/390/760/1280px. Evidence: ${output}`,
  );
} catch (cause) {
  await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  console.error(`Web file browser failure evidence: ${output}`);
  throw cause;
} finally {
  await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
