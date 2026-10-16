/** Actual Chromium ServiceWorker/CacheStorage against owned public assets.
 * The HTML shell and HTTP/API responses are fixtures; sw.js, registration and
 * offline UI are production sources. No Host, Core, provider or account is used.
 */
/* global window, navigator, caches, document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watchElectronTestProcess } from "../../desktop/scripts/electron-test-watchdog.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Run through run-isolated-node-smoke.mjs");
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const evidence = await mkdtemp(path.join(tmpdir(), "codeshell-service-worker-browser-"));
const report = {
  status: "preparing",
  evidence,
  platform: process.platform,
  sourceSha256: {},
  cases: [],
  requests: [],
  denied: [],
  errors: [],
};
// Preserve a discoverable, non-passing receipt even if asset reading/bundling
// fails before the browser-operation try/finally can begin.
await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, evidence }));
const publicDir = new URL("../app/public/", import.meta.url);
const assets = new Map(
  await Promise.all(
    ["sw.js", "offline.html", "icon.svg", "manifest.webmanifest"].map(async (name) => [
      name,
      await readFile(new URL(name, publicDir), "utf8"),
    ]),
  ),
);
const bundled = await build({
  stdin: {
    contents:
      'import {registerServiceWorker} from "./register-service-worker"; window.registerProductionWorker=registerServiceWorker;',
    resolveDir: fileURLToPath(new URL("../app/", import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
});
const registration = bundled.outputFiles[0].text;
report.sourceSha256 = Object.fromEntries(
  [...assets].map(([name, source]) => [name, createHash("sha256").update(source).digest("hex")]),
);
let available = true,
  revision = 1;
// This proxy never forwards or resolves a target. It serves the one exact owned
// origin itself, rejects every other HTTP origin and rejects all CONNECTs. A
// proxy is needed because context.route cannot confine ServiceWorker requests.
const server = createServer((request, response) => {
  const url = new URL(request.url, origin);
  if (url.origin !== origin) {
    report.denied.push({ kind: "http", url: url.href });
    response.writeHead(403);
    return response.end("Owned test proxy denied this origin");
  }
  report.requests.push({ method: request.method, path: url.pathname + url.search });
  if (!available) return request.socket.destroy();
  const basename = url.pathname.split("/").at(-1);
  response.setHeader("Cache-Control", "no-store");
  if (assets.has(basename)) {
    response.setHeader(
      "Content-Type",
      {
        "sw.js": "application/javascript",
        "offline.html": "text/html; charset=utf-8",
        "icon.svg": "image/svg+xml",
        "manifest.webmanifest": "application/manifest+json",
      }[basename],
    );
    return response.end(
      assets.get(basename) +
        (basename === "sw.js" ? `\n// revision ${revision}` : "") +
        (basename === "icon.svg" && url.search ? "\n<!-- owned-public-query -->" : ""),
    );
  }
  if (url.pathname === "/" || url.pathname === "/mobile/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    return response.end(
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owned online shell</title><h1>Owned online shell</h1><script>' +
        registration +
        "</script>",
    );
  }
  response.setHeader("Content-Type", "text/plain");
  response.end(`Owned uncached ${request.method} ${url.pathname}${url.search}`);
});
server.on("connect", (request, socket) => {
  report.denied.push({ kind: "connect", url: request.url });
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
});
server.on("upgrade", (request, socket) => {
  report.denied.push({ kind: "websocket", url: request.url });
  socket.destroy();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browserServer, browser, context, monitor, page, failure;
async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const cacheName = (base, version) => `codeshell-public-${encodeURIComponent(base)}-${version}`;
async function cacheSnapshot() {
  return page.evaluate(async () =>
    Object.fromEntries(
      await Promise.all(
        (await caches.keys()).map(async (name) => [
          name,
          (await (await caches.open(name)).keys())
            .map((request) => new URL(request.url).pathname)
            .sort(),
        ]),
      ),
    ),
  );
}
async function controlled(base) {
  await until(
    () =>
      page.evaluate(
        (base) =>
          navigator.serviceWorker.controller?.scriptURL === `${window.location.origin}${base}sw.js`,
        base,
      ),
    `production ${base} worker did not take control`,
  );
}
try {
  report.status = "running";
  browserServer = await chromium.launchServer({
    headless: true,
    timeout: 30_000,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    proxy: { server: origin, bypass: "<-loopback>" },
  });
  monitor = watchElectronTestProcess(browserServer.process(), { timeoutMs: 120_000 });
  browser = await chromium.connect(browserServer.wsEndpoint());
  context = await browser.newContext({
    serviceWorkers: "allow",
    viewport: { width: 1280, height: 720 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(origin);
  // Prove the configured proxy rejects a browser request before installing the
  // production worker. Target names are intentionally invalid, with no secrets.
  assert.equal(
    await page.evaluate(() =>
      fetch("http://codeshell-denied.invalid/page").then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  await until(
    () => report.denied.some((item) => item.url === "http://codeshell-denied.invalid/page"),
    "browser HTTP denial bypassed proxy",
  );
  assert.equal(
    await page.evaluate(() =>
      fetch("https://codeshell-denied.invalid/page").then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  await until(
    () =>
      report.denied.some(
        (item) => item.kind === "connect" && item.url === "codeshell-denied.invalid:443",
      ),
    "browser HTTPS denial bypassed proxy",
  );
  report.cases.push("browser HTTP and HTTPS proxy denial observed");

  await page.evaluate(
    async ({ rootOld, mobileOld }) => {
      for (const name of [rootOld, mobileOld, "codeshell-public-v1", "unrelated-owned-cache"]) {
        await (await caches.open(name)).put("/owned-sentinel", new Response(name));
      }
      window.registerProductionWorker("/");
    },
    { rootOld: cacheName("/", "v0"), mobileOld: cacheName("/mobile/", "v0") },
  );
  await controlled("/");
  let snapshot = await cacheSnapshot();
  assert.deepEqual(
    snapshot[cacheName("/", "v2")].sort(),
    ["/offline.html", "/icon.svg", "/manifest.webmanifest"].sort(),
  );
  assert.equal(snapshot[cacheName("/", "v0")], undefined);
  assert.equal(snapshot["codeshell-public-v1"], undefined);
  assert.ok(snapshot[cacheName("/mobile/", "v0")]);
  assert.ok(snapshot["unrelated-owned-cache"]);
  report.cases.push(
    "root installation caches only three public assets and cleans only own legacy caches",
  );
  const rootWorker = context.serviceWorkers().find((worker) => worker.url() === origin + "/sw.js");
  assert.ok(rootWorker);
  assert.equal(
    await rootWorker.evaluate(() =>
      fetch("http://codeshell-denied.invalid/sw").then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  await until(
    () => report.denied.some((item) => item.url === "http://codeshell-denied.invalid/sw"),
    "ServiceWorker denial bypassed proxy",
  );
  report.cases.push("actual ServiceWorker external HTTP request rejected by the proxy");

  await page.goto(origin + "/mobile/");
  await page.evaluate(() => window.registerProductionWorker("/mobile/"));
  await controlled("/mobile/");
  snapshot = await cacheSnapshot();
  assert.deepEqual(
    snapshot[cacheName("/mobile/", "v2")].sort(),
    ["/mobile/offline.html", "/mobile/icon.svg", "/mobile/manifest.webmanifest"].sort(),
  );
  assert.equal(snapshot[cacheName("/mobile/", "v0")], undefined);
  assert.ok(snapshot[cacheName("/", "v2")]);
  assert.ok(snapshot["unrelated-owned-cache"]);
  report.cases.push("mobile installation owns its cache and preserves root and unrelated caches");

  for (const url of [
    "/api/v1/auth/status",
    "/api/v1/uploads/owned",
    "/p/owned/api/v1/files/content",
  ]) {
    assert.match(
      await page.evaluate((url) => fetch(url).then((response) => response.text()), url),
      /Owned uncached/,
    );
  }
  assert.match(
    await page.evaluate(() =>
      fetch("/api/v1/uploads/owned", { method: "POST", body: "owned" }).then((response) =>
        response.text(),
      ),
    ),
    /Owned uncached POST/,
  );
  const queryPath = "/mobile/icon.svg?private=owned";
  const queriesBefore = report.requests.filter((request) => request.path === queryPath).length;
  assert.match(
    await page.evaluate((url) => fetch(url).then((response) => response.text()), queryPath),
    /owned-public-query/,
  );
  assert.equal(
    report.requests.filter((request) => request.path === queryPath).length,
    queriesBefore + 1,
  );
  assert.deepEqual(await cacheSnapshot(), snapshot);
  report.cases.push(
    "mobile API, upload, project, public query and POST responses never enter CacheStorage",
  );

  available = false;
  await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await page.getByRole("heading", { name: "工作空间暂时离线", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.screenshot({ path: path.join(evidence, "mobile-offline-320.png"), fullPage: true });
  for (const url of [
    "/api/v1/auth/status",
    "/api/v1/uploads/owned",
    "/p/owned/api/v1/files/content",
  ]) {
    assert.equal(
      await page.evaluate(
        (url) =>
          fetch(url).then(
            () => false,
            () => true,
          ),
        url,
      ),
      true,
    );
  }
  assert.deepEqual(await cacheSnapshot(), snapshot);
  report.cases.push(
    "mobile offline UI at 320px and private endpoints fail without public fallback",
  );
  available = true;
  await page.getByRole("link", { name: "重新连接", exact: true }).click();
  await page.getByRole("heading", { name: "Owned online shell", exact: true }).waitFor();
  assert.equal(page.url(), origin + "/mobile/");
  report.cases.push("offline reconnect link returns to its original mobile URL");

  revision += 1;
  await page.evaluate(() => {
    window.ownedOldController = navigator.serviceWorker.controller;
  });
  const oldWorker = context
    .serviceWorkers()
    .find((worker) => worker.url() === origin + "/mobile/sw.js");
  await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration("/mobile/")).update(),
  );
  await until(
    () =>
      context
        .serviceWorkers()
        .some((worker) => worker !== oldWorker && worker.url() === origin + "/mobile/sw.js"),
    "new worker script did not install",
  );
  await controlled("/mobile/");
  await until(
    () =>
      page.evaluate(async () => {
        const current = navigator.serviceWorker.controller;
        const registration = await navigator.serviceWorker.getRegistration("/mobile/");
        return (
          current !== window.ownedOldController &&
          current?.state === "activated" &&
          registration.active === current
        );
      }),
    "updated worker did not replace the controlling incarnation",
  );
  await until(
    () =>
      page.evaluate(
        async () => !(await navigator.serviceWorker.getRegistration("/mobile/")).installing,
      ),
    "updated worker did not activate",
  );
  assert.deepEqual(await cacheSnapshot(), snapshot);
  report.cases.push(
    "changed production worker installs and activates while retaining only public cache entries",
  );

  await page.goto(origin);
  await controlled("/");
  for (const url of [
    "/api/v1/auth/status",
    "/api/v1/uploads/owned",
    "/p/owned/api/v1/files/content",
  ]) {
    assert.match(
      await page.evaluate((url) => fetch(url).then((response) => response.text()), url),
      /Owned uncached GET/,
    );
  }
  assert.match(
    await page.evaluate(() =>
      fetch("/api/v1/uploads/owned", { method: "POST", body: "owned" }).then((response) =>
        response.text(),
      ),
    ),
    /Owned uncached POST/,
  );
  assert.deepEqual(await cacheSnapshot(), snapshot);
  report.cases.push("root controller leaves API, upload, project and POST responses uncached");
  report.privateNavigationFailures = [];
  for (const url of ["/api/v1/auth/status", "/p/owned/api/v1/files/content"]) {
    const privatePage = await context.newPage();
    await privatePage.goto(origin + url);
    assert.match(await privatePage.locator("body").innerText(), /Owned uncached GET/);
    assert.equal(
      await privatePage.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
      origin + "/sw.js",
    );
    available = false;
    const navigationError = await privatePage.reload({ timeout: 10_000 }).then(
      () => null,
      (error) => error,
    );
    assert.ok(navigationError, "private navigation incorrectly received a public offline page");
    report.privateNavigationFailures.push({ url, error: navigationError.message.slice(0, 500) });
    assert.equal(
      await privatePage.getByRole("heading", { name: "工作空间暂时离线", exact: true }).count(),
      0,
    );
    await privatePage.close();
    available = true;
  }
  assert.deepEqual(await cacheSnapshot(), snapshot);
  report.cases.push(
    "actual root-scope private navigations fail offline without substituting the public page",
  );
  available = false;
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page.getByRole("heading", { name: "工作空间暂时离线", exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "root-offline-1280.png"), fullPage: true });
  report.cases.push("root scope also serves the actual public offline UI");
  assert.deepEqual(report.errors, []);
  report.finalCaches = await cacheSnapshot();
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.failure = error.stack ?? String(error);
  if (page)
    await page
      .screenshot({ path: path.join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
} finally {
  await context?.close().catch((error) => {
    report.errors.push(`context close: ${error.message}`);
  });
  await browser?.close().catch((error) => {
    report.errors.push(`browser close: ${error.message}`);
  });
  await browserServer?.close().catch((error) => {
    report.errors.push(`browser server close: ${error.message}`);
  });
  if (monitor) report.processSettlement = await monitor.terminate();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (report.errors.length || report.processSettlement?.status !== "cleaned")
    report.status = "failed";
  await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, evidence }));
}
assert.equal(report.status, "passed", failure?.message ?? "browser cleanup or renderer error");
