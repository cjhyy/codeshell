// Actual Node HTTP / optional Chromium only. Guards precede all fixture I/O and
// maintained browser imports. No Core, Docker, provider or operator state.
/* global document, localStorage, navigator, parent, Worker */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const configPath = process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG;
const config = JSON.parse(readFileSync(configPath));
const mode = process.argv[2];
const root = config.fixtureRoot;
const script = join(root, "tests/fixtures/docker-candidate-http-case.mjs");
const { candidateFile, installDockerCandidateGuard } = await import(
  pathToFileURL(join(root, "scripts/docker-candidate-guard.mjs"))
);
let browserPath, browserHash;
const children = new Set();
const capturedPids = [];
let guard;
if (mode !== "server") {
  process.env.NODE_OPTIONS = `--import=${config.preload}`;
  guard = installDockerCandidateGuard(config, {
    driverChild(command, args, options) {
      if (command !== browserPath || !options.detached) return undefined;
      validateBrowser(args, { temporaryRoot: config.temporaryRoot });
      return {
        path: browserPath,
        sha256: browserHash,
        maximum: 1024 ** 3,
        args,
        role: "driver",
        allowDetached: true,
      };
    },
    childStarted(child) {
      children.add(child);
      capturedPids.push(child.pid);
      child.once("close", () => children.delete(child));
    },
  });
}
assert.deepEqual(globalThis[Symbol.for("codeshell.docker-candidate.pre-core")], {
  role: config.role,
  negativeProbes: 6,
  dnsNegativeProbes: 4,
});
const {
  bridgeDockerCandidateHttp,
  candidateHttpBodyLimit,
  candidateHttpDeadline,
  createDockerBrowserGuard,
} = await import(pathToFileURL(join(root, "scripts/docker-candidate-browser-guard.mjs")));
const { candidateChromiumDefaults, validateCandidateChromiumArguments: validateBrowser } =
  await import(pathToFileURL(join(root, "scripts/docker-candidate-driver.mjs")));
const binary = Buffer.from([0, 128, 255, 3, 2, 1]);
const text = "owned compressed browser text";

function fixtureServer() {
  const sockets = new Set(),
    counts = new Map();
  let closing = false;
  const send = (value) => {
    if (!closing && process.connected) process.send(value, () => {});
  };
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path === "/opaque-child") {
      response
        .writeHead(200, {
          "content-type": "text/html",
          "content-security-policy": "default-src 'none'; sandbox allow-scripts allow-downloads",
        })
        .end("<!doctype html><p>owned opaque frame</p>");
      return;
    }
    if (path === "/browser-worker-counts") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          serviceWorker: counts.get("/owned-sw.js") ?? 0,
          worker: counts.get("/owned-worker.js") ?? 0,
        }),
      );
      return;
    }
    if (path === "/slow") {
      const sequence = counts.get(path);
      response.once("close", () => send({ slowClosed: true, sequence }));
      response.writeHead(200);
      response.flushHeaders();
      send({ slowStarted: true, sequence });
      return;
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "https://external.invalid/private" }).end();
      return;
    }
    if (path === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream" }).end("data: owned\n\n");
      return;
    }
    if (path === "/oversized") {
      response.writeHead(200, { "content-length": candidateHttpBodyLimit + 1 }).flushHeaders();
      return;
    }
    if (path === "/overflow") {
      response.writeHead(200);
      response.write(Buffer.alloc(candidateHttpBodyLimit));
      response.end(Buffer.from([1]));
      return;
    }
    if (path === "/decoded-overflow") {
      response
        .writeHead(200, { "content-encoding": "gzip" })
        .end(gzipSync(Buffer.alloc(candidateHttpBodyLimit + 1)));
      return;
    }
    if (path.startsWith("/compressed/")) {
      const encoding = path.split("/").at(-1);
      const compress = { gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync }[encoding];
      const bytes = compress(Buffer.from(text));
      response
        .writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": encoding,
          "content-length": bytes.length,
        })
        .end(bytes);
      return;
    }
    if (path === "/range") {
      assert.equal(request.headers.range, "bytes=1-3");
      response
        .writeHead(206, {
          "content-type": "application/octet-stream",
          "content-range": "bytes 1-3/6",
          "accept-ranges": "bytes",
          "content-disposition": 'attachment; filename="owned.bin"',
          "content-length": 3,
        })
        .end(binary.subarray(1, 4));
      return;
    }
    if (path === "/not-modified") {
      response.writeHead(304, { etag: '"owned"', "content-length": "321" }).end();
      return;
    }
    if (path === "/head") {
      response.writeHead(200, { "content-length": "321" }).end();
      return;
    }
    if (path === "/cookie") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ cookie: request.headers.cookie === "session=owned; extra=second" }),
      );
      return;
    }
    if (path === "/login") {
      response.setHeader("Set-Cookie", [
        "session=owned; Path=/; HttpOnly; SameSite=Strict",
        "extra=second; Path=/; HttpOnly; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
      ]);
      response.end("logged in");
      return;
    }
    if (path === "/logout") {
      response.setHeader("Set-Cookie", [
        "session=; Path=/; Max-Age=0; HttpOnly",
        "extra=; Path=/; Max-Age=0; HttpOnly",
      ]);
      response.end("logged out");
      return;
    }
    if (path === "/binary" || path === "/large") {
      const chunks = [];
      for await (const part of request) chunks.push(part);
      const bytes = Buffer.concat(chunks);
      assert.equal(request.method, "PUT");
      if (path === "/large") response.end(String(bytes.length));
      else
        response
          .writeHead(201, {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="owned.bin"',
          })
          .end(bytes);
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html",
        connection: "close, x-owned-hop",
        "x-owned-hop": "strip",
      })
      .end("<!doctype html><title>owned</title><body>owned local fixture</body>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    server,
    sockets,
    counts,
    async close() {
      closing = true;
      const closed = once(server, "close");
      const socketClosures = [...sockets].map((socket) => once(socket, "close"));
      server.close();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await Promise.all([closed, ...socketClosures]);
      assert.equal(sockets.size, 0);
    },
  };
}

