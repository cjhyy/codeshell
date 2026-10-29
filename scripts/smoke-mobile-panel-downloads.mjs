/* Run with Bun through run-isolated-node-smoke.mjs. Synthetic files only;
 * real opaque iframe modules, tunnel gate, Panel bridge and download transport. */
/* global Bun, window, document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";
import { RemoteHostManager } from "../packages/server/src/mobile-remote/remote-host-manager.ts";
import { AccessPasscode } from "../packages/server/src/mobile-remote/access-passcode.ts";
import { TrustedDeviceStore } from "../packages/server/src/mobile-remote/trusted-device-store.ts";

const root = resolve(import.meta.dirname, "..");
const { chromium } = createRequire(join(root, "packages/desktop/package.json"))("playwright");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "mobile-panel-downloads-")));
const buildDir = await mkdtemp(join(root, "node_modules/.cache-mobile-panel-"));
const cwd = join(scratch, "project"),
  installPath = join(scratch, "panel"),
  dataDir = join(scratch, "data");
let runtime, manager, browser, resources;
let authorized = true;
const errors = [],
  assetRequests = [];
const accessChecks = new WeakMap();
try {
  await mkdir(cwd);
  await mkdir(join(installPath, "app"), { recursive: true });
  const passcode = new AccessPasscode({ filePath: join(scratch, "access.json") });
  passcode.set("synthetic-panel-passcode");
  manager = new RemoteHostManager({
    devices: new TrustedDeviceStore(join(scratch, "devices.json")),
    mobileRootDir: buildDir,
    onClientEvent() {},
    webApi: {
      start() {},
      close: async () => runtime?.close(),
      revokeDevice() {},
      handle: (request, response, context) => {
        accessChecks.set(request, context.isAccessAuthorized);
        return runtime.handle(request, response);
      },
      handleCapabilityAsset: (request, response) => {
        if (!["GET", "HEAD"].includes(request.method) || !runtime.ownsAssets(request))
          return Promise.resolve(false);
        assetRequests.push({
          url: request.url,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
        });
        return runtime.handleAssets(request, response);
      },
    },
  });
  const { url: origin } = await manager.start({
    host: "127.0.0.1",
    port: 0,
    mode: "tunnel",
    passcode,
  });
  installLocalNetworkGuard(origin);
  const { createPanelRuntime, panelWebCompatibility } =
    await import("../packages/server/src/panels/runtime.ts");
  const { PanelResourceService } =
    await import("../packages/server/src/panels/resources/service.ts");
  resources = new PanelResourceService({
    rootDirectory: join(dataDir, "panel-app-media"),
    isScopeAuthorized: () => true,
  });
  const bytes = Buffer.from("synthetic computer video output\n".repeat(4096));
  const file = join(cwd, "电脑视频.mp4");
  await writeFile(file, bytes);
  const asset = await resources.library.importFile(
    { appId: "mobile-download-fixture", projectPath: cwd },
    file,
  );
  await writeFile(
    join(installPath, "app/index.html"),
    '<!doctype html><html><body><h1 id="ready"></h1><button id="open">预览电脑文件</button><output id="result"></output><script type="module" src="./main.mjs"></script></body></html>',
  );
  await writeFile(join(installPath, "app/label.mjs"), 'export const label = "面板模块已加载";');
  await writeFile(
    join(installPath, "app/main.mjs"),
    `import {label} from './label.mjs';
    document.querySelector('#ready').textContent = label;
    document.querySelector('#open').onclick = async () => {
      try { await window.codeshellPanel.call('resources.open', {assetId:${JSON.stringify(asset.id)}});
        document.querySelector('#result').textContent = 'opened';
      } catch (error) { document.querySelector('#result').textContent = String(error); }
    };`,
  );
  const app = {
    id: "mobile-download-fixture",
    version: "1.0.0",
    title: { default: "电脑文件" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    permissions: ["resources"],
    installPath,
    source: scratch,
    installedAt: "2026-10-28T00:00:00Z",
    lastUpdated: "2026-10-28T00:00:00Z",
    packageDigest: "b".repeat(64),
  };
  const panel = {
    ...app,
    revision: "a".repeat(64),
    bound: true,
    enabled: true,
    globalDisabled: false,
    updatable: false,
    source: { kind: "local", label: "Fixture" },
    compatibility: panelWebCompatibility(app),
  };
  const isOwner = (request) =>
    authorized &&
    accessChecks.get(request)?.() !== false &&
    request.headers.cookie?.split("; ").includes("session=fixture");
  runtime = createPanelRuntime({
    cwd,
    dataDir,
    host: "desktop",
    ownerId: async (request) => (isOwner(request) ? "fixture-owner" : undefined),
    isAuthorized: async (request) => !!isOwner(request),
    listInstalled: async () => [app],
    snapshot: async () => ({ workspace: cwd, hasProject: true, panels: [panel] }),
  });
  const webRequire = createRequire(join(root, "packages/web/package.json"));
  const entry = join(buildDir, "entry.tsx");
  await writeFile(
    entry,
    `import React from ${JSON.stringify(webRequire.resolve("react"))};
    import {createRoot} from ${JSON.stringify(webRequire.resolve("react-dom/client"))};
    import {PanelHost} from ${JSON.stringify(join(root, "packages/web/app/PanelHost.tsx"))};
    const root = createRoot(document.getElementById('root'));
    root.render(<PanelHost panel={${JSON.stringify(panel)}} sessionId="" busy={false}
      onClose={() => root.unmount()} onAuthLost={() => {}} onSubmitPrompt={async () => ({accepted:true})} />);`,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: buildDir,
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  assert.ok(built.success, String(built.logs));
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
    acceptDownloads: true,
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await context.addCookies([
    {
      name: "cs_access",
      value: passcode.verify("synthetic-panel-passcode"),
      url: origin,
      sameSite: "Lax",
      httpOnly: true,
    },
    { name: "session", value: "fixture", url: origin, sameSite: "Lax", httpOnly: true },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/mobile/");
  const frame = page.frameLocator("iframe");
  await frame.getByText("面板模块已加载").waitFor();
  await page.getByText("正在打开面板…", { exact: true }).waitFor({ state: "hidden" });
  assert.ok(
    assetRequests.some(
      (request) =>
        request.url.includes("label.mjs") && request.origin === "null" && !request.cookie,
    ),
    "Opaque modules must actually omit access cookies",
  );
  await frame.getByRole("button", { name: "预览电脑文件" }).click();
  const save = page.getByRole("link", { name: "保存到此设备" });
  await save.waitFor();
  const downloadUrl = new URL(await save.getAttribute("href"), origin).href;
  await page.evaluate(() =>
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedDownload = value;
        },
      },
    }),
  );
  await page.getByRole("button", { name: "复制下载地址", exact: true }).click();
  await page.getByRole("button", { name: "已复制地址", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedDownload), downloadUrl);
  await page.evaluate(() =>
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  await page.getByRole("button", { name: "已复制地址", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "下载地址", exact: true }).inputValue(),
    downloadUrl,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  const downloaded = page.waitForEvent("download");
  await save.click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), "电脑视频.mp4");
  const downloadedBytes = await readFile(await download.path());
  assert.equal(
    createHash("sha256").update(downloadedBytes).digest("hex"),
    createHash("sha256").update(bytes).digest("hex"),
  );
  const cookie = (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
  const part = await fetch(downloadUrl, { headers: { Cookie: cookie, Range: "bytes=16-47" } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(16, 48));
  assert.equal((await fetch(downloadUrl)).status, 401, "Downloads still require tunnel access");
  const assetUrl = origin + assetRequests.find((request) => request.url.includes("label.mjs")).url;
  passcode.set("rotated-panel-passcode");
  assert.notEqual((await fetch(assetUrl, { headers: { Origin: "null" } })).status, 200);
  assert.equal((await fetch(downloadUrl, { headers: { Cookie: cookie } })).status, 401);
  await context.addCookies([
    {
      name: "cs_access",
      value: passcode.verify("rotated-panel-passcode"),
      url: origin,
      sameSite: "Lax",
      httpOnly: true,
    },
  ]);
  await page.reload();
  await frame.getByText("面板模块已加载").waitFor();
  await frame.getByRole("button", { name: "预览电脑文件" }).click();
  await save.waitFor();
  const renewedUrl = new URL(await save.getAttribute("href"), origin).href;
  assert.notEqual(renewedUrl, downloadUrl);
  const renewedCookie = (await context.cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  assert.equal(
    (await fetch(renewedUrl, { method: "HEAD", headers: { Cookie: renewedCookie } })).status,
    200,
  );
  authorized = false;
  const revoked = await fetch(renewedUrl, { headers: { Cookie: renewedCookie } });
  assert.ok([401, 403, 404, 410].includes(revoked.status));
  assert.notEqual((await fetch(assetUrl, { headers: { Origin: "null" } })).status, 200);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      opaqueTunnelModules: true,
      mobileViewport: true,
      computerFileSaved: true,
      exactDownloadBytes: true,
      copyAndFallback: true,
      range: true,
      passcodeRotation: true,
      revoked: true,
    }),
  );
} finally {
  await browser?.close();
  await manager?.stop();
  await resources?.shutdown();
  await rm(buildDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
