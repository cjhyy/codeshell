import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { byteStreamAcceptance } from "./byte-stream.mjs";
import { relayFixture, token, until } from "./relay.mjs";
const root = process.argv[2];
const api = await import(`${root}/index.remote-relay.js`);
const { RemoteHostManager } = await import(`${root}/remote-host-manager.js`);
const { TrustedDeviceStore } = await import(`${root}/trusted-device-store.js`);
const { AccessPasscode } = await import(`${root}/access-passcode.js`);
const { MobileUploadService } = await import(`${root}/mobile-upload-service.js`);
const { WebSocket } = createRequire(`${root}/package.json`)("ws");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=relay-test",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    join(root, "key.pem"),
    "-out",
    join(root, "cert.pem"),
  ],
  { stdio: "ignore" },
);
const cert = await readFile(join(root, "cert.pem"));
const relay = await relayFixture(root, { cert, key: await readFile(join(root, "key.pem")) }, api);
const externalHost = new URL(relay.publicOrigin).host;
const config = {
  relayOrigin: relay.origin,
  credential: relay.credential,
  hostId: relay.hostId,
  publicOrigin: relay.publicOrigin,
  ca: cert,
};
let connector;
let local;
const mobile = join(root, "mobile");
await mkdir(mobile);
await writeFile(join(mobile, "index.html"), "BUILT_MOBILE_ONLY");
const passcode = new AccessPasscode({ filePath: join(root, "passcode.json") });
const devices = new TrustedDeviceStore(join(root, "devices.json"));
const uploads = new MobileUploadService({ rootDir: join(root, "uploads"), cleanupIntervalMs: 0 });
let dispatched = 0;
const host = new RemoteHostManager({
  devices,
  uploads,
  mobileRootDir: mobile,
  mobileDevUrl: "http://127.0.0.1:1",
  onClientEvent: (_event, ws) => {
    dispatched++;
    ws.send(JSON.stringify({ type: "test.dispatched" }));
  },
});
host.on("host-error", () => {});
async function http(path, { headers = {}, method = "GET", body, slow = false } = {}) {
  const { stream } = await relay.open();
  // This connection belongs to one request only. Keep the upstream TCP open
  // until the response is parsed, even when the Host rejects an unread body.
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => stream;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: externalHost,
        path,
        method,
        headers: { Host: externalHost, Connection: "keep-alive", ...headers },
        agent,
      },
      async (res) => {
        try {
          const chunks = [];
          for await (const chunk of res) {
            chunks.push(chunk);
            if (slow) await delay(1);
          }
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.once("close", () => agent.destroy());
    req.end(body);
  });
}
async function phone(headers = {}) {
  const { stream } = await relay.open();
  const ws = new WebSocket(`ws://${externalHost}/ws`, {
    createConnection: () => stream,
    headers: { Host: externalHost, Origin: relay.publicOrigin, ...headers },
  });
  ws.on("error", () => {});
  return ws;
}
async function exchange(ws, message) {
  const reply = once(ws, "message");
  ws.send(JSON.stringify(message));
  return JSON.parse((await reply)[0].toString());
}
try {
  await byteStreamAcceptance(root, { cert, key: await readFile(join(root, "key.pem")) }, api);
  assert.throws(() =>
    api.createDeviceRelayConnector({
      ...config,
      relayOrigin: "http://127.0.0.1",
      localHost: { port: 1, signal: new AbortController().signal, setPublicBaseUrl() {} },
    }),
  );
  assert.throws(() =>
    api.createDeviceRelayConnector({
      ...config,
      publicOrigin: `${relay.publicOrigin}/bad`,
      localHost: { port: 1, signal: new AbortController().signal, setPublicBaseUrl() {} },
    }),
  );
  await assert.rejects(
    host.start({ mode: "relay", host: "0.0.0.0", port: 0 }),
    /initialized access passcode/,
  );
  passcode.set("123456");
  local = await host.start({ mode: "relay", host: "0.0.0.0", port: 0, passcode });
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.mode, "relay");
  assert.throws(() => host.createPairingUrl(), /not configured/);
  assert.throws(() => host.setPublicBaseUrl("http://insecure.test"), /HTTPS/);
  let applied = 0;
  const target = host.relayTarget();
  connector = api.createDeviceRelayConnector({
    ...config,
    localHost: {
      ...target,
      setPublicBaseUrl(origin) {
        applied++;
        target.setPublicBaseUrl(origin);
      },
    },
  });
  connector.start();
  connector.start();
  await until(() => relay.current?.ready);
  assert.equal(applied, 1);
  assert.equal(relay.records.length, 1);
  assert.ok(host.createPairingUrl().url.startsWith(relay.publicOrigin + "/mobile?pairing="));
  assert.equal((await http("/health")).status, 401);
  const granted = await http("/health", { headers: { "x-access-passcode": "123456" } });
  // The Host-issued cookie remains host-only and belongs to the phone, not the directory.
  assert.equal(granted.status, 200);
  const cookie = granted.headers["set-cookie"][0].split(";")[0];
  assert.ok(!granted.headers["set-cookie"][0].includes("Domain="));
  assert.equal(
    (await http("/mobile/", { headers: { Cookie: cookie } })).body.toString(),
    "BUILT_MOBILE_ONLY",
  );
  for (const headers of [
    { Cookie: cookie, Origin: "https://wrong.test" },
    { Origin: relay.publicOrigin },
  ]) {
    const ws = await phone(headers);
    const status = new Promise((resolve) =>
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode);
        res.destroy();
        ws.terminate();
      }),
    );
    assert.equal(await status, headers.Cookie ? 403 : 401);
  }
  const first = await phone({ Cookie: cookie });
  await once(first, "open");
  assert.equal((await exchange(first, { type: "session.list" })).type, "auth.failed");
  assert.equal(dispatched, 0);
  const paired = await exchange(first, {
    type: "pair.complete",
    token: host.createPairingUrl().token,
    name: "Phone one",
    secretHash: "phone-one-secret",
  });
  assert.equal(paired.type, "pair.ok", JSON.stringify(paired));
  const second = await phone({ Cookie: cookie });
  await once(second, "open");
  const pairedTwo = await exchange(second, {
    type: "pair.complete",
    token: host.createPairingUrl().token,
    name: "Phone two",
    secretHash: "phone-two-secret",
  });
  assert.equal(pairedTwo.type, "pair.ok");
  assert.notEqual(paired.device.id, pairedTwo.device.id);
  assert.equal((await exchange(first, { type: "session.list" })).type, "test.dispatched");
  assert.equal((await exchange(second, { type: "session.list" })).type, "test.dispatched");
  const payload = Buffer.alloc(350_123, 0x68);
  const ticket = uploads.begin(paired.device.id, {
    clientId: "attachment-1",
    name: "test.png",
    mime: "image/png",
    size: payload.length,
  });
  const uploaded = await http(ticket.putUrl, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "Content-Type": "image/png",
      "Content-Length": String(payload.length),
    },
    body: payload,
  });
  assert.equal(uploaded.status, 201);
  const claim = uploads.claim(paired.device.id, ticket.uploadId);
  assert.deepEqual(await readFile(claim.path), payload);
  await uploads.release(paired.device.id, ticket.uploadId, claim.claimId);
  const firstClosed = once(first, "close");
  devices.revoke(paired.device.id);
  host.revokeDevice(paired.device.id);
  await firstClosed;
  assert.equal((await exchange(second, { type: "session.list" })).type, "test.dispatched");
  const secondClosed = once(second, "close");
  const records = relay.records.length;
  relay.current.ws.terminate();
  await secondClosed;
  await until(() => relay.records.length > records && relay.current.ready);
  assert.equal(dispatched, 3); // Reconnect did not replay any phone action.
  // Stop the actual Host without manually closing the connector, then reuse
  // the exact port for a different service. Revoked authority must not survive.
  const openBeforeStop = await relay.open();
  const stoppedStream = once(openBeforeStop.stream, "close");
  openBeforeStop.stream.resume();
  const hostStop = host.stop();
  assert.ok(target.signal.aborted);
  assert.throws(() => target.setPublicBaseUrl(relay.publicOrigin));
  assert.throws(() => connector.start());
  await hostStop;
  await stoppedStream;
  let reusedHits = 0;
  const reused = createServer((_req, res) => {
    reusedHits++;
    res.end("unrelated service");
  });
  await new Promise((resolve) => reused.listen(local.port, "127.0.0.1", resolve));
  try {
    const beforeReuse = relay.records.length;
    await delay(650);
    assert.equal(relay.records.length, beforeReuse);
    assert.equal(reusedHits, 0);
    assert.equal(relay.current.ready, false);
  } finally {
    await new Promise((resolve) => reused.close(resolve));
  }
  await connector.close();
  await uploads.dispose();
  console.log("PASS actual Host passcode/origin/pairing/revocation/upload and reconnect isolation");

  // Exercise raw HTTP streaming independently of route policy.
  const large = Buffer.alloc(5 * 1024 * 1024 + 117, 0x93);
  let writes = 0;
  const plain = createServer((req, res) => {
    if (req.url === "/reject-upload") {
      // Reject before consuming the body. The one-use client must parse this
      // final response before closing its still-writing connection.
      res.writeHead(404, { "Content-Length": 17 });
      res.end("ticket is revoked");
      return;
    }
    if (req.url === "/truncated-response") {
      res.writeHead(404, { "Content-Length": 1024 });
      res.write("short");
      setImmediate(() => res.destroy());
      return;
    }
    if (req.url === "/write") {
      writes++;
      res.destroy();
      return;
    }
    if (req.headers.range) {
      res.writeHead(206, { "Content-Range": `bytes 23-1023/${large.length}` });
      res.end(large.subarray(23, 1024));
      return;
    }
    res.end(large);
  });
  await new Promise((resolve) => plain.listen(0, "127.0.0.1", resolve));
  try {
    connector = api.createDeviceRelayConnector({
      ...config,
      localHost: {
        port: plain.address().port,
        signal: new AbortController().signal,
        setPublicBaseUrl() {},
      },
    });
    connector.start();
    await until(() => relay.current?.ready);
    const rejectedBody = Buffer.alloc(4 * 1024 * 1024);
    const concurrent = await relay.open();
    concurrent.stream.write(
      `GET /large HTTP/1.1\r\nHost: ${externalHost}\r\nConnection: close\r\n\r\n`,
    );
    await delay(50);
    for (let index = 0; index < 12; index++) {
      const pending = http("/reject-upload", {
        method: "PUT",
        headers: { "Content-Length": String(rejectedBody.length) },
        body: rejectedBody,
      });
      if (index === 4) {
        const closed = once(concurrent.stream, "close");
        concurrent.stream.destroy();
        await closed;
      }
      const early = await pending;
      assert.equal(early.status, 404, `early response ${index}`);
      assert.equal(early.body.toString(), "ticket is revoked");
    }
    await assert.rejects(http("/truncated-response"));
    console.log("PASS 12 early HTTP rejections, concurrent cancellation and truncated response");
    assert.deepEqual((await http("/large", { slow: true })).body, large);
    assert.deepEqual(
      (await http("/large", { headers: { Range: "bytes=23-1023" } })).body,
      large.subarray(23, 1024),
    );
    assert.ok(relay.maxFrame <= api.RELAY_DATA_CHUNK_BYTES);
    assert.ok(relay.dataFrames > 100);
    const { stream: blocked } = await relay.open();
    blocked.write(`GET /large HTTP/1.1\r\nHost: ${externalHost}\r\nConnection: close\r\n\r\n`);
    await delay(150);
    assert.ok(
      blocked.readableLength <= 2 * api.RELAY_DATA_MAX_BYTES,
      "slow consumer buffers stay bounded",
    );
    const cancelled = once(blocked, "close");
    blocked.destroy();
    await cancelled;
    assert.equal((await http("/range", { headers: { Range: "bytes=23-1023" } })).status, 206);
    await assert.rejects(http("/write", { method: "POST", body: "one action" }));
    const prior = relay.records.length;
    relay.current.ws.terminate();
    await until(() => relay.records.length > prior && relay.current.ready);
    await delay(50);
    assert.equal(writes, 1);
    // A relay-provided target cannot redirect the connector's fixed local port.
    const { stream } = await relay.open({ target: "http://127.0.0.1:1", localPort: 1 });
    stream.write(
      `GET /range HTTP/1.1\r\nHost: ${externalHost}\r\nRange: bytes=23-1023\r\nConnection: close\r\n\r\n`,
    );
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).includes("206"));
    // Wrong lease fences the entire old control and its open data streams.
    const held = await relay.open();
    held.stream.resume();
    const dead = once(held.stream, "close");
    const before = relay.records.length;
    relay.send({ type: "open", v: 1, leaseId: token(), streamId: token(), ticket: token() });
    await dead;
    await until(() => relay.records.length > before && relay.current.ready);
    // Invalid text/oversized binary frames close only their data stream.
    for (const data of ["not binary", Buffer.alloc(api.RELAY_DATA_MAX_BYTES + 1)]) {
      const bad = await relay.open();
      bad.stream.resume();
      const closed = once(bad.stream, "close");
      bad.ws.send(data);
      await closed;
      assert.ok(relay.current.ready);
    }
    await until(() => relay.current.streams.size === 0);
    // Limit applies before opening a 33rd TCP or data connection.
    const slots = await Promise.all(
      Array.from({ length: api.RELAY_MAX_STREAMS }, () => relay.open()),
    );
    const failed = relay.failed;
    void relay.open();
    await until(() => relay.failed > failed);
    for (const slot of slots) slot.stream.destroy();
    await connector.close();
    console.log(
      "PASS large final response/Range/slow reader/cancel/concurrency/fixed target/no replay",
    );
  } finally {
    await connector.close();
    plain.closeAllConnections();
    await new Promise((resolve) => plain.close(resolve));
  }

  // A disconnected observer can close synchronously without leaving a retry
  // timer created after close() already cleared the previous timer.
  let observedClose;
  const idleTarget = {
    port: local.port,
    signal: new AbortController().signal,
    setPublicBaseUrl() {},
  };
  connector = api.createDeviceRelayConnector({
    ...config,
    localHost: idleTarget,
    onState(state) {
      if (state === "disconnected") observedClose = connector.close();
    },
  });
  const observerCount = relay.records.length;
  connector.start();
  await until(() => relay.records.length > observerCount && relay.current.ready);
  relay.current.ws.terminate();
  await until(() => observedClose);
  await observedClose;
  await delay(650);
  assert.equal(relay.records.length, observerCount + 1);
  // Without the explicit private CA, real TLS verification must reject this
  // relay before any computer credential reaches an HTTP upgrade handler.
  observedClose = undefined;
  connector = api.createDeviceRelayConnector({
    ...config,
    ca: undefined,
    localHost: idleTarget,
    onState(state) {
      if (state === "disconnected") observedClose = connector.close();
    },
  });
  connector.start();
  await until(() => observedClose);
  await observedClose;
  assert.equal(relay.records.length, observerCount + 1);
  console.log("PASS observer cancellation does not reconnect; untrusted TLS rejected");

  // Enrollment mismatch must never install a public origin or become ready.
  relay.welcomeOverride = { publicOrigin: "https://attacker.test" };
  let changed = false;
  connector = api.createDeviceRelayConnector({
    ...config,
    localHost: {
      port: local.port,
      signal: new AbortController().signal,
      setPublicBaseUrl() {
        changed = true;
      },
    },
  });
  const count = relay.records.length;
  connector.start();
  await until(
    () => relay.records.length > count && relay.current.ws.readyState === WebSocket.CLOSED,
  );
  assert.equal(changed, false);
  await connector.close();
  relay.welcomeOverride = undefined;
  relay.handshakeDelay = true;
  connector = api.createDeviceRelayConnector({
    ...config,
    localHost: {
      port: local.port,
      signal: new AbortController().signal,
      setPublicBaseUrl() {
        changed = true;
      },
    },
  });
  const waiting = relay.records.length;
  connector.start();
  await until(() => relay.records.length > waiting);
  const old = relay.current;
  await connector.close();
  old.ws.send(
    JSON.stringify({
      type: "welcome",
      v: 1,
      hostId: relay.hostId,
      publicOrigin: relay.publicOrigin,
      leaseId: old.leaseId,
    }),
    () => {},
  );
  await delay(650);
  assert.equal(changed, false);
  assert.equal(relay.records.length, waiting + 1);
  console.log("PASS enrollment mismatch/close generation/stale welcome/no post-close reconnect");
  console.log("PASS device relay native acceptance");
} finally {
  await connector?.close();
  await host.stop();
  await uploads.dispose();
  await relay.close();
}