function request(origin, path, { method = "GET", headers = {}, body = null, allHeaders } = {}) {
  return {
    url: () => origin + path,
    method: () => method,
    postDataBuffer: () => body,
    allHeaders: allHeaders ?? (async () => headers),
  };
}
async function native() {
  const owned = fixtureServer();
  let origin;
  let active = true;
  const live = () => assert.equal(active, true);
  const operations = new Set();
  const start = (value) => {
    const op = bridgeDockerCandidateHttp({ request: value, origin, live });
    operations.add(op);
    return op;
  };
  const call = async (path, options) => {
    const op = start(request(origin, path, options));
    try {
      return await op.response;
    } finally {
      op.stop();
      await op.closed;
      operations.delete(op);
    }
  };
  try {
    owned.server.listen(0, "127.0.0.1");
    await once(owned.server, "listening");
    origin = `http://127.0.0.1:${owned.server.address().port}`;
    const page = await call("/");
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /owned local/);
    assert.equal(page.headers["x-owned-hop"], undefined);
    const login = await call("/login");
    assert.equal(login.headers["set-cookie"].split("\n").length, 2);
    assert.match(login.headers["set-cookie"], /Expires=Wed, 01 Jan/);
    const cookie = await call("/cookie", { headers: { Cookie: "session=owned; extra=second" } });
    assert.equal(JSON.parse(cookie.body).cookie, true);
    const echoed = await call("/binary", {
      method: "PUT",
      body: binary,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(echoed.status, 201);
    assert.deepEqual(echoed.body, binary);
    assert.match(echoed.headers["content-disposition"], /owned.bin/);
    const large = await call("/large", { method: "PUT", body: Buffer.alloc(32 * 1024 * 1024 + 1) });
    assert.equal(large.body.toString(), String(32 * 1024 * 1024 + 1));
    const ranged = await call("/range", { headers: { Range: "bytes=1-3" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-range"], "bytes 1-3/6");
    assert.deepEqual(ranged.body, binary.subarray(1, 4));
    for (const encoding of ["gzip", "br", "deflate"]) {
      const response = await call(`/compressed/${encoding}`);
      assert.equal(response.body.toString(), text);
      assert.equal(response.headers["content-encoding"], undefined);
      assert.equal(response.headers["content-length"], String(Buffer.byteLength(text)));
    }
    for (const [path, method, status] of [
      ["/not-modified", "GET", 304],
      ["/head", "HEAD", 200],
    ]) {
      const response = await call(path, { method });
      assert.equal(response.status, status);
      assert.equal(response.body.length, 0);
      assert.equal(response.headers["content-length"], "321");
    }
    for (const path of ["/redirect", "/sse", "/oversized", "/overflow", "/decoded-overflow"])
      await assert.rejects(call(path));
    const before = owned.counts.get("/sse");
    await assert.rejects(call("/sse", { headers: { accept: "text/event-stream" } }));
    assert.equal(owned.counts.get("/sse"), before);
    await assert.rejects(
      call("/", { body: Buffer.alloc(candidateHttpBodyLimit + 1), method: "PUT" }),
    );
    let release;
    const delayed = start(
      request(origin, "/revoked", {
        allHeaders: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      }),
    );
    active = false;
    release({});
    await assert.rejects(delayed.response);
    await delayed.closed;
    operations.delete(delayed);
    active = true;
    assert.equal(owned.counts.get("/revoked"), undefined);
    const slow = start(request(origin, "/slow"));
    const rejected = assert.rejects(slow.response);
    while (!owned.counts.has("/slow")) await new Promise((resolve) => setTimeout(resolve, 1));
    slow.stop();
    await rejected;
    await slow.closed;
    operations.delete(slow);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const timed = start(
        request(origin, "/deadline", { allHeaders: () => new Promise(() => {}) }),
      );
      const rejected = assert.rejects(timed.response);
      mock.timers.tick(candidateHttpDeadline);
      await rejected;
      await timed.closed;
      operations.delete(timed);
    } finally {
      mock.timers.reset();
    }
    assert.equal(owned.counts.get("/deadline"), undefined);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const slowTimed = start(request(origin, "/slow"));
      const timedRejected = assert.rejects(slowTimed.response);
      while ((owned.counts.get("/slow") ?? 0) < 2)
        await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(candidateHttpDeadline);
      await timedRejected;
      await slowTimed.closed;
      operations.delete(slowTimed);
    } finally {
      mock.timers.reset();
    }
  } finally {
    for (const operation of operations) operation.stop();
    await Promise.all([...operations].map((operation) => operation.closed));
    if (owned.server.listening || owned.sockets.size) await owned.close();
  }
  return {
    native: true,
    cookie: true,
    binary: true,
    ranges: true,
    compression: true,
    redirectsBlocked: true,
    sseBlocked: true,
    capacityBlocked: true,
    deadlineBlocked: true,
    revokedBeforeSend: true,
    stoppedInflight: true,
    listenerClosed: true,
    sockets: owned.sockets.size,
  };
}

async function chromium() {
  let controller,
    controllerResult,
    controllerOut = "",
    controllerErr = "",
    closeReceipt;
  let browser,
    context,
    page,
    sequence = 0,
    failed = false,
    primary;
  const cleanup = [],
    events = [];
  const bounded = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const message = (predicate) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("Owned controller message timeout")), 5000);
      const onMessage = (value) => {
        if (predicate(value)) done(undefined, value);
      };
      const onClose = () => done(new Error("Owned controller closed before receipt"));
      const done = (error, value) => {
        clearTimeout(timer);
        controller.off("message", onMessage);
        controller.off("close", onClose);
        if (error) reject(error);
        else resolve(value);
      };
      controller.on("message", onMessage);
      controller.once("close", onClose);
    });
  };
  const closeController = async () => {
    if (!controller) return;
    if (controller.exitCode === null && controller.signalCode === null && controller.connected)
      controller.send({ close: true });
    const result = await bounded(controllerResult, "Owned controller exit timeout");
    writeFileSync(
      join(config.home, "controller-terminal.json"),
      JSON.stringify(
        { ...result, stdout: controllerOut, stderr: controllerErr, closeReceipt },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.deepEqual(closeReceipt, { closed: true, sockets: 0 });
    assert.equal(controllerOut, "");
    assert.equal(controllerErr, "");
  };
  const beginSlow = async () => {
    const number = ++sequence;
    const pending = page
      .evaluate(async () => {
        try {
          await fetch("/slow");
        } catch {}
      })
      .catch(() => {});
    await message((value) => value.slowStarted === true && value.sequence === number);
    return { number, pending };
  };
  try {
    // Capture before any startup await. Failure at ready/factory/binary lookup
    // still enters the same bounded cleanup and retains unknown custody.
    controller = spawn(process.execPath, [script, "server"], {
      env: { ...process.env, ...config.server.environment },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let spawnError;
    controller.on("error", (error) => {
      spawnError = error;
    });
    controllerResult = new Promise((resolve) =>
      controller.once("close", (code, signal) => resolve({ code, signal, error: spawnError })),
    );
    controller.stdout.on("data", (bytes) => {
      controllerOut += bytes;
    });
    controller.stderr.on("data", (bytes) => {
      controllerErr += bytes;
    });
    controller.on("message", (value) => {
      events.push(value);
      if (value.closed) closeReceipt = value;
    });
    const ready = await message((value) => value.ready === true);
    guard.allowOrigin(ready.origin);
    const factory = await createDockerBrowserGuard({
      child: controller,
      origin: ready.origin,
      policyPath: config.server.path,
      policyHash: config.server.policyHash,
    });
    const require = createRequire(join(root, "packages/desktop/package.json"));
    const { chromium } = require("playwright");
    assert.equal(require("playwright-core/package.json").version, "1.64.0");
    const defaultProfile = join(config.temporaryRoot, "reviewed-default-profile");
    const actualDefaults = await require("playwright-core/lib/coreBundle")
      .server.createPlaywright({ sdkLanguage: "javascript" })
      .chromium.defaultArgs({ headless: true, chromiumSandbox: true }, false, defaultProfile);
    assert.deepEqual(actualDefaults, [
      ...candidateChromiumDefaults,
      `--user-data-dir=${defaultProfile}`,
      "--remote-debugging-pipe",
      "--no-startup-window",
    ]);
    browserPath = realpathSync(chromium.executablePath());
    browserHash = candidateFile(browserPath, { maximum: 1024 ** 3 }).sha256;
    const launch = async () => {
      browser = await chromium.launch({ channel: "chromium", chromiumSandbox: true });
      context = await factory.createContext(browser);
      page = await context.newPage();
      await page.goto(ready.origin);
    };
    await launch();
    assert.equal(await page.title(), "owned");
    assert.equal(
      await page.evaluate(
        async () => (await fetch("/login", { method: "POST", body: "fixture" })).status,
      ),
      200,
    );
    const cookies = await context.cookies(ready.origin);
    assert.equal(cookies.length, 2);
    assert.equal(
      cookies.every((cookie) => cookie.httpOnly),
      true,
    );
    assert.equal(
      await page.evaluate(async () => (await (await fetch("/cookie")).json()).cookie),
      true,
    );
    const echoed = await page.evaluate(async () => {
      const response = await fetch("/binary", {
        method: "PUT",
        body: new Uint8Array([0, 128, 255, 3, 2, 1]),
      });
      return {
        status: response.status,
        bytes: [...new Uint8Array(await response.arrayBuffer())],
        disposition: response.headers.get("content-disposition"),
      };
    });
    assert.equal(echoed.status, 201);
    assert.deepEqual(echoed.bytes, [...binary]);
    assert.match(echoed.disposition, /owned.bin/);
    const ranged = await page.evaluate(async () => {
      const response = await fetch("/range", { headers: { Range: "bytes=1-3" } });
      return {
        status: response.status,
        range: response.headers.get("content-range"),
        bytes: [...new Uint8Array(await response.arrayBuffer())],
      };
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.range, "bytes 1-3/6");
    assert.deepEqual(ranged.bytes, [...binary.subarray(1, 4)]);
    for (const encoding of ["gzip", "br", "deflate"]) {
      const response = await page.evaluate(async (encoding) => {
        const response = await fetch(`/compressed/${encoding}`);
        return { text: await response.text(), encoding: response.headers.get("content-encoding") };
      }, encoding);
      assert.equal(response.text, text);
      assert.equal(response.encoding, null);
    }
    const notModified = await page.evaluate(async () => {
      const response = await fetch("/not-modified");
      return { status: response.status, body: await response.text() };
    });
    assert.deepEqual(notModified, { status: 304, body: "" });
    for (const path of ["/redirect", "/sse", "https://external.invalid/"])
      assert.equal(
        await page.evaluate(async (path) => {
          try {
            await fetch(path);
            return false;
          } catch {
            return true;
          }
        }, path),
        true,
      );
    await page.evaluate(async () => {
      await fetch("/logout", { method: "POST" });
    });
    assert.equal((await context.cookies(ready.origin)).length, 0);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "owned-opaque";
      frame.src = "/opaque-child";
      frame.setAttribute("sandbox", "allow-scripts allow-downloads");
      document.body.appendChild(frame);
    });
    const frame = await (await page.locator("#owned-opaque").elementHandle()).contentFrame();
    await frame.locator("p").waitFor();
    assert.deepEqual(
      pageErrors,
      [],
      "Blocking service workers must not inject opaque-frame errors",
    );
    assert.deepEqual(
      await frame.evaluate(async () => {
        const denied = (action) => {
          try {
            action();
            return false;
          } catch (error) {
            return error.name === "SecurityError";
          }
        };
        return {
          parent: denied(() => parent.document),
          storage: denied(() => localStorage),
          network: await fetch("/cookie").then(
            () => false,
            () => true,
          ),
        };
      }),
      { parent: true, storage: true, network: true },
    );
    assert.equal(
      await page.evaluate(
        async () => (await navigator.serviceWorker.register("/owned-sw.js")) === undefined,
      ),
      true,
    );
    assert.equal(context.serviceWorkers().length, 0);
    assert.equal(
      await page.evaluate(() => {
        try {
          new Worker("/owned-worker.js");
          return false;
        } catch (error) {
          return error.message === "Candidate browser transport refused";
        }
      }),
      true,
    );
    assert.deepEqual(
      await page.evaluate(async () => (await fetch("/browser-worker-counts")).json()),
      { serviceWorker: 0, worker: 0 },
    );
    const applicationError = page.waitForEvent("pageerror");
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("Owned application failure");
      }, 0);
    });
    assert.equal((await applicationError).message, "Owned application failure");
    assert.throws(
      () => assert.deepEqual(pageErrors, [], "Installed Job Hunt must not raise page errors"),
      /Owned application failure/,
    );
    const first = await beginSlow();
    await bounded(context.close(), "Owned context close timeout");
    context = undefined;
    await bounded(first.pending, "Context pending request timeout");
    await message((value) => value.slowClosed === true && value.sequence === first.number);
    context = await factory.createContext(browser);
    page = await context.newPage();
    await page.goto(ready.origin);
    const second = await beginSlow();
    await bounded(browser.close(), "Owned browser close timeout");
    browser = undefined;
    context = undefined;
    await bounded(second.pending, "Browser pending request timeout");
    await message((value) => value.slowClosed === true && value.sequence === second.number);
    await launch();
    const third = await beginSlow();
    await closeController();
    await bounded(third.pending, "Controller pending request timeout");
    await bounded(browser.close(), "Owned final browser close timeout");
    browser = undefined;
    context = undefined;
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    for (const action of [
      async () => {
        if (context) await bounded(context.close(), "Owned cleanup context timeout");
      },
      async () => {
        if (browser) await bounded(browser.close(), "Owned cleanup browser timeout");
      },
      closeController,
    ]) {
      try {
        await action();
      } catch (error) {
        cleanup.push(error);
      }
    }
    // Only captured children are signalled after failed graceful closure. A
    // fallback termination is not a successful browser/controller close ACK.
    if (children.size) {
      cleanup.push(new Error("Owned fixture children needed forced cleanup"));
      for (const child of [...children]) {
        try {
          const close = once(child, "close");
          child.kill("SIGKILL");
          await bounded(close, "Captured child did not exit");
        } catch (error) {
          cleanup.push(error);
        }
      }
    }
  }
  if (cleanup.length)
    throw new AggregateError(
      failed ? [primary, ...cleanup] : cleanup,
      "Owned Chromium fixture cleanup failed",
      { cause: failed ? primary : cleanup[0] },
    );
  if (failed) throw primary;
  return {
    chromium: true,
    cookie: true,
    binary: true,
    ranges: true,
    compression: true,
    redirectsBlocked: true,
    sseBlocked: true,
    opaqueFrameNoInjectedErrors: true,
    opaqueOriginPreserved: true,
    serviceWorkerBlocked: true,
    workerBlocked: true,
    applicationErrorsDetected: true,
    contextInflightClosed: true,
    browserInflightClosed: true,
    controllerInflightClosed: true,
    controllerExited: true,
    chromiumExited: true,
    listenerClosed: true,
    sockets: 0,
    capturedPids,
  };
}

if (mode === "server") {
  const owned = fixtureServer();
  owned.server.listen(0, "127.0.0.1");
  await once(owned.server, "listening");
  process.send({ ready: true, origin: `http://127.0.0.1:${owned.server.address().port}` });
  process.once("message", async () => {
    await owned.close();
    process.send({ closed: true, sockets: 0 }, () => process.disconnect());
  });
} else {
  try {
    const value = mode === "native" ? await native() : await chromium();
    console.log(
      JSON.stringify({
        passed: true,
        preCore6plus4: true,
        bodyLimit: candidateHttpBodyLimit,
        httpDeadline: candidateHttpDeadline,
        ...value,
      }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
