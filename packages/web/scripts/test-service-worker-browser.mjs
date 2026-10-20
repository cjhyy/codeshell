/** Actual Chromium ServiceWorker/CacheStorage against owned public assets.
 * The HTML shell and HTTP/API responses are fixtures; sw.js, registration and
 * offline UI are production sources. No Host, Core, provider or account is used.
 */
/* global window, navigator, caches, document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBrowserOperationCustody } from "./browser-operation-custody.mjs";
import { resolveServiceWorkerBrowserExecutable } from "./service-worker-browser-executable.mjs";

export async function resolveServiceWorkerEvidence(requested, repository, outerHome) {
  const repo = await realpath(repository);
  const home = await realpath(outerHome);
  const candidate = requested
    ? path.join(
        await realpath(path.dirname(path.resolve(requested))),
        path.basename(path.resolve(requested)),
      )
    : path.join(await realpath(tmpdir()), "codeshell-service-worker-browser-");
  const outside = (parent) => {
    const relative = path.relative(parent, candidate);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  assert.ok(outside(repo), "Evidence must remain outside the checkout");
  assert.ok(outside(home), "Evidence must survive outer HOME cleanup");
  if (!requested) return mkdtemp(candidate);
  await mkdir(candidate, { mode: 0o700 }); // EEXIST rejects adoption, including symlinks.
  return candidate;
}

export function serviceWorkerOperationsPassed(report) {
  return (
    report.operationsCompleted === true &&
    report.cases.length === 11 &&
    report.errors.length === 0 &&
    report.ownerDenied.length === 0 &&
    report.recordingFailed === false &&
    report.failure === undefined
  );
}

function failureText(error) {
  try {
    return String(error?.stack ?? error).slice(0, 32 * 1024);
  } catch {
    return "Owned fixture failure could not be serialized";
  }
}

export function latchServiceWorkerFailure(report, error, checkpoint) {
  if (report.failure === undefined) {
    report.failure = failureText(error);
    report.firstError = { phase: report.stage ?? "preparing", error: report.failure };
  }
  report.status = "failed";
  try {
    checkpoint();
  } catch {
    report.recordingFailed = true;
  }
}

export async function runServiceWorkerBrowser(args = process.argv.slice(2)) {
  assert.equal(process.env.NODE_ENV, "test", "Run through run-isolated-node-smoke.mjs");
  assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));
  assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === "--evidence-dir" && args[1]),
    "Expected no arguments or --evidence-dir <new-owned-directory>",
  );
  const repo = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
  const evidence = await resolveServiceWorkerEvidence(args[1], repo, process.env.HOME);
  const report = {
    status: "preparing",
    evidence,
    platform: process.platform,
    sourceSha256: {},
    cases: [],
    requests: [],
    denied: [],
    errors: [],
    ownerDenied: [],
    operationsCompleted: false,
    recordingFailed: false,
    firstError: null,
    privateHomeRemoved: false,
    boundary:
      "Production registration, ServiceWorker, public assets and offline UI in an actual incognito context; owned synthetic HTML/API responses. A private persistent owner stays blank with ServiceWorkers blocked and HTTP/WS denied. No Host, Core, Engine, provider or account. Proxy confinement is not an OS egress sandbox. Same-browser update and reload are covered; browser cold restart and application auto-reload on deployment are not.",
  };
  const reportPath = path.join(evidence, "report.json");
  const checkpoint = () => {
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    } catch {
      report.recordingFailed = true;
    }
  };
  let failure, custody, ownerContext, context, page, ownedProxy, origin;
  let ownerInspectionCompleted = false;
  let settlementCompleted = false;
  const recordFailure = (error) => {
    if (failure === undefined) failure = error;
    latchServiceWorkerFailure(report, error, checkpoint); // Before screenshots or cleanup awaits.
  };
  const recordCleanupFailure = (label, error) => {
    report.errors.push(`${label}: ${failureText(error)}`);
    recordFailure(error);
  };
  checkpoint();
  assert.equal(report.recordingFailed, false, "Initial non-passing SW receipt must be durable");
  console.log(JSON.stringify({ status: report.status, evidence }));
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
            navigator.serviceWorker.controller?.scriptURL ===
            `${window.location.origin}${base}sw.js`,
          base,
        ),
      `production ${base} worker did not take control`,
    );
  }
  try {
    report.stage = "setup-assets";
    const require = createRequire(path.join(repo, "packages/desktop/package.json"));
    const { build } = require("esbuild");
    const { chromium } = require("playwright");
    report.sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    }).trim();
    report.sourceDirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      }).trim() !== "";
    report.fixtureSHA256 = createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex");
    checkpoint();
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
      [...assets].map(([name, source]) => [
        name,
        createHash("sha256").update(source).digest("hex"),
      ]),
    );
    report.sourceSha256["register-service-worker.ts"] = createHash("sha256")
      .update(await readFile(new URL("../app/register-service-worker.ts", import.meta.url)))
      .digest("hex");
    let available = true,
      revision = 1;
    report.stage = "setup-proxy";
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
    ownedProxy = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.on("error", (error) => recordCleanupFailure("Owned HTTP proxy", error));
    origin = `http://127.0.0.1:${server.address().port}`;
    report.stage = "prepare-browser-custody";
    checkpoint();
    const executable = await resolveServiceWorkerBrowserExecutable({
      playwrightCorePackagePath: createRequire(require.resolve("playwright/package.json")).resolve(
        "playwright-core/package.json",
      ),
    });
    report.browserExecutable = executable.receipt;
    custody = await prepareBrowserOperationCustody({
      evidence,
      executablePath: executable.executablePath,
      executableSHA256: executable.receipt.executableSHA256,
      timeoutMs: 120_000,
      reportFailure: (message) => {
        report.errors.push(message);
        checkpoint();
      },
      onCheckpoint: (liveReceipt) => {
        report.browserCustody = liveReceipt;
        report.processSettlement = liveReceipt.settlement;
        report.processExit = liveReceipt.processExit;
        report.privateHomeRemoved = liveReceipt.privateHomeRemoved;
        report.retainedHome = liveReceipt.retainedHome;
        checkpoint();
      },
    });
    report.browserCustody = custody.receipt;
    report.stage = "launch-blank-owner";
    checkpoint();
    ownerContext = await custody.launchPersistentContext(chromium, {
      headless: true,
      timeout: 30_000,
      serviceWorkers: "block",
      proxy: { server: origin, bypass: "<-loopback>" },
    });
    await ownerContext.route("**/*", (route) => {
      report.ownerDenied.push({ kind: "http" });
      checkpoint();
      return route.abort();
    });
    await ownerContext.routeWebSocket("**/*", (route) => {
      report.ownerDenied.push({ kind: "websocket" });
      checkpoint();
      route.close();
    });
    for (const blank of ownerContext.pages())
      blank.on("pageerror", (error) => {
        report.errors.push(error.message);
        recordFailure(error);
      });
    ownerContext.on("page", (ownerPage) => {
      report.errors.push("Private owner created an unexpected page");
      ownerPage.on("pageerror", (error) => report.errors.push(error.message));
      checkpoint();
    });
    const inspectOwner = async () => {
      const urls = ownerContext.pages().map((ownerPage) => ownerPage.url());
      assert.deepEqual(urls, ["about:blank"]);
      assert.deepEqual(ownerContext.serviceWorkers(), []);
      assert.deepEqual(await ownerContext.storageState(), { cookies: [], origins: [] });
      report.ownerBlank = { urls, serviceWorkers: 0, storageEmpty: true };
    };
    await bounded(inspectOwner(), 10_000, "Private blank owner inspection timed out");
    report.stage = "incognito-context";
    const browser = ownerContext.browser();
    assert.ok(browser, "Private owner must expose its actual browser");
    context = await browser.newContext({
      serviceWorkers: "allow",
      viewport: { width: 1280, height: 720 },
    });
    assert.notEqual(
      context,
      ownerContext,
      "SW operations must retain their independent incognito context",
    );
    context.on("page", (ownedPage) => {
      ownedPage.on("pageerror", (error) => {
        report.errors.push(error.message);
        recordFailure(error);
      });
    });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    report.stage = "service-worker-operations";
    report.status = "running";
    checkpoint();
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
    const rootWorker = context
      .serviceWorkers()
      .find((worker) => worker.url() === origin + "/sw.js");
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
    report.operationsCompleted = true;
    report.stage = "operations-complete";
    checkpoint();
  } catch (error) {
    recordFailure(error);
    if (page)
      await page
        .screenshot({ path: path.join(evidence, "failure.png"), fullPage: true })
        .catch(() => {});
  } finally {
    report.stage = "close-incognito-context";
    checkpoint();
    try {
      if (context) await bounded(context.close(), 8_000, "Incognito context close timed out");
    } catch (error) {
      recordCleanupFailure("Incognito context close", error);
    }
    try {
      if (ownerContext) {
        const urls = ownerContext.pages().map((ownerPage) => ownerPage.url());
        assert.deepEqual(urls, ["about:blank"]);
        assert.deepEqual(ownerContext.serviceWorkers(), []);
        assert.deepEqual(
          await bounded(
            ownerContext.storageState(),
            10_000,
            "Private owner storage inspection timed out",
          ),
          { cookies: [], origins: [] },
        );
        report.ownerFinalBlank = { urls, serviceWorkers: 0, storageEmpty: true };
        ownerInspectionCompleted = true;
      }
    } catch (error) {
      recordCleanupFailure("Private owner boundary", error);
    } finally {
      report.stage = "settle-browser";
      checkpoint();
      try {
        if (custody) {
          await custody.settle();
          settlementCompleted = true;
        }
      } catch (error) {
        recordCleanupFailure("Browser settlement", error);
      }
    }
    report.stage = "close-owned-proxy";
    checkpoint();
    try {
      if (ownedProxy) {
        ownedProxy.closeAllConnections();
        await bounded(
          new Promise((resolve, reject) =>
            ownedProxy.close((error) => (error ? reject(error) : resolve())),
          ),
          3_000,
          "Owned HTTP proxy close timed out",
        );
      }
    } catch (error) {
      recordCleanupFailure("Owned HTTP proxy close", error);
    }
    report.stage = "settled-ledgers";
    if (custody) {
      try {
        const logs = custody.logs();
        await writeFile(path.join(evidence, "browser.stdout.log"), logs.stdout, { mode: 0o600 });
        await writeFile(path.join(evidence, "browser.stderr.log"), logs.stderr, { mode: 0o600 });
      } catch (error) {
        recordCleanupFailure("Browser log retention", error);
      }
      const acceptancePassed =
        settlementCompleted && ownerInspectionCompleted && serviceWorkerOperationsPassed(report);
      const cleanup = await custody.cleanupPrivateHome({ acceptancePassed });
      report.privateHomeRemoved = cleanup.removed;
      report.retainedHome = cleanup.retainedHome;
      report.status =
        acceptancePassed && cleanup.removed && serviceWorkerOperationsPassed(report)
          ? "passed"
          : "failed";
    } else report.status = "failed";
    report.stage = "complete";
    checkpoint();
    console.log(JSON.stringify({ status: report.status, cases: report.cases.length, evidence }));
  }
  if (failure !== undefined) throw failure;
  assert.equal(report.recordingFailed, false, "Final SW receipt recording failed");
  assert.equal(
    report.status,
    "passed",
    "Browser cleanup, operation or renderer error; evidence retained",
  );
  return report;
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === (await realpath(process.argv[1]).catch(() => null))
)
  await runServiceWorkerBrowser();
