/* Run with Bun after build:server. Real opaque iframe media, canvas and revocation. */
/* global document, window */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPanelRuntime,
  panelWebCompatibility,
} from "../packages/server/src/panels/runtime.ts";
import { PanelResourceService } from "../packages/server/src/panels/resources/service.ts";
const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);
const root = await mkdtemp(join(tmpdir(), "panel-inline-browser-"));
const cwd = join(root, "workspace"),
  installPath = join(root, "package");
const prefix = "/p/7bc54c17-1af8-4105-87c1-f4e5c6638998";
let authorized = true,
  runtime,
  server,
  browser,
  service;
try {
  await mkdir(cwd);
  await mkdir(join(installPath, "app"), { recursive: true });
  await writeFile(
    join(installPath, "app/index.html"),
    '<!doctype html><html><body><script src="./main.js"></script></body></html>',
  );
  await writeFile(join(installPath, "app/main.js"), 'document.body.dataset.ready = "yes";');
  const app = {
    id: "inline-media",
    version: "1.0.0",
    title: { default: "Inline media" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    permissions: ["resources"],
    installPath,
    source: root,
    installedAt: "2026-09-27T00:00:00Z",
    lastUpdated: "2026-09-27T00:00:00Z",
    packageDigest: "b".repeat(64),
  };
  runtime = createPanelRuntime({
    cwd,
    dataDir: join(root, "data"),
    host: "hub",
    publicPathPrefix: prefix,
    ownerId: async (request) =>
      request.headers.cookie === "session=fixture" ? "owner" : undefined,
    isAuthorized: async (request) => authorized && request.headers.cookie === "session=fixture",
    listInstalled: async () => [app],
    snapshot: async () => ({
      workspace: cwd,
      hasProject: true,
      panels: [
        {
          ...app,
          revision: "a".repeat(64),
          bound: true,
          enabled: true,
          globalDisabled: false,
          updatable: false,
          source: { kind: "local", label: "Fixture" },
          compatibility: panelWebCompatibility(app),
        },
      ],
    }),
  });
  server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/") {
        response
          .writeHead(200, { "Content-Type": "text/html" })
          .end("<!doctype html><body></body>");
        return;
      }
      // Simulate the production project proxy preserving the public path prefix.
      if (!request.url.startsWith(prefix + "/")) {
        response.writeHead(404).end();
        return;
      }
      request.url = request.url.slice(prefix.length);
      if (await runtime.handleAssets(request, response)) return;
      if (await runtime.handle(request, response)) return;
      response.writeHead(404).end();
    })().catch(() => {
      response.writeHead(500).end("Fixture failure");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const response = await fetch(origin + prefix + "/api/v1/panels/runtime/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: "session=fixture" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  service = new PanelResourceService({
    rootDirectory: join(root, "data/panel-app-media"),
    isScopeAuthorized: () => true,
  });
  const scope = { appId: app.id, projectPath: cwd };
  const picture = join(cwd, "pixel.png"),
    sound = join(cwd, "tone.wav");
  await writeFile(
    picture,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHf8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const wav = Buffer.alloc(44 + 48000 * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000; i++)
    wav.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000)), 44 + i * 2);
  await writeFile(sound, wav);
  const assets = await Promise.all(
    [picture, sound].map((file) => service.library.importFile(scope, file)),
  );
  const grant = await call("prepare", {
    appId: app.id,
    revision: "a".repeat(64),
    sessionId: "fixture-session",
  });
  const previews = await Promise.all(
    assets.map((asset) =>
      call(grant.instanceId + "/call", {
        method: "resources.preview",
        params: { assetId: asset.id },
      }),
    ),
  );
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(
    (src) => {
      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts allow-downloads";
      iframe.src = src;
      document.body.append(iframe);
    },
    origin + prefix + grant.src,
  );
  const frame = await (await page.locator("iframe").elementHandle()).contentFrame();
  await frame.waitForFunction(() => document.body.dataset.ready === "yes");
  const result = await frame.evaluate(async ([picture, sound]) => {
    const image = document.createElement("img");
    image.crossOrigin = "anonymous";
    image.src = picture.url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const pixel = [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data];
    const audio = document.createElement("audio");
    audio.crossOrigin = "anonymous";
    await new Promise((done, fail) => {
      audio.onloadeddata = done;
      audio.onerror = () => fail(new Error("Audio did not decode"));
      audio.src = sound.url;
    });
    await new Promise((done, fail) => {
      audio.onseeked = done;
      audio.onerror = fail;
      audio.currentTime = 0.7;
    });
    let fetchBlocked = false;
    try {
      await fetch(sound.url);
    } catch {
      fetchBlocked = true;
    }
    return {
      pixel,
      duration: audio.duration,
      currentTime: audio.currentTime,
      fetchBlocked,
      opaque: window.origin === "null",
    };
  }, previews);
  assert.equal(result.opaque, true);
  assert.equal(result.pixel.length, 4);
  assert.ok(Math.abs(result.duration - 1) < 0.001);
  assert.ok(Math.abs(result.currentTime - 0.7) < 0.001);
  assert.equal(result.fetchBlocked, true, "Inline media must not enable general fetch access");
  authorized = false;
  for (const preview of previews) assert.ok([404, 410].includes((await fetch(preview.url)).status));
  console.log(
    "PASS: opaque project iframe draws origin-clean image pixels, decodes/seeks real WAV through public proxy prefix, keeps fetch blocked and loses resource access on revocation",
  );
} finally {
  await browser?.close();
  await runtime?.close();
  await service?.shutdown();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(root, { recursive: true, force: true });
}
