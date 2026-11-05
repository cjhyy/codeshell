/* Run with Bun through run-isolated-node-smoke.mjs. Synthetic files only;
 * real opaque iframe modules, tunnel gate, Panel bridge and download transport. */
/* global Bun, window, document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
let runtime, manager, browser, resources, formTargetServer;
let authorized = true;
const errors = [],
  assetRequests = [],
  formTargetRequests = [],
  blockedRequests = [];
const formTargetPath = "/api/v1/form-parity-target";
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
        if (new URL(request.url, "http://localhost").pathname === formTargetPath) {
          formTargetRequests.push({ origin: "host", method: request.method });
          response.writeHead(200, { "Content-Type": "text/plain" });
          response.end("owned form target");
          return Promise.resolve(true);
        }
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
  formTargetServer = createServer((request, response) => {
    formTargetRequests.push({ origin: "second", method: request.method });
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": origin,
    });
    response.end("owned second form target");
  });
  await new Promise((resolve) => formTargetServer.listen(0, "127.0.0.1", resolve));
  const secondOrigin = `http://127.0.0.1:${formTargetServer.address().port}`;
  const allowedBrowserOrigins = new Set([origin, secondOrigin]);
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
    `<!doctype html><html><body><h1 id="ready"></h1>
    <button id="open">预览电脑文件</button><button id="confirm">请求打开链接</button>
    <output id="result"></output>
    <button id="open-static-dialog">打开静态对话框</button>
    <dialog id="static-dialog"><form method="dialog"><button value="static-accepted">确认静态对话框</button></form></dialog>
    <button id="open-dynamic-dialog">打开动态对话框</button>
    <form id="prevented-form" method="post" action="${origin}${formTargetPath}">
      <label>必填内容<input id="required-value" name="value" required></label>
      <button id="prevented-submit" type="submit">提交本地表单</button>
    </form>
    <output id="submit-count">0</output><output id="invalid-count">0</output>
    <output id="form-policy-count">0</output>
    <script type="module" src="./main.mjs"></script></body></html>`,
  );
  await writeFile(join(installPath, "app/label.mjs"), 'export const label = "面板模块已加载";');
  await writeFile(
    join(installPath, "app/main.mjs"),
    `import {label} from './label.mjs';
    const formState = window.formState = { submissions: [], invalid: 0, violations: [], navigationSubmits: 0 };
    document.querySelector('#ready').textContent = label;
    document.querySelector('#open-static-dialog').onclick = () => document.querySelector('#static-dialog').showModal();
    document.querySelector('#open-dynamic-dialog').onclick = () => {
      const dialog = document.createElement('dialog');
      dialog.id = 'dynamic-dialog';
      dialog.innerHTML = '<form method="dialog"><button value="dynamic-accepted">确认动态对话框</button></form>';
      document.body.append(dialog);
      dialog.showModal();
    };
    document.querySelector('#prevented-form').addEventListener('submit', (event) => {
      event.preventDefault();
      formState.submissions.push({ trusted: event.isTrusted, value: document.querySelector('#required-value').value });
      document.querySelector('#submit-count').textContent = String(formState.submissions.length);
    });
    document.querySelector('#required-value').addEventListener('invalid', () => {
      document.querySelector('#invalid-count').textContent = String(++formState.invalid);
    });
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.effectiveDirective !== 'form-action') return;
      formState.violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition });
      document.querySelector('#form-policy-count').textContent = String(formState.violations.length);
    });
    window.attemptFormNavigation = ({ method, target, fallback, mechanism }) => {
      const form = document.createElement('form');
      form.method = method;
      form.action = mechanism === 'requestSubmit' ? fallback : target;
      const field = document.createElement('input');
      field.name = 'proof'; field.value = 'synthetic-form-navigation';
      const submit = document.createElement('button');
      submit.type = 'submit'; submit.formAction = target;
      form.append(field, submit);
      form.addEventListener('submit', (event) => {
        formState.navigationSubmits++;
        if (mechanism === 'submit') event.preventDefault();
      });
      document.body.append(form);
      if (mechanism === 'requestSubmit') form.requestSubmit(submit);
      else HTMLFormElement.prototype.submit.call(form);
      form.remove();
    };
    document.querySelector('#open').onclick = async () => {
      try { await window.codeshellPanel.call('resources.open', {assetId:${JSON.stringify(asset.id)}});
        document.querySelector('#result').textContent = 'opened';
      } catch (error) { document.querySelector('#result').textContent = String(error); }
    };
    document.querySelector('#confirm').onclick = async () => {
      try { await window.codeshellPanel.call('external.open', {url:'https://example.invalid/'}); }
      catch (error) { document.querySelector('#result').textContent = String(error); }
    };`,
  );
  const app = {
    id: "mobile-download-fixture",
    version: "1.0.0",
    title: { default: "电脑文件" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    permissions: ["resources", "external.open"],
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
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/mobile/entry.css"><style>body{margin:0}#root{height:100dvh;display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/mobile/entry.js"></script></body></html>',
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
  await context.route("**/*", (route) => {
    if (allowedBrowserOrigins.has(new URL(route.request().url()).origin)) return route.continue();
    blockedRequests.push(route.request().url());
    return route.abort();
  });
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
  const assertViewport = async (selector) => {
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds, `${selector} must be visible`);
    const viewport = page.viewportSize();
    assert.ok(
      bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1,
      `${selector} must fit the mobile viewport`,
    );
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight + 1 &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "The host must not add a second page scrollbar",
    );
    return bounds;
  };
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    const bounds = await assertViewport("iframe");
    assert.ok(bounds.height > viewport.height / 2, "The panel keeps most of the available height");
    await frame.getByRole("button", { name: "请求打开链接" }).click();
    await page.getByRole("button", { name: "取消", exact: true }).waitFor();
    await assertViewport(".panel-host-confirm");
    assert.equal(await page.locator("iframe").getAttribute("inert"), "");
    assert.equal(
      await page
        .getByRole("button", { name: "重新加载", exact: true, includeHidden: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await frame.getByText("面板模块已加载").waitFor();
    assert.equal(await page.locator("iframe").getAttribute("inert"), null);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Both owned HTTP targets must really be reachable; a test route blocker
  // must not be mistaken for the guest's form-action CSP enforcement.
  await page.evaluate(
    async ({ origin, secondOrigin, path }) => {
      for (const target of [origin, secondOrigin])
        for (const method of ["GET", "POST"]) {
          const response = await fetch(target + path, { method });
          if (!response.ok) throw new Error("Owned form target is unreachable");
          await response.text();
        }
    },
    { origin, secondOrigin, path: formTargetPath },
  );
  assert.equal(formTargetRequests.length, 4);
  formTargetRequests.length = 0;
  assert.equal(await frame.locator("body").evaluate(() => window.origin), "null");
  assert.equal(
    await frame.locator("body").evaluate(() => {
      try {
        return document.cookie;
      } catch (error) {
        return error.name;
      }
    }),
    "SecurityError",
  );
  const parentUrl = page.url();
  const guestUrl = await frame.locator("body").evaluate(() => location.href);
  for (const kind of ["static", "dynamic"]) {
    await frame.locator(`#open-${kind}-dialog`).click();
    const dialog = frame.locator(`#${kind}-dialog`);
    assert.equal(await dialog.evaluate((element) => element.open), true);
    await dialog.getByRole("button").click();
    assert.equal(await dialog.evaluate((element) => element.open), false);
    assert.equal(await dialog.evaluate((element) => element.returnValue), `${kind}-accepted`);
  }
  await frame.locator("#prevented-submit").click();
  assert.equal(await frame.locator("#invalid-count").textContent(), "1");
  assert.equal(await frame.locator("#submit-count").textContent(), "0");
  await frame.locator("#required-value").fill("synthetic local form");
  await frame.locator("#prevented-submit").click();
  assert.equal(await frame.locator("#submit-count").textContent(), "1");
  await frame.locator("#required-value").press("Enter");
  assert.equal(await frame.locator("#submit-count").textContent(), "2");
  await frame.locator("#prevented-form").evaluate((form) => form.requestSubmit());
  assert.equal(await frame.locator("#submit-count").textContent(), "3");
  assert.equal(
    await frame
      .locator("body")
      .evaluate(() => window.formState.submissions.every((event) => event.trusted)),
    true,
  );
  let attemptedNavigations = 0;
  for (const method of ["GET", "POST"])
    for (const targetOrigin of [origin, secondOrigin])
      for (const mechanism of ["requestSubmit", "submit"]) {
        const target = targetOrigin + formTargetPath;
        const fallback = (targetOrigin === origin ? secondOrigin : origin) + formTargetPath;
        await frame
          .locator("body")
          .evaluate((_body, attempt) => window.attemptFormNavigation(attempt), {
            method,
            target,
            fallback,
            mechanism,
          });
        attemptedNavigations++;
        await frame
          .locator("#form-policy-count")
          .filter({ hasText: new RegExp(`^${attemptedNavigations}$`) })
          .waitFor();
        const violation = await frame
          .locator("body")
          .evaluate(() => window.formState.violations.at(-1));
        assert.equal(violation.directive, "form-action");
        assert.equal(violation.disposition, "enforce");
        assert.equal(new URL(violation.blockedURI).origin, targetOrigin);
        assert.equal(await frame.locator("body").evaluate(() => location.href), guestUrl);
        assert.equal(page.url(), parentUrl);
        assert.deepEqual(
          formTargetRequests,
          [],
          "Neither owned target may receive guest GET/POST forms",
        );
      }
  assert.equal(
    await frame.locator("body").evaluate(() => window.formState.navigationSubmits),
    4,
    "requestSubmit dispatches submit; native submit bypasses the cancelling handler",
  );
  assert.equal(await frame.locator("body").evaluate(() => window.formState.submissions.length), 3);
  const deniedCall = page.waitForResponse(
    (response) =>
      response.url().endsWith("/call") &&
      response.request().postDataJSON()?.method === "workspace.readText",
  );
  const deniedResult = await frame.locator("body").evaluate(async () => {
    try {
      await window.codeshellPanel.call("workspace.readText", { path: "not-authorized.txt" });
      return "accepted";
    } catch {
      return "denied";
    }
  });
  assert.equal(
    (await deniedCall).status(),
    403,
    "Allowing local forms grants no additional SDK permission",
  );
  assert.equal(deniedResult, "denied");
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
  assert.deepEqual(blockedRequests, []);
  console.log(
    JSON.stringify({
      opaqueTunnelModules: true,
      staticAndDynamicDialogReturnValue: true,
      preventedAndKeyboardSubmit: true,
      requiredValidation: true,
      blockedFormNavigations: attemptedNavigations,
      formTargetRequests: formTargetRequests.length,
      parentCookiesIsolated: true,
      undeclaredSdkPermissionDenied: true,
      mobileViewport: true,
      portraitAndLandscapeLayout: true,
      trustedConfirmationVisible: true,
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
  if (formTargetServer) {
    formTargetServer.closeAllConnections();
    await new Promise((resolve) => formTargetServer.close(resolve));
  }
  await resources?.shutdown();
  await rm(buildDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
