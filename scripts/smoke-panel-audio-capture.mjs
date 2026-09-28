/* Run with Bun after build:server. Production Host + real runtime/upload service;
 * Chromium provides a synthetic microphone, while MediaRecorder and WebM are real. */
/* global window, document, navigator, Event, Bun */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPanelRuntime,
  panelWebCompatibility,
} from "../packages/server/src/panels/runtime.ts";
const root = resolve(import.meta.dirname, "..");
const { chromium } = createRequire(join(root, "packages/desktop/package.json"))("playwright");
const scratch = await mkdtemp(join(tmpdir(), "panel-audio-browser-"));
const buildDir = await mkdtemp(join(root, "node_modules/.cache-panel-audio-"));
const cwd = join(scratch, "project"),
  installPath = join(scratch, "panel");
let runtime,
  server,
  browser,
  page,
  authorized = true,
  lostWrite = true,
  lostFinish = true;
const methods = [],
  errors = [];
try {
  await mkdir(cwd);
  await mkdir(join(installPath, "app"), { recursive: true });
  await writeFile(
    join(installPath, "app/index.html"),
    '<!doctype html><html><body><button id="record">Record audio</button><output id="result"></output><script src="./main.js"></script></body></html>',
  );
  await writeFile(
    join(installPath, "app/main.js"),
    `document.querySelector('#record').onclick = async () => {
    try { window.recordingResult = await window.codeshellPanel.call('resources.recordAudio', {maxDurationSeconds: 10});
      document.querySelector('#result').textContent = JSON.stringify(window.recordingResult);
    } catch(error) { document.querySelector('#result').textContent = String(error); }
  };`,
  );
  const app = {
    id: "audio-fixture",
    version: "1.0.0",
    title: { default: "Audio fixture" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    permissions: ["resources"],
    installPath,
    source: scratch,
    installedAt: "2026-09-27T00:00:00Z",
    lastUpdated: "2026-09-27T00:00:00Z",
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
  runtime = createPanelRuntime({
    cwd,
    dataDir: join(scratch, "data"),
    host: "hub",
    ownerId: async (request) =>
      request.headers.cookie === "session=fixture" ? "owner" : undefined,
    isAuthorized: async (request) => authorized && request.headers.cookie === "session=fixture",
    listInstalled: async () => [app],
    snapshot: async () => ({ workspace: cwd, hasProject: true, panels: [panel] }),
  });
  const entry = join(buildDir, "entry.tsx");
  const webRequire = createRequire(join(root, "packages/web/package.json"));
  await writeFile(
    entry,
    `import React from ${JSON.stringify(webRequire.resolve("react"))}; import {createRoot} from ${JSON.stringify(webRequire.resolve("react-dom/client"))};
    import {PanelHost} from ${JSON.stringify(join(root, "packages/web/app/PanelHost.tsx"))};
    const root = createRoot(document.getElementById('root'));
    window.unmountPanel = () => root.unmount();
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
  const files = new Map(
    await Promise.all(
      built.outputs.map(async (output) => [
        "/" + output.path.split("/").at(-1),
        {
          bytes: await output.arrayBuffer(),
          type: output.path.endsWith(".css") ? "text/css" : "text/javascript",
        },
      ]),
    ),
  );
  server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/") {
        response
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            '<!doctype html><html><head><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>',
          );
        return;
      }
      const file = files.get(request.url);
      if (file) {
        response.writeHead(200, { "Content-Type": file.type }).end(Buffer.from(file.bytes));
        return;
      }
      if (await runtime.handleAssets(request, response)) return;
      if (await runtime.handle(request, response)) return;
      response.writeHead(404).end();
    })().catch((error) => {
      errors.push(String(error));
      response.writeHead(500).end("Fixture failed");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    chromiumSandbox: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1200, height: 900 },
    acceptDownloads: true,
  });
  await context.addCookies([{ name: "session", value: "fixture", url: origin }]);
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // Drop only replies, after allowing the real server to commit each operation.
  await page.route("**/api/v1/panels/runtime/*/call", async (route) => {
    const method = route.request().postDataJSON().method;
    methods.push(method);
    const response = await route.fetch();
    if (method === "resources.upload.write" && lostWrite) {
      lostWrite = false;
      await route.abort();
      return;
    }
    if (method === "resources.upload.finish" && lostFinish) {
      lostFinish = false;
      await route.abort();
      return;
    }
    await route.fulfill({ response });
  });
  // Observe actual tracks for cleanup without substituting capture or encoding.
  await page.addInitScript(() => {
    window.capturedTracks = [];
    window.captureErrors = [];
    const get = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (get)
      navigator.mediaDevices.getUserMedia = async (...args) => {
        let stream;
        try {
          stream = await get(...args);
        } catch (error) {
          window.captureErrors.push({ name: error.name, message: error.message });
          throw error;
        }
        window.capturedTracks.push(...stream.getTracks());
        return stream;
      };
  });
  await page.goto(origin);
  const iframe = page.locator("iframe.panel-host-frame");
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator("#record").click();
  const dialog = page.getByRole("region", { name: "录音", exact: true });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => window.capturedTracks.length), 0);
  assert.equal(await frame.evaluate(() => window.origin), "null");
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await page.waitForFunction(() => {
    const status = document.querySelector('.panel-host-audio [role="status"]')?.textContent || "";
    if (/无法启动|未获授权/.test(status)) throw new Error(JSON.stringify(window.captureErrors));
    return status.includes("1 秒");
  });
  await dialog.getByRole("button", { name: "停止录音", exact: true }).click();
  await dialog.locator("audio").waitFor();
  await dialog.locator("audio").evaluate((audio) => audio.play());
  await page.waitForFunction(
    () => document.querySelector(".panel-host-audio audio")?.currentTime > 0,
  );
  await dialog.locator("audio").evaluate((audio) => audio.pause());
  await page.screenshot({ path: join(scratch, "review.png"), fullPage: true });
  assert.ok(
    await page.evaluate(() => window.capturedTracks.every((track) => track.readyState === "ended")),
  );
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "下载本机备份" }).click();
  const download = await downloadEvent;
  const bytes = await readFile(await download.path());
  assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3", "real WebM header");
  for (let attempt = 0; attempt < 2; attempt++) {
    await dialog.getByRole("button", { name: "保存到当前项目", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.getByRole("alert").innerText(), /录音仍保留/);
    assert.equal(await dialog.locator("audio").count(), 1);
  }
  await dialog.getByRole("button", { name: "保存到当前项目", exact: true }).click();
  await frame.waitForFunction(() => !!window.recordingResult?.asset);
  const receipt = await frame.evaluate(() => window.recordingResult);
  assert.equal(receipt.asset.id, `asset-${createHash("sha256").update(bytes).digest("hex")}`);
  assert.equal(receipt.asset.bytes, bytes.length);
  assert.equal(methods.filter((method) => method === "resources.upload.begin").length, 1);
  assert.equal(methods.filter((method) => method === "resources.upload.finish").length, 2);
  const preview = await frame.evaluate(
    async (id) => window.codeshellPanel.call("resources.preview", { assetId: id }),
    receipt.asset.id,
  );
  const response = await context.request.get(preview.url);
  assert.deepEqual(await response.body(), bytes);
  await frame.locator("#record").click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await page.waitForFunction(() =>
    window.capturedTracks.some((track) => track.readyState === "live"),
  );
  authorized = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() =>
    window.capturedTracks.every((track) => track.readyState === "ended"),
  );
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: trusted recording needs a click, produces real WebM, preserves backup across lost write/finish replies, saves one exact project resource and releases microphone on grant revocation; iframe remains opaque",
  );
  console.log(`Audio evidence: ${scratch}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(scratch, "error.png"), fullPage: true }).catch(() => {});
    await writeFile(
      join(scratch, "error.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
    );
  }
  console.error(`Audio evidence: ${scratch}`);
  throw error;
} finally {
  await browser?.close();
  await runtime?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(buildDir, { recursive: true, force: true });
}
