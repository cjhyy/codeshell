import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd(), evidence = dirname(fileURLToPath(import.meta.url));
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-native-smoke-"))
  throw new Error("Use run-isolated-node-smoke.mjs");
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard(origin);
// ws's stock netConnect property would be rejected as a custom HTTP transport.
// For this exact loopback endpoint only, use Node's ordinary HTTP connector.
// The existing guard still validates origin and rejects all other custom I/O.
const guardedHttpRequest = http.request;
http.request = function (input, ...args) {
  if (input && typeof input === "object" && input.createConnection?.name === "netConnect" &&
      (input.hostname ?? input.host) === "127.0.0.1" && String(input.port) === String(port) && !input.agent && !input.lookup && !input.socketPath) {
    const { createConnection: _stockConnector, ...ordinary } = input;
    return guardedHttpRequest.call(this, ordinary, ...args);
  }
  return guardedHttpRequest.call(this, input, ...args);
};
syncBuiltinESMExports();
// No Core, Host, worker, settings or provider import precedes the exact-origin guard.
const { RemoteHostManager } = await import(`${repo}/packages/server/dist/mobile-remote/remote-host-manager.js`);
const { TrustedDeviceStore } = await import(`${repo}/packages/server/dist/mobile-remote/trusted-device-store.js`);
const { WebSocket: WS } = await import(`${repo}/packages/server/node_modules/ws/wrapper.mjs`);
const dir = mkdtempSync(join(tmpdir(), "owned-outbound-"));
const store = new TrustedDeviceStore(join(dir, "devices.json"));
const device = store.addDevice({ name: "owned-native-device", secretHash: "owned-native-secret" });
const events = [], offline = [], clients = [], observations = [];
let assertions = 0;
const check = (value, message) => { assertions++; assert.ok(value, message); };
const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
async function until(predicate, label, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`); await delay(5); }
}
const host = new RemoteHostManager({ devices: store, outputJournal: true, onClientEvent: (event) => { events.push(event); } });
host.on("viewer-offline", (identity) => offline.push(identity));
const timer = setTimeout(() => { console.error("Native fixture hard deadline"); for (const ws of clients) ws.terminate(); void host.stop().finally(() => { process.exitCode = 1; }); }, 12000);
async function connect(secret = "owned-native-secret") {
  const url = `${origin.replace(/^http/, "ws")}/ws`;
  if (new URL(url.replace(/^ws/, "http")).origin !== origin) throw new Error("Non-fixture WS");
  const client = new WS(url, { perMessageDeflate: false });
  clients.push(client);
  let auth, streamFrames = 0;
  const small = [];
  client.on("error", (error) => console.error("owned socket error", error.message));
  client.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "session.stream") streamFrames++;
    else small.push(message);
    if (["auth.ok", "auth.failed"].includes(message.type)) auth = message;
  });
  await until(() => client.readyState === WS.OPEN, "owned WS open");
  client.send(JSON.stringify({ type: "auth.device", deviceId: device.id, secretHash: secret }));
  await until(() => !!auth, "real device authentication");
  if (auth.type === "auth.failed") return { client, auth, small };
  const n = events.length;
  client.send(JSON.stringify({ type: "session.list" }));
  await until(() => events.length === n + 1, "authenticated normal command");
  const identity = events.at(-1);
  equal(identity.deviceId, device.id);
  check(typeof identity.viewerId === "string");
  const peer = [...host.wss.clients].find((socket) => host.viewers.get(socket) === identity.viewerId);
  check(!!peer);
  return { client, auth, small, peer, viewerId: identity.viewerId, streamFrames: () => streamFrames };
}
try {
  const started = await host.start({ host: "127.0.0.1", port });
  equal(started.url, origin);
  const slow = await connect(), healthy = await connect();
  check(slow.viewerId !== healthy.viewerId);
  equal(host.onlineDeviceIds(), [device.id]);
  slow.client.pause();
  const text = "x".repeat(64 * 1024);
  let seq = 0, payloadBytes = 0;
  const nextFrame = () => ({ type: "session.stream", sessionId: "owned-native-session", epoch: "owned-main-epoch", seq: ++seq, event: { type: "text_delta", text } });
  for (let batch = 0; batch < 16; batch++) {
    for (let index = 0; index < 16; index++) { payloadBytes += text.length; host.broadcast(nextFrame()); }
    await delay(5);
  }
  await until(() => healthy.streamFrames() === seq, "healthy broadcast reader");
  const afterBroadcast = slow.peer.bufferedAmount;
  check(afterBroadcast > 4 * 1024 * 1024, `broadcast backlog ${afterBroadcast}`);
  equal(slow.peer.readyState, WS.OPEN);
  equal(offline, []);
  for (let batch = 0; batch < 8; batch++) {
    for (let index = 0; index < 16; index++) { payloadBytes += text.length; host.sendRawToDevice(device.id, JSON.stringify(nextFrame())); }
    await delay(5);
  }
  await until(() => healthy.streamFrames() === seq, "healthy per-device raw reader");
  const afterDevice = slow.peer.bufferedAmount;
  check(afterDevice > afterBroadcast + 4 * 1024 * 1024, `device backlog ${afterDevice}`);
  equal(payloadBytes, 24 * 1024 * 1024);
  equal(slow.peer.readyState, WS.OPEN);
  host.sendToDevice(device.id, { type: "session.list.ok", sessions: [] });
  await until(() => healthy.small.some((message) => message.type === "session.list.ok"), "healthy device reply");
  check(slow.peer.bufferedAmount > afterDevice);
  check(host.hasAuthenticatedViewer(slow.viewerId, device.id));
  observations.push({ name: "real-native-backlog", node: process.version, platform: process.platform, payloadBytes,
    streamFrames: seq, afterBroadcast, afterDevice, beforeViewerCap: slow.peer.bufferedAmount,
    healthyFrames: healthy.streamFrames(), healthyBacklog: healthy.peer.bufferedAmount, slowOpen: slow.peer.readyState === WS.OPEN });

  // Normal existing cap on that same actual socket releases only its viewer.
  host.sendToViewer(slow.viewerId, { type: "session.recovery.ready", sessionId: "owned-native-session", recoveryId: "owned-selection", ok: true });
  check(!host.hasAuthenticatedViewer(slow.viewerId, device.id));
  equal(offline, [{ deviceId: device.id, viewerId: slow.viewerId }]);
  check(host.hasAuthenticatedViewer(healthy.viewerId, device.id));
  equal(host.onlineDeviceIds(), [device.id]);
  slow.client.resume();
  await until(() => slow.peer.readyState === WS.CLOSED, "capped peer destroyed");
  const repaired = await connect();
  check(repaired.viewerId !== slow.viewerId);
  host.sendToViewer(repaired.viewerId, { type: "session.recovery.ready", sessionId: "owned-native-session", recoveryId: "reconnected-selection", ok: true });
  await until(() => repaired.small.some((message) => message.recoveryId === "reconnected-selection"), "reconnected reply");
  check(host.hasAuthenticatedViewer(repaired.viewerId, device.id));
  equal(store.remove(device.id), true);
  host.revokeDevice(device.id);
  equal(host.onlineDeviceIds(), []);
  check(!host.hasAuthenticatedViewer(healthy.viewerId, device.id));
  check(!host.hasAuthenticatedViewer(repaired.viewerId, device.id));
  await until(() => healthy.client.readyState === WS.CLOSED && repaired.client.readyState === WS.CLOSED, "all device peers revoked");
  equal(offline.length, 3);
  const rejected = await connect();
  equal(rejected.auth.type, "auth.failed");
  equal(host.onlineDeviceIds(), []);
  observations.push({ name: "normal-recovery", selectedCapRetiresOnlySlowPeer: true, reauthenticatedViewer: true, deviceRemoveClosesRemainingPeers: true, removedCredentialRejected: true });
  console.log(`PASS native paired outbound backlog and recovery; ${assertions} assertions; ${payloadBytes} payload bytes maximum`);
} finally {
  clearTimeout(timer);
  for (const ws of clients) { ws.resume(); ws.terminate(); }
  await host.stop();
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(evidence, "outbound-native-observed.json"), JSON.stringify({ origin, assertions, observations }, null, 2));
}
