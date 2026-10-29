/* Electron Node-mode half of smoke-mobile-asar.mjs; not a standalone entry.
 *
 * Runs with ELECTRON_RUN_AS_NODE so Electron's ASAR-aware fs is active while
 * no window, profile, single-instance lock, updater or app entry is loaded.
 * Production modules arrive pre-bundled from the source tree in <bundleDir>.
 * Only loopback origins created here are reachable. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import { extname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [bundleDir, configJson] = process.argv.slice(2);
const config = JSON.parse(configJson);
assert.ok(process.versions.electron, "must run under Electron's ASAR-aware fs");
const load = (name) => import(pathToFileURL(join(bundleDir, `${name}.js`)).href);
// Install the loopback guard before any producer module is evaluated.
const { installFixtureNetworkGuard } = await load("network-fixture");
const guard = installFixtureNetworkGuard();
const { serveMobile } = await load("mobile-static");
const { resolveMobileStaticRoot } = await load("mobile-static-root");
const { RemoteHostManager } = await load("remote-host-manager");
const { AccessPasscode } = await load("access-passcode");

const FAKE_PASSCODE = "smoke-fake-passcode";
const PAIRING = "fake-pairing";
const html = { accept: "text/html" };
const servers = [];

async function plainHost(rootDir) {
  const server = http.createServer((req, res) => {
    if (/^\/mobile(?:[/?#]|$)/.test(req.url ?? "")) serveMobile(req, res, { rootDir });
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  guard.allowOrigin(origin);
  return origin;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** One request that does not follow redirects. The fixture guard only lets
 *  fetch run with redirect:"error", so 3xx responses are observed through the
 *  guarded http.request (resolved at call time, default agent, allowed
 *  loopback origin only), bounded in time and size. `path` is sent verbatim. */
function request(origin, path, { method = "GET", headers = {} } = {}) {
  return new Promise((done, fail) => {
    const req = http.request(origin, {
      method,
      path,
      headers: { ...headers, connection: "close" },
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`timeout: ${path}`)));
    req.on("error", fail);
    req.on("response", (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error(`response too large: ${path}`));
        else chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => {
        const header = (name) => {
          const value = res.headers[name.toLowerCase()];
          return value === undefined ? null : Array.isArray(value) ? value.join(", ") : value;
        };
        done({ status: res.statusCode, header, body: Buffer.concat(chunks) });
      });
    });
    req.end();
  });
}

/** Send one raw request (targets fetch would normalize, or an upgrade). */
function raw(origin, head) {
  const { hostname, port } = new URL(origin);
  return new Promise((done, fail) => {
    const socket = connect({ host: hostname, port: Number(port) });
    let text = "";
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error("raw request timeout")));
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_RESPONSE_BYTES) socket.destroy(new Error("raw response too large"));
    });
    socket.on("error", (error) => (text ? done(text) : fail(error)));
    socket.on("close", () => done(text));
    socket.on("connect", () => socket.write(`${head}\r\nHost: localhost\r\n\r\n`));
  });
}

const bytes = async (response) => Buffer.from(await response.arrayBuffer());
const onDisk = (root, ref) => readFileSync(join(root, ...ref.slice("/mobile/".length).split("/")));

