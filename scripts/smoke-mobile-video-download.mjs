/* Compiled and run by run-mobile-video-download.mjs in an isolated Node HOME.
 * Real reviewed consumer and Host, deterministic synthetic media. */
/* global document, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";
import { RemoteHostManager } from "../packages/server/src/mobile-remote/remote-host-manager.ts";
import { AccessPasscode } from "../packages/server/src/mobile-remote/access-passcode.ts";
import { TrustedDeviceStore } from "../packages/server/src/mobile-remote/trusted-device-store.ts";

assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.ok(process.argv[2], "Pass a reviewed apps/video-download directory explicitly");
const root = resolve(process.argv[3]);
const sourcePath = await realpath(process.argv[2]);
const sourceManifest = await readFile(join(sourcePath, ".codeshell-panel/panel.json"));
assert.equal(JSON.parse(sourceManifest).version, "0.24.1");
assert.equal(JSON.parse(sourceManifest).id, "video-download");
const node = await realpath(process.execPath);
const desktopRequire = createRequire(join(root, "packages/desktop/package.json"));
const { chromium } = desktopRequire("playwright");
const { build } = desktopRequire("esbuild");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "mobile-video-download-")));
const buildDir = await mkdtemp(join(root, "node_modules/.cache-mobile-video-download-"));
const evidenceDir = await realpath(await mkdtemp(join(tmpdir(), "codeshell-video-download-qa-")));
const cwd = join(scratch, "project"),
  dataDir = join(scratch, "data"),
  bin = join(dataDir, "panel-bin");
const bytes = Buffer.from("owned synthetic video download bytes\n".repeat(4096));
const digest = (value) => createHash("sha256").update(value).digest("hex");
let api, manager, browser, page;
const errors = [],
  blocked = [],
  calls = [],
  assetRequests = [],
  confirmations = [];
const accessChecks = new WeakMap();
let authorized = true,
  approving = false;
try {
  await Promise.all([mkdir(cwd), mkdir(bin, { recursive: true })]);
  const passcode = new AccessPasscode({ filePath: join(scratch, "access.json") });
  passcode.set("synthetic-video-download-access");
  manager = new RemoteHostManager({
    devices: new TrustedDeviceStore(join(scratch, "devices.json")),
    mobileRootDir: buildDir,
    onClientEvent() {},
    webApi: {
      start() {},
      close: async () => api?.close(),
      revokeDevice() {},
      handle: (request, response, context) => {
        accessChecks.set(request, context.isAccessAuthorized);
        return api.handle(request, response);
      },
      handleCapabilityAsset: (request, response) => {
        if (!["GET", "HEAD"].includes(request.method) || !api.ownsAssets(request))
          return Promise.resolve(false);
        assetRequests.push({
          url: request.url,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
        });
        return api.handleAssets(request, response);
      },
    },
  });
  const { url: origin } = await manager.start({
    host: "127.0.0.1",
    port: 0,
    mode: "tunnel",
    passcode,
  });
  // Replace the bootstrap's deny-all guard without any await/unprotected turn.
  globalThis[Symbol.for("codeshell.consumer.replace-network-guard")]();
  installLocalNetworkGuard(origin);
  assert.throws(() => fetch("https://consumer-guard.invalid/denied"));
  console.log("consumer: isolated tunnel ready");

  // Native process grants deliberately scrub NODE_OPTIONS. The first managed-bin
  // Node executable is therefore an owned wrapper which reinstates the exact-
  // origin guard. The real reviewed entry and every detached worker inherit it.
  const guard = join(scratch, "guard.mjs"),
    guardLog = join(scratch, "guard.jsonl");
  await writeFile(
    guard,
    `import {appendFileSync} from 'node:fs';
import {installLocalNetworkGuard} from ${JSON.stringify(pathToFileURL(join(root, "scripts/runtime-cost-smoke-isolation.mjs")).href)};
installLocalNetworkGuard(${JSON.stringify(origin)});
appendFileSync(${JSON.stringify(guardLog)}, JSON.stringify({pid:process.pid,entry:process.argv[1]})+'\\n');`,
  );
  await writeFile(
    join(bin, "node"),
    `#!${node}
const {spawn}=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]!== '-v' && args[0]!== '--version' && !args[0]?.startsWith(${JSON.stringify(process.env.HOME + "/")})) throw Error('Unexpected native entry');
const child=spawn(${JSON.stringify(node)},args,{stdio:'inherit',env:{...process.env,NODE_OPTIONS:${JSON.stringify("--import " + guard)}}});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
process.on('SIGINT',()=>child.kill('SIGINT'));
child.on('exit',(code)=>process.exit(code??1));`,
    { mode: 0o700 },
  );
  const fixtureUrl = origin + "/owned-fixture-video";
  const downloaderLog = join(scratch, "downloader.jsonl");
  await writeFile(
    join(bin, "yt-dlp"),
    `#!${node}
const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(downloaderLog)},JSON.stringify(args)+'\\n');
if(args.includes('--version')) {console.log('2026.10.15');process.exit(0);}
if(args.includes('--help')) {console.log('--js-runtimes RUNTIME[:PATH]');process.exit(0);}
if(args.at(-1)!==${JSON.stringify(fixtureUrl)}) throw Error('Only the owned fixture URL is allowed');
if(args.includes('--dump-single-json')) {console.log(JSON.stringify({id:'fixture',title:'手机完整下载验证',duration:42,uploader:'Owned fixture',webpage_url:${JSON.stringify(fixtureUrl)},formats:[{format_id:'fixture',height:720,ext:'mp4',vcodec:'avc1',acodec:'mp4a'}]}));process.exit(0);}
if(!process.cwd().startsWith(${JSON.stringify(cwd + "/")})) throw Error('Unexpected output workspace');
fs.writeFileSync(path.join(process.cwd(),'手机下载验证.mp4'),Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64'));
console.log('progress: 100%');`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "ffmpeg"),
    `#!${node}
if(!['-version','--version'].includes(process.argv[2])) throw Error('Unexpected ffmpeg operation');
console.log('ffmpeg version fixture');`,
    { mode: 0o700 },
  );
  process.env.PATH = bin;

  const core = await import("@cjhyy/code-shell-core");
  const { createPanelHttp } = await import("../packages/server/src/panels/http.ts");
  const source = { kind: "dir", path: sourcePath };
  const preview = await core.previewLocalPanelApp(source);
  console.log("consumer: package reviewed");
  const installed = await core.installReviewedLocalPanelApp(
    source,
    preview.reviewToken,
    new Date().toISOString(),
  );
  assert.ok(installed.installPath.startsWith(process.env.HOME + "/"));
  const isOwner = (request) =>
    authorized &&
    accessChecks.get(request)?.() !== false &&
    request.headers.cookie?.split("; ").includes("session=fixture");
  api = createPanelHttp({
    cwd,
    dataDir,
    host: "desktop",
    projectPackages: true,
    ownerId: async (request) => (isOwner(request) ? "fixture-owner" : undefined),
    isAuthorized: async (request) => !!isOwner(request),
  });
  const cookie = `cs_access=${passcode.verify("synthetic-video-download-access")}; session=fixture`;
  async function request(path, method = "GET", body) {
    const response = await fetch(origin + path, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  let snapshot = await request("/api/v1/panels");
  assert.equal(snapshot.workspace, cwd);
  let panel = snapshot.panels.find((candidate) => candidate.id === "video-download");
  assert.equal(panel.bound, false);
  await request("/api/v1/panels/video-download/binding", "PATCH", {
    bound: true,
    expectedRevision: panel.revision,
  });
  snapshot = await request("/api/v1/panels");
  panel = snapshot.panels.find((candidate) => candidate.id === "video-download");
  assert.equal(panel.bound, true);
  assert.equal(panel.enabled, true);
  console.log("consumer: installed and project bound");

  const webRequire = createRequire(join(root, "packages/web/package.json"));
  const entry = join(buildDir, "entry.tsx");
  await writeFile(
    entry,
    `import React from ${JSON.stringify(webRequire.resolve("react"))};
import {createRoot} from ${JSON.stringify(webRequire.resolve("react-dom/client"))};
import {PanelHost} from ${JSON.stringify(join(root, "packages/web/app/PanelHost.tsx"))};
createRoot(document.getElementById('root')).render(<PanelHost panel={${JSON.stringify(panel)}} sessionId="" busy={false} onClose={()=>{}} onAuthLost={()=>{}} onSubmitPrompt={async()=>{throw Error('No agent calls in this smoke')}}/>);`,
  );
  await build({
    entryPoints: [entry],
    outdir: buildDir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await writeFile(
    join(buildDir, "index.html"),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/mobile/entry.css"><style>body{margin:0}#root{height:100dvh}</style></head><body><div id="root"></div><script type="module" src="/mobile/entry.js"></script></body></html>',
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CODESHELL_TEST_CHROMIUM
      ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
      : { channel: "chromium" }),
    chromiumSandbox: true,
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  await context.addCookies([
    {
      name: "cs_access",
      value: passcode.verify("synthetic-video-download-access"),
      url: origin,
      sameSite: "Lax",
      httpOnly: true,
    },
    { name: "session", value: "fixture", url: origin, sameSite: "Lax", httpOnly: true },
  ]);
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith("/call")) calls.push(request.postDataJSON());
  });
  // Exercise the real visible execution confirmation; no bypass of its endpoint.
  await page.addLocatorHandler(
    page
      .locator(".panel-host-confirm")
      .filter({ hasText: bin })
      .getByRole("button", { name: "确认执行", exact: true }),
    async (button) => {
      approving = true;
      const body = await page
        .locator(".panel-host-confirm")
        .textContent()
        .catch(() => "");
      assert.ok(body.includes(bin), "Only the owned managed-bin programs may be approved");
      confirmations.push(body);
      await button.click();
      approving = false;
    },
  );
  await page.goto(origin + "/mobile/");
  console.log("consumer: mobile page opened");
  const frame = page.frameLocator("iframe");
  await frame.locator("#url-input").waitFor();
  await frame.locator('#environment-status[data-state="current"]').waitFor({ state: "attached" });
  assert.equal(await frame.locator("#form-error").isVisible(), false);
  assert.equal(await frame.locator("#destination-path").textContent(), cwd);
  await frame.locator("#choose-directory").click();
  const directoryConfirmation = page
    .locator(".panel-host-confirm")
    .filter({ hasText: "使用服务端下载目录？" });
  await directoryConfirmation.waitFor();
  assert.ok((await directoryConfirmation.textContent()).includes(join(cwd, "downloads")));
  await directoryConfirmation.getByRole("button", { name: "取消", exact: true }).click();
  await frame.locator("#choose-directory:not(:disabled)").waitFor();
  assert.equal(await frame.locator("#form-error").isVisible(), false);
  assert.equal(await frame.locator("#destination-path").textContent(), cwd);
  await frame.locator("#url-input").fill(fixtureUrl);
  await frame.locator("#inspect-button").click();
  await frame.locator("#video-title").filter({ hasText: "手机完整下载验证" }).waitFor();
  await frame.locator("#download-button").click();
  await frame.locator("#tab-history").click();
  const play = frame
    .locator(".history-item")
    .getByRole("button", { name: /^播放：/ })
    .first();
  await play.waitFor({ timeout: 60_000 });
  await page.screenshot({ path: join(evidenceDir, "phone-history.png") });
  await play.click();
  const save = page.getByRole("link", { name: "保存到此设备", exact: true });
  await save.waitFor();
  await page.screenshot({ path: join(evidenceDir, "phone-save.png") });
  const downloaded = page.waitForEvent("download");
  await save.click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), "手机下载验证.mp4");
  assert.equal(digest(await readFile(await download.path())), digest(bytes));
  assert.equal(digest(await readFile(join(cwd, "手机下载验证.mp4"))), digest(bytes));
  assert.ok(
    calls.some(
      (call) => call.method === "process.resolveEntry" && call.params.name === "download-service",
    ),
  );
  assert.ok(calls.some((call) => call.method === "resources.capture"));
  assert.ok(calls.some((call) => call.method === "resources.open"));
  assert.ok(confirmations.length > 0);
  assert.equal(approving, false);
  assert.ok(
    assetRequests.some(
      (request) => request.url.endsWith("app.js") && request.origin === "null" && !request.cookie,
    ),
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  const downloadUrl = new URL(await save.getAttribute("href"), origin).href;
  const unauthenticated = await fetch(downloadUrl);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.arrayBuffer();
  authorized = false;
  const revoked = await fetch(downloadUrl, { headers: { Cookie: cookie } });
  assert.ok([401, 403, 404, 410].includes(revoked.status));
  await revoked.arrayBuffer();
  const probes = (await readFile(downloaderLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(
    probes.some((args) => args.at(-1) === fixtureUrl && !args.includes("--dump-single-json")),
  );
  const guardedEntries = (await readFile(guardLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(guardedEntries.some(({ entry }) => entry?.endsWith("service.mjs")));
  assert.ok(guardedEntries.some(({ entry }) => entry?.endsWith("video-download.mjs")));
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  assert.equal(
    digest(await readFile(join(sourcePath, ".codeshell-panel/panel.json"))),
    digest(sourceManifest),
  );
  console.log(
    JSON.stringify({
      panel: "video-download",
      version: "0.24.1",
      reviewedInstall: true,
      projectBinding: true,
      opaqueTunnelModules: true,
      realNativeService: true,
      visibleExecutionApproval: true,
      mobileHistoryCapture: true,
      cancelledDirectoryPreservesProject: true,
      environmentReadyWithoutAlert: true,
      exactDownloadBytes: bytes.length,
      sha256: digest(bytes),
      unauthorizedDownloadDenied: true,
      revokedDownloadDenied: true,
      guardedProcesses: guardedEntries.length,
      evidenceDir,
      errors,
      blocked,
    }),
  );
} catch (error) {
  if (page)
    console.error(
      JSON.stringify({
        error: String(error),
        host: await page
          .locator("body")
          .innerText()
          .catch(() => ""),
        panel: await page
          .frameLocator("iframe")
          .locator("body")
          .innerText()
          .catch(() => ""),
        calls: calls.slice(-12),
        errors,
        blocked,
      }),
    );
  throw error;
} finally {
  await browser?.close();
  await manager?.stop();
  await rm(buildDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  console.log("consumer: cleanup completed");
}
