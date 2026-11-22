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
const cipher = {
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
};
const store = new DeviceRelayStore(storePath, cipher);
const hostId = randomUUID(),
  credential = randomBytes(32).toString("base64url");
const ticket = randomBytes(32).toString("base64url"),
  publicOrigin = `https://${hostId}.devices.test`;
const accountId = randomUUID(),
  rootToken = randomBytes(32).toString("base64url"),
  refresh = randomBytes(32).toString("base64url");
let accountEnrollments = 0;
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
    assert.equal(req.headers.origin, origin);
    if (req.url === "/api/v1/account/status") {
      assert.equal(req.headers.authorization, undefined);
      res.end(
        JSON.stringify({
          registrationAllowed: false,
          githubEnabled: false,
          relay: {
            enabled: true,
            directoryOrigin: origin,
            protocolVersion: 1,
            accountHandoffVersion: 1,
          },
        }),
      );
      return;
    }
    if (req.url === "/api/v1/remote-hosts/ensure") {
      assert.equal(req.headers.authorization, "Bearer " + rootToken);
      let body = "";
      for await (const chunk of req) body += chunk;
      const { environmentId } = JSON.parse(body);
      assert.equal(environmentId, expectedIdentity);
      accountEnrollments++;
      res.end(
        JSON.stringify({
          hostId,
          environmentId,
          publicOrigin,
          credential,
          credentialEpoch: 1,
          protocolVersion: 1,
          accountId,
          refreshToken: refresh,
          credentialExpiresAt: Date.now() + 600_000,
        }),
      );
      return;
    }
    assert.equal(req.url, "/api/v1/remote-hosts/enroll");
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
const deps = {
  host,
  passcode,
  store,
  environmentDir: join(root, "environment"),
  binary: { ensureBinary: async () => {} },
  tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false },
  changed: (value) => states.push({ ...value, hostRunning: !!host.status() }),
};
const { startHostedMobile } = await import(`${root}/mobile-relay-hosted.js`);
const startHost = (account) => startHostedMobile(root, storePath, cipher, deps, account);
let hosted = process.argv[3] === "desktop-host" ? await startHost() : undefined;
let controller = hosted?.controller ?? new MobileRemoteController(deps);
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
  if (hosted) {
    await host.stop();
    await until(() => controller.relayStatus().state === "stopped");
    await controller.start({ mode: "relay" });
    await hosted.terminate();
    await until(() => !host.status());
    hosted = await startHost();
    controller = hosted.controller;
    await until(() => controller.relayStatus().registered);
    await controller.start({ mode: "relay" });
  }
  await controller.stop();
  assert.equal(host.status(), undefined);
  assert.equal(controller.relayStatus().registered, true);
  await controller.start({ mode: "relay" });
  authStatus = 401;
  for (const ws of controls) ws.terminate();
  await until(
    () =>
      controller.relayStatus().state === "unauthorized" &&
      states.at(-1)?.state === "unauthorized" &&
      states.at(-1).hostRunning === false &&
      !host.status(),
  );
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
  if (hosted) {
    await hosted.terminate();
    responseMode = "normal";
    authStatus = 0;
    const saved = {
      origin,
      account: { id: accountId, username: "fixture" },
      kind: "account",
      accessToken: rootToken,
      refreshToken: randomBytes(32).toString("base64url"),
      sessionId: randomUUID(),
      accessTokenExpiresAt: Date.now() + 600_000,
      refreshTokenExpiresAt: Date.now() + 3_600_000,
    };
    const identity = { origin, accountId };
    hosted = await startHost(saved);
    controller = hosted.controller;
    await controller.activateAccountRelay(identity, () => true);
    assert.equal(controller.relayStatus().accountId, accountId);
    assert.equal(controller.relayStatus().remoteAccessEnabled, false);
    assert.equal(host.status(), undefined, "sign-in alone cannot turn on remote access");
    let entered, release;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    deps.beforeSeal = () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      });
    const document = new AbortController();
    const stale = controller.start({ mode: "relay" }, document.signal);
    const rejected = assert.rejects(stale);
    await waiting;
    document.abort();
    release();
    await rejected;
    delete deps.beforeSeal;
    assert.equal(
      store.load().remoteAccessEnabled,
      false,
      "a removed document cannot opt into remote access",
    );
    assert.equal(host.status(), undefined);
    await controller.start({ mode: "relay" });
    assert.equal(controller.relayStatus().remoteAccessEnabled, true);
    await hosted.terminate();
    await until(() => !host.status());
    hosted = await startHost(saved);
    controller = hosted.controller;
    await controller.activateAccountRelay(identity, () => true);
    assert.equal(controller.relayStatus().state, "ready");
    assert.equal(host.status().mode, "relay");
    assert.equal(
      accountEnrollments,
      1,
      "restart reuses the encrypted registration and explicit opt-in",
    );
    for (const secret of [rootToken, credential, refresh])
      assert.ok(!JSON.stringify(states).includes(secret));
    await controller.retireAccountRelay(identity);
    assert.equal(host.status(), undefined);
    assert.equal(existsSync(storePath), false);
  }
  console.log(
    "PASS desktop relay TLS lifecycle: enrollment, same environment identity, ciphertext, passcode, restart, 401 revoke, bounded/no-redirect request and stop during enrollment",
  );
} finally {
  try {
    await controller.dispose();
  } finally {
    await hosted?.terminate();
  }
  await uploads.dispose();
  for (const ws of controls) ws.terminate();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