/** Asset URLs the built index.html references under the routed prefix. */
function assetRefs(page) {
  const refs = [...page.matchAll(/(?:src|href)="(\/mobile\/[^"?#]+)"/g)].map((m) => m[1]);
  return [...new Set(refs)].filter((ref) => ref !== "/mobile/").sort();
}

async function checkStaticDelivery(root) {
  const origin = await plainHost(root);
  const entry = await request(origin, `/mobile?pairing=${PAIRING}`, { headers: html });
  assert.equal(entry.status, 308);
  assert.equal(entry.header("location"), `/mobile/?pairing=${PAIRING}`);
  const index = await fetch(`${origin}/mobile/?pairing=${PAIRING}`, {
    headers: html,
    redirect: "error",
  });
  assert.equal(index.status, 200, "mobile index.html");
  assert.match(index.headers.get("content-type"), /^text\/html/);
  assert.equal(index.headers.get("cache-control"), "no-store");
  const page = await bytes(index);
  assert.ok(page.equals(readFileSync(join(root, "index.html"))), "index bytes match the build");
  const refs = assetRefs(page.toString("utf8"));
  assert.ok(
    refs.some((ref) => ref.endsWith(".js")),
    "index references a JS bundle",
  );
  assert.ok(
    refs.some((ref) => ref.endsWith(".css")),
    "index references a stylesheet",
  );
  const kinds = { ".js": /^text\/javascript/, ".mjs": /^text\/javascript/, ".css": /^text\/css/ };
  for (const ref of refs) {
    const response = await fetch(origin + ref, { redirect: "error" });
    assert.equal(response.status, 200, ref);
    const pattern = kinds[extname(ref)];
    if (pattern) assert.match(response.headers.get("content-type"), pattern, ref);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", ref);
    assert.ok((await bytes(response)).equals(onDisk(root, ref)), `bytes match: ${ref}`);
    // The ETag is derived from real dev/ino/size/mtime/ctime; it must be stable
    // across requests and revalidate. (ASAR's synthetic stat could not.)
    const etag = response.headers.get("etag");
    assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/, ref);
    const again = await fetch(origin + ref, { redirect: "error" });
    assert.equal(again.headers.get("etag"), etag, `stable etag: ${ref}`);
    await again.arrayBuffer();
    const revalidated = await fetch(origin + ref, {
      headers: { "if-none-match": etag },
      redirect: "error",
    });
    assert.equal(revalidated.status, 304, `revalidates: ${ref}`);
    assert.equal((await bytes(revalidated)).length, 0);
  }
  const missing = await fetch(`${origin}/mobile/assets/smoke-missing.js`, { redirect: "error" });
  assert.equal(missing.status, 404);
  for (const target of [
    "/mobile/../../app.asar",
    "/mobile/../../../outside-secret.txt",
    "/mobile/..%2f..%2fapp.asar",
    "/mobile/assets/../../index.html/../../app.asar",
  ]) {
    const response = await raw(origin, `GET ${target} HTTP/1.1\r\nConnection: close`);
    assert.match(response, /^HTTP\/1\.1 404 /, target);
  }
  let symlinkBlocked = "not-applicable";
  if (config.symlinkProbe) {
    const escaped = await fetch(`${origin}/mobile/escape.txt`, { redirect: "error" });
    assert.equal(escaped.status, 404, "in-root symlink to outside bytes");
    assert.ok(!(await escaped.text()).includes("private bytes"));
    symlinkBlocked = true;
  }
  return { origin, refs, symlinkBlocked };
}

async function checkAuthBoundary(root, refs, indexBytes) {
  const passcode = new AccessPasscode({ filePath: config.passcodeFile });
  passcode.set(FAKE_PASSCODE);
  const unused = () => {
    throw new Error("device store is outside the HTTP boundary smoke");
  };
  const host = new RemoteHostManager({
    devices: { addDevice: unused, authenticate: unused },
    onClientEvent: unused,
    mobileRootDir: root,
  });
  host.on("host-error", (error) => {
    throw error;
  });
  const started = await host.start({ mode: "tunnel", host: "127.0.0.1", port: 0, passcode });
  guard.allowOrigin(started.url);
  const url = started.url;
  try {
    const marker = (response) => response.header("x-codeshell-access");
    const protectedBytes = [indexBytes, onDisk(root, refs[0])];
    for (const [target, headers] of [
      ["/", {}],
      [`/?pairing=${PAIRING}`, html],
      [`/mobile/?pairing=${PAIRING}`, html],
      [refs[0], {}],
      ["/health", {}],
    ]) {
      const response = await request(url, target, { headers });
      assert.equal(response.status, 401, `anonymous ${target}`);
      assert.equal(marker(response), "denied");
      assert.equal(response.header("location"), null);
      assert.equal(response.header("set-cookie"), null);
      for (const value of protectedBytes)
        assert.ok(!response.body.includes(value), `anonymous ${target} must not return app bytes`);
    }
    const wrong = await request(url, `/mobile/?pairing=${PAIRING}`, {
      headers: { ...html, "X-Access-Passcode": "wrong-passcode" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(marker(wrong), "denied");
    assert.equal(wrong.header("set-cookie"), null);
    const upgrade = await raw(
      url,
      "GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c21va2UtZmFrZS1rZXk=",
    );
    assert.match(upgrade, /^HTTP\/1\.1 401 /, "anonymous WebSocket upgrade");

    const granted = await request(url, `/?pairing=${PAIRING}`, {
      headers: { ...html, "X-Access-Passcode": FAKE_PASSCODE },
    });
    assert.equal(granted.status, 302);
    assert.equal(granted.header("location"), `/mobile/?pairing=${PAIRING}`);
    assert.equal(marker(granted), "granted");
    const cookie = granted.header("set-cookie")?.split(";")[0];
    assert.match(cookie ?? "", /^cs_access=/);
    const page = await request(url, `/mobile/?pairing=${PAIRING}`, {
      headers: { ...html, cookie },
    });
    assert.equal(page.status, 200);
    assert.equal(marker(page), "granted");
    assert.ok(page.body.equals(indexBytes), "authorized index bytes");
    for (const ref of refs) {
      const asset = await request(url, ref, { headers: { cookie } });
      assert.equal(asset.status, 200, `authorized ${ref}`);
      assert.ok(asset.body.equals(onDisk(root, ref)), `authorized bytes ${ref}`);
    }
    for (const target of ["//evil.example/", "//evil.example/?pairing=x"]) {
      const response = await request(url, target, { headers: { cookie } });
      assert.equal(response.status, 404, target);
      assert.equal(response.header("location"), null, target);
    }
    return { anonymousDenied: 5, wrongPasscodeDenied: true, websocketDenied: true };
  } finally {
    await host.stop();
  }
}

try {
  const root = resolveMobileStaticRoot(join(config.resources, "app.asar", "out", "main"));
  assert.equal(root, config.expectedRoot);
  assert.ok(!root.split(sep).includes("app.asar"), "served root must be outside the archive");
  const delivered = await checkStaticDelivery(root);
  const auth = await checkAuthBoundary(
    root,
    delivered.refs,
    readFileSync(join(root, "index.html")),
  );

  let legacyArchiveIndexStatus = "not-run";
  if (config.legacyResources) {
    // 0.9.48 layout, recorded for comparison: the archive lists index.html,
    // and Electron's fs reads it, but serving it from the archive path fails.
    const archived = join(config.legacyResources, "app.asar", "out", "mobile");
    assert.ok(readFileSync(join(archived, "index.html"), "utf8").length > 0);
    const origin = await plainHost(archived);
    const response = await fetch(`${origin}/mobile/`, { headers: html, redirect: "error" });
    legacyArchiveIndexStatus = response.status;
    await response.arrayBuffer();
  }
  console.log(
    JSON.stringify({
      mode: config.mode,
      electron: process.versions.electron,
      servedRootOutsideArchive: true,
      indexAndAssets: delivered.refs.length + 1,
      revalidated304: delivered.refs.length,
      traversalBlocked: 4,
      symlinkBlocked: delivered.symlinkBlocked,
      ...auth,
      legacyArchiveIndexStatus,
    }),
  );
} finally {
  for (const server of servers) {
    await new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    });
  }
  guard.restore();
}
