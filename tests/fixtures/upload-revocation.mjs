import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const root = process.argv[2];
// Delay a real filesystem rename to verify revocation waits beyond TCP EOF.
const nativeRename = fsPromises.rename;
const nativeRm = fsPromises.rm;
let renameGate;
let removalGate;
let cleanupFailureVerified = false;
fsPromises.rename = async (...args) => {
  if (args[0] === renameGate?.source) {
    renameGate.enter();
    await renameGate.released;
  }
  return nativeRename(...args);
};
fsPromises.rm = async (...args) => {
  if (args[0] === removalGate?.source) {
    removalGate.enter();
    await removalGate.released;
  }
  return nativeRm(...args);
};
syncBuiltinESMExports();
const { RemoteHostManager } = await import(`${root}/remote-host-manager.js`);
const { TrustedDeviceStore } = await import(`${root}/trusted-device-store.js`);
const { MobileUploadService } = await import(`${root}/mobile-upload-service.js`);
const { WebSocket } = await import(`${root}/node_modules/ws/wrapper.mjs`);
const spool = join(root, "spool");
const uploads = new MobileUploadService({ rootDir: spool, cleanupIntervalMs: 0 });
const devices = new TrustedDeviceStore(join(root, "devices.json"));
const host = new RemoteHostManager({
  devices,
  uploads,
  onClientEvent(event, ws) {
    if (event.type === "attachment.upload.begin")
      ws.send(
        JSON.stringify({
          type: "attachment.upload.ready",
          ...uploads.begin(event.deviceId, event),
        }),
      );
  },
});
const sockets = [];
const requests = [];
let started;
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("upload fixture deadline");
}
async function phone(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws`, {
    headers: { Origin: started.url },
  });
  sockets.push(ws);
  ws.on("error", () => {});
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const exchange = (value) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("phone fixture deadline")), 3000);
      ws.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data));
      });
      ws.send(JSON.stringify(value));
    });
  const paired = await exchange({
    type: "pair.complete",
    token: host.createPairingUrl().token,
    name,
    secretHash: `${name}-secret`,
  });
  assert.equal(paired.type, "pair.ok");
  return { ws, exchange, id: paired.device.id };
}
function upload(ticket, payload, partial = false) {
  let req;
  const done = new Promise((resolve) => {
    req = request(
      new URL(ticket.putUrl, started.url),
      {
        method: "PUT",
        headers: {
          Origin: started.url,
          "content-type": "image/png",
          "content-length": payload.length,
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode }));
        res.on("error", (error) => resolve({ error: error.code }));
      },
    );
    requests.push(req);
    req.on("error", (error) => resolve({ error: error.code }));
    req.setTimeout(5000, () =>
      req.destroy(Object.assign(new Error("upload deadline"), { code: "FIXTURE_TIMEOUT" })),
    );
    if (partial) req.write(payload.subarray(0, 65536));
    else req.end(payload);
  });
  return {
    done,
    finish() {
      if (!req.destroyed) req.end(payload.subarray(65536));
    },
  };
}
const path = (ticket, extension = "upload") => join(spool, `${ticket.uploadId}.${extension}`);
const exists = async (filename) => !!(await stat(filename).catch(() => undefined));
try {
  started = await host.start({ host: "127.0.0.1", port: 0 });
  const first = await phone("first"),
    other = await phone("other");
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x71),
    small = Buffer.alloc(128 * 1024, 0x63);
  async function issue(phone, name, size = small.length) {
    const ticket = await phone.exchange({
      type: "attachment.upload.begin",
      clientId: name,
      name: `${name}.png`,
      mime: "image/png",
      size,
    });
    assert.equal(ticket.type, "attachment.upload.ready");
    return ticket;
  }
  const active = await issue(first, "active", bytes.length),
    pending = await issue(first, "pending"),
    ready = await issue(first, "ready");
  const finalizable = await issue(first, "finalizable"),
    releasable = await issue(first, "releasable"),
    peer = await issue(other, "peer", bytes.length);
  for (const ticket of [ready, finalizable, releasable])
    assert.equal((await upload(ticket, small).done).status, 201);
  const accepted = uploads.claim(first.id, finalizable.uploadId),
    retry = uploads.claim(first.id, releasable.uploadId);
  const running = upload(active, bytes, true),
    otherRunning = upload(peer, bytes, true);
  await until(
    async () =>
      (await stat(path(active, "part")).catch(() => undefined))?.size === 65536 &&
      (await stat(path(peer, "part")).catch(() => undefined))?.size === 65536,
  );
  devices.revoke(first.id);
  host.revokeDevice(first.id);
  await until(() => first.ws.readyState === WebSocket.CLOSED);
  running.finish();
  otherRunning.finish();
  const activeResult = await running.done,
    pendingResult = await upload(pending, small).done;
  console.log(
    JSON.stringify({
      activeResult,
      pendingResult,
      activeSpool: await exists(path(active)),
      pendingSpool: await exists(path(pending)),
    }),
  );
  assert.notEqual(activeResult.error, "FIXTURE_TIMEOUT");
  assert.ok(
    activeResult.error || activeResult.status >= 400,
    "revoked active upload still succeeded",
  );
  assert.equal(pendingResult.status, 404, "unused revoked ticket remained valid");
  await uploads.revokeDevice(first.id); // Await the same cleanup initiated by the Host.
  for (const ticket of [active, pending, ready]) {
    assert.equal(await exists(path(ticket)), false);
    assert.equal(await exists(path(ticket, "part")), false);
    assert.throws(() => uploads.claim(first.id, ticket.uploadId));
  }
  assert.throws(
    () =>
      uploads.begin(first.id, {
        clientId: "late",
        name: "late.png",
        mime: "image/png",
        size: small.length,
      }),
    /revok/i,
  );
  assert.equal((await otherRunning.done).status, 201);
  const peerClaim = uploads.claim(other.id, peer.uploadId);
  assert.deepEqual(await readFile(peerClaim.path), bytes);
  assert.deepEqual(await readFile(accepted.path), small);
  assert.deepEqual(await readFile(retry.path), small);
  await uploads.finalize(first.id, accepted.uploadId, accepted.claimId);
  await uploads.release(first.id, retry.uploadId, retry.claimId);
  assert.equal(await exists(accepted.path), false);
  assert.equal(await exists(retry.path), false, "release must not revive a revoked device ticket");
  assert.throws(() => uploads.claim(first.id, retry.uploadId));
  await uploads.finalize(other.id, peerClaim.uploadId, peerClaim.claimId);
  const next = await issue(other, "still-connected");
  assert.equal((await upload(next, small).done).status, 201);
  const late = await phone("late-rename");
  const ticket = await issue(late, "rename");
  let enter, resume;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const released = new Promise((resolve) => {
    resume = resolve;
  });
  renameGate = { source: path(ticket, "part"), enter, released, resume };
  const renaming = upload(ticket, small);
  await entered;
  devices.revoke(late.id);
  host.revokeDevice(late.id);
  let settled = false;
  const cleanup = uploads.revokeDevice(late.id).then(() => {
    settled = true;
  });
  await delay(25);
  assert.equal(settled, false, "revocation finished while rename could still create a spool");
  resume();
  await cleanup;
  await renaming.done;
  assert.equal(await exists(path(ticket)), false);
  assert.equal(await exists(path(ticket, "part")), false);
  // A real EISDIR unlink failure must not let stop overtake another pending
  // unlink. Both the error and the delayed removal remain observable.
  const broken = await phone("cleanup-error");
  const blocked = await issue(broken, "blocked"),
    delayed = await issue(broken, "delayed");
  await fsPromises.mkdir(path(blocked));
  await fsPromises.writeFile(path(delayed), small);
  let removalEntered, releaseRemoval;
  const enteredRemoval = new Promise((resolve) => {
    removalEntered = resolve;
  });
  const releasedRemoval = new Promise((resolve) => {
    releaseRemoval = resolve;
  });
  removalGate = {
    source: path(delayed),
    enter: removalEntered,
    released: releasedRemoval,
    resume: releaseRemoval,
  };
  let errorReported = false,
    stopFinished = false,
    removalFinished = false;
  host.once("host-error", () => {
    errorReported = true;
  });
  devices.revoke(broken.id);
  host.revokeDevice(broken.id);
  const removal = uploads.revokeDevice(broken.id).then(
    () => {
      removalFinished = true;
      return undefined;
    },
    (error) => {
      removalFinished = true;
      return error;
    },
  );
  await enteredRemoval;
  const stopped = host.stop().then(
    () => {
      stopFinished = true;
      return undefined;
    },
    (error) => {
      stopFinished = true;
      return error;
    },
  );
  await delay(25);
  assert.equal(removalFinished, false, "first unlink failure skipped the delayed unlink");
  assert.equal(stopFinished, false, "stop returned before every cleanup settled");
  assert.equal(errorReported, false);
  releaseRemoval();
  assert.ok(await removal);
  assert.ok(await stopped);
  assert.equal(errorReported, true);
  assert.equal(await exists(path(delayed)), false);
  cleanupFailureVerified = true;
  console.log(
    "PASS device upload revocation; active/pending/ready cleared, accepted claims and other phone isolated",
  );
} finally {
  renameGate?.resume();
  removalGate?.resume();
  for (const req of requests) req.destroy();
  for (const ws of sockets) ws.terminate();
  if (cleanupFailureVerified) {
    await host.stop().catch(() => undefined);
    await uploads.dispose().catch(() => undefined);
  } else {
    await host.stop();
    await uploads.dispose();
  }
  fsPromises.rename = nativeRename;
  fsPromises.rm = nativeRm;
  syncBuiltinESMExports();
}
