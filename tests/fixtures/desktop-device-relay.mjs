import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = process.argv[2];
const { MobileRemoteController } = await import(`${root}/mobile-remote-controller.js`);
const { DeviceRelayStore } = await import(`${root}/device-relay-store.js`);
const { enrollRelayComputer } = await import(`${root}/device-relay-enrollment.js`);
const { RemoteHostManager, AccessPasscode, TrustedDeviceStore, MobileUploadService } = await import(
  `${root}/index.mobile-remote.js`
);
const { WebSocketServer } = createRequire(`${root}/package.json`)("ws");
const key = randomBytes(32);
const storePath = join(root, "private", "relay.enc");
const store = new DeviceRelayStore(storePath, {
  available: () => true,
  encrypt(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decrypt(value) {
    const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
  },
});
const hostId = randomUUID(),
  credential = randomBytes(32).toString("base64url");
const ticket = randomBytes(32).toString("base64url"),
  publicOrigin = `https://${hostId}.devices.test`;
const sockets = new Set(),
  controls = new Set();
const wss = new WebSocketServer({ noServer: true });
let authStatus = 0,
  postCount = 0,
  expectedIdentity;
let responseMode = "normal";
const server = createServer(
  { cert: await readFile(join(root, "cert.pem")), key: await readFile(join(root, "key.pem")) },
  async (req, res) => {
    postCount++;
    assert.equal(req.url, "/api/v1/remote-hosts/enroll");
    assert.equal(req.headers.origin, origin);
    if (responseMode === "redirect") {
      res.writeHead(307, { Location: "https://unexpected.invalid" });
      res.end();
      return;
    }
    if (responseMode === "oversize") {
      res.end("x".repeat(32_768));
      return;
    }
    if (responseMode === "wait") return;
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.ticket, ticket);
    expectedIdentity = data.environmentId;
    res.writeHead(201, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        hostId,
        publicOrigin,
        environmentId: data.environmentId,
        credential,
        credentialEpoch: 1,
        protocolVersion: 1,
      }),
    );
  },
);
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
server.on("upgrade", (req, socket, head) => {
  assert.equal(req.headers.authorization, `Bearer ${credential}`);
  if (authStatus) {
    socket.end(`HTTP/1.1 ${authStatus} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    controls.add(ws);
    ws.on("error", () => {});
    ws.on("close", () => controls.delete(ws));
    ws.send(
      JSON.stringify({
        type: "welcome",
        v: 1,
        hostId,
        publicOrigin,
        leaseId: randomBytes(32).toString("base64url"),
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `https://127.0.0.1:${server.address().port}`;
const mobile = join(root, "mobile");
await mkdir(mobile);
await writeFile(join(mobile, "index.html"), "mobile");
const uploads = new MobileUploadService({ rootDir: join(root, "uploads"), cleanupIntervalMs: 0 });
const host = new RemoteHostManager({
  devices: new TrustedDeviceStore(join(root, "devices.json")),
  uploads,
  mobileRootDir: mobile,
  onClientEvent() {},
});
const passcode = new AccessPasscode({ filePath: join(root, "passcode.json") });
const states = [];
const controller = new MobileRemoteController({
  host,
  passcode,
  store,
  environmentDir: join(root, "environment"),
  binary: { ensureBinary: async () => {} },
  tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false },
  changed: (value) => states.push({ ...value, hostRunning: !!host.status() }),
});
async function until(predicate) {
  for (let i = 0; i < 600; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("state timeout");
}
try {
  const input = { relayOrigin: origin, ticket, name: "Desktop integration" };
  assert.equal(controller.relayStatus().state, "unregistered");
  const registered = await controller.enroll(input, () => true);
  assert.equal(registered.state, "stopped");
  assert.equal(registered.registered, true);
  assert.equal(JSON.stringify(registered).includes(credential), false);
  assert.equal((await readFile(storePath)).includes(Buffer.from(credential)), false);
  assert.equal(
    JSON.parse(await readFile(join(root, "environment", "environment.json"))).id,
    expectedIdentity,
  );
  await assert.rejects(controller.start({ mode: "relay" }), /口令/);
  passcode.set("123456");
  const started = await controller.start({ mode: "relay" });
  assert.equal(started.url, publicOrigin);
  assert.ok(started.pairingUrl.startsWith(publicOrigin + "/mobile?pairing="));
  assert.equal(host.status().host, "127.0.0.1");
  assert.equal(controller.relayStatus().state, "ready");
  await controller.stop();
  assert.equal(host.status(), undefined);
  assert.equal(controller.relayStatus().registered, true);
  await controller.start({ mode: "relay" });
  authStatus = 401;
  for (const ws of controls) ws.terminate();
  await until(() => controller.relayStatus().state === "unauthorized" && !host.status());
  assert.equal(existsSync(storePath), false);
  assert.equal(controller.relayStatus().registered, false);
  assert.equal(
    states.at(-1).hostRunning,
    false,
    "final revoke event must reflect the stopped Host",
  );
  assert.ok(states.some((state) => state.state === "disconnected"));
  assert.equal(JSON.stringify(states).includes(credential), false);
  for (const mode of ["redirect", "oversize"]) {
    responseMode = mode;
    const count = postCount;
    await assert.rejects(enrollRelayComputer(input, randomUUID(), new AbortController().signal));
    assert.equal(postCount, count + 1);
  }
  responseMode = "wait";
  const enrolling = controller.enroll(input, () => true);
  const failure = assert.rejects(enrolling);
  const count = postCount;
  await until(() => postCount > count);
  await controller.stop();
  await failure;
  assert.equal(controller.relayStatus().registered, false);
  assert.equal(existsSync(storePath), false);
  console.log(
    "PASS desktop relay TLS lifecycle: enrollment, same environment identity, ciphertext, passcode, restart, 401 revoke, bounded/no-redirect request and stop during enrollment",
  );
} finally {
  await controller.dispose();
  await uploads.dispose();
  for (const ws of controls) ws.terminate();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
