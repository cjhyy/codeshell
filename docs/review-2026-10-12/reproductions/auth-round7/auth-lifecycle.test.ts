import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = fileURLToPath(new URL("./", import.meta.url));
const reserve = createServer();
await new Promise<void>((done) => reserve.listen(0, "127.0.0.1", done));
const port = (reserve.address() as any).port;
await new Promise<void>((done) => reserve.close(() => done()));
const origin = `http://127.0.0.1:${port}`;
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
isolation.installLocalNetworkGuard(origin);
// Bun's browser-compatible WebSocket accepts headers. Its constructor is
// explicitly confined in addition to the HTTP/fetch guard above.
const NativeWebSocket = globalThis.WebSocket;
function fixtureSocket(headers: Record<string, string>) {
  const url = origin.replace("http:", "ws:") + "/ws";
  if (new URL(url.replace("ws:", "http:")).origin !== origin) throw new Error("non-fixture WS");
  return new NativeWebSocket(url, { headers: { origin, ...headers } } as any);
}
const { startHeadlessServer } = await import(repo + "/packages/server/dist/serve/headless-server.js");
const { createDesktopWebApi } = await import(repo + "/packages/server/dist/desktop-web/http-api.js");
const { RemoteHostManager } = await import(repo + "/packages/server/dist/mobile-remote/remote-host-manager.js");
const { TrustedDeviceStore } = await import(repo + "/packages/server/dist/mobile-remote/trusted-device-store.js");
const closeActions: Array<() => Promise<void> | void> = [];
const observations: any[] = [];
afterEach(async () => {
  for (const close of closeActions.splice(0).reverse()) await close();
  writeFileSync(join(evidence, "auth-lifecycle-observed.json"), JSON.stringify({ origin, observations }, null, 2));
});
function root() {
  const dir = mkdtempSync(join(evidence, "fixture-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "small.txt"), "other authenticated session remains usable");
  closeActions.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, cwd };
}
function call(path: string, cookie?: string, method = "GET", body?: any) {
  return fetch(origin + path, {
    method,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function grant(response: Response) {
  expect(response.status).toBe(200);
  return { cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, body: await response.json() as any };
}
async function socket(cookie?: string) {
  const ws = fixtureSocket(cookie ? { cookie } : {});
  const received: any[] = [];
  let closure: { code: number; reason: string } | undefined;
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  const closed = new Promise<{ code: number; reason: string }>((done) => ws.addEventListener("close", (event) => {
    closure = { code: event.code, reason: event.reason }; done(closure);
  }));
  await new Promise<void>((done, reject) => { ws.addEventListener("open", () => done()); ws.addEventListener("error", reject); });
  closeActions.push(() => ws.close());
  return { ws, received, closed, isClosed: () => !!closure, send: (body: any) => ws.send(JSON.stringify(body)), wait: (type: string) => waitUntil(() => received.find((m) => m.type === type)) };
}
async function waitUntil<T>(read: () => T | undefined | false): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 3000) { const value = read(); if (value) return value as T; await Bun.sleep(5); }
  throw new Error("fixture condition timeout");
}
async function hub() {
  const f = root();
  const worker = join(f.dir, "never-used-worker.cjs");
  writeFileSync(worker, "throw new Error('Auth lifecycle fixture must not start a worker');\n");
  const server = await startHeadlessServer({ host: "127.0.0.1", port, cwd: f.cwd, dataDir: join(f.dir, "data"), authMode: "hub", workerEntryPath: worker, authRecheckMs: 20 });
  closeActions.push(() => server.close());
  const credentials = { username: "fixture-owner", password: "synthetic-owner-password", deviceName: "same-browser" };
  const first = await grant(await call("/api/v1/auth/setup", undefined, "POST", { ...credentials, token: server.bootstrapToken }));
  const login = (cookie?: string) => call("/api/v1/auth/login", cookie, "POST", credentials).then(grant);
  return { ...f, server, first, login };
}
async function desktop() {
  const f = root();
  let clock = 1_800_000_000_000;
  const revoked: string[] = [];
  const devices = new TrustedDeviceStore(join(f.dir, "devices.json"));
  const device = devices.addDevice({ name: "same-browser", secretHash: "synthetic-pairing-secret" });
  const other = devices.addDevice({ name: "other-browser", secretHash: "synthetic-other-secret" });
  const api = createDesktopWebApi({ devices, dataDir: join(f.dir, "data"), sessionRootDir: join(f.dir, "sessions"), resolveWorkspace: () => f.cwd, withConfigurationMutation: (_cwd, write) => write(), isRunning: () => false, now: () => clock, sessionTtlMs: 1000, onSessionRevoked: (id) => revoked.push(id) });
  const forwarded: any[] = [];
  const host = new RemoteHostManager({ devices, webApi: api, onClientEvent: (event) => { forwarded.push(event); } });
  await host.start({ host: "127.0.0.1", port });
  closeActions.push(() => host.stop());
  const login = (row = device, cookie?: string) => call("/api/v1/desktop/session", cookie, "POST", { deviceId: row.id, secretHash: row.id === other.id ? "synthetic-other-secret" : "synthetic-pairing-secret" }).then(grant);
  const authSocket = async (row = device) => {
    const client = await socket();
    client.send({ type: "auth.device", deviceId: row.id, secretHash: row.id === other.id ? "synthetic-other-secret" : "synthetic-pairing-secret" });
    await client.wait("auth.ok");
    return client;
  };
  return { ...f, host, api, devices, device, other, revoked, forwarded, login, authSocket, advance: (ms: number) => { clock += ms; } };
}

test("Hub revocation closes both tabs sharing the revoked cookie and preserves another login", async () => {
  const f = await hub();
  const other = await f.login();
  const a = await socket(f.first.cookie), b = await socket(f.first.cookie), c = await socket(other.cookie);
  expect(f.server.tabCount()).toBe(3);
  const response = await call(`/api/v1/auth/sessions/${f.first.body.session.id}`, other.cookie, "DELETE");
  expect(response.status).toBe(200);
  const closures = await Promise.all([a.closed, b.closed]);
  expect(closures.map((x) => x.code)).toEqual([4401, 4401]);
  expect((await call("/api/v1/auth/sessions", f.first.cookie)).status).toBe(401);
  expect((await call("/api/v1/auth/sessions", other.cookie)).status).toBe(200);
  expect(c.isClosed()).toBe(false);
  expect(f.server.bridge.workerGeneration()).toBe(0);
  observations.push({ test: "hub multi-tab revoke", closures, otherUnaffected: true, workerGeneration: 0 });
});

test("Hub re-login rotates only the supplied old cookie and fresh credentials recover an expired session", async () => {
  const f = await hub();
  const old = await socket(f.first.cookie);
  const next = await f.login(f.first.cookie);
  expect(next.body.session.id).not.toBe(f.first.body.session.id);
  expect((await old.closed).code).toBe(4401);
  expect((await call("/api/v1/auth/sessions", f.first.cookie)).status).toBe(401);
  const active = await socket(next.cookie);
  // Advance this synthetic session's persisted timestamps to its expiry boundary;
  // no global clock or operator state is changed.
  const path = join(f.dir, "data", "hub", "auth.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const row = state.sessions.find((row: any) => row.id === next.body.session.id);
  row.createdAt = Date.now() - 2000; row.lastSeenAt = row.createdAt; row.expiresAt = Date.now() - 1;
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  const expired = await active.closed;
  expect(expired.code).toBe(4401);
  expect((await (await call("/api/v1/auth/status", next.cookie)).json() as any).authenticated).toBe(false);
  const recovered = await f.login(next.cookie);
  expect((await call("/api/v1/auth/sessions", recovered.cookie)).status).toBe(200);
  expect(f.server.bridge.workerGeneration()).toBe(0);
  observations.push({ test: "hub cookie rotation and expiry", expired, recovered: true, workerGeneration: 0 });
});

test("Hub logout revokes only the owning login and leaves another login usable", async () => {
  const f = await hub(); const other = await f.login();
  expect((await call("/api/v1/auth/logout", f.first.cookie, "POST", {})).status).toBe(200);
  expect((await call("/api/v1/files/content?path=small.txt", other.cookie)).status).toBe(200);
  expect((await call("/api/v1/files/content?path=small.txt", f.first.cookie)).status).toBe(401);
  observations.push({ test: "hub HTTP logout", otherUnaffected: true });
});

test("Desktop cookie handshake is stable across tabs, renews before expiry, and can recover after expiry", async () => {
  const f = await desktop(); const first = await f.login();
  const a = await f.authSocket(), b = await f.authSocket();
  f.advance(900); const refresh = await f.login(f.device, first.cookie);
  expect(refresh.cookie).toBe(first.cookie); expect(refresh.body.session.id).toBe(first.body.session.id);
  expect(f.revoked).toEqual([]);
  f.advance(200); expect((await call("/api/v1/configuration", first.cookie)).status).toBe(200);
  f.advance(1000); expect((await call("/api/v1/configuration", first.cookie)).status).toBe(401);
  expect(a.isClosed()).toBe(false); expect(b.isClosed()).toBe(false);
  const recovered = await f.login(f.device, first.cookie);
  expect(recovered.body.session.id).not.toBe(first.body.session.id);
  expect((await call("/api/v1/configuration", recovered.cookie)).status).toBe(200);
  expect(f.devices.listDevices()).toHaveLength(2);
  observations.push({ test: "desktop cookie TTL", reusedOwnerBeforeExpiry: true, expiredOwnerRevoked: f.revoked.includes(first.body.session.id), pairedWsRemainAuthenticated: true, newOwnerRecovered: true });
});

test("Desktop Settings removeDevice flow terminates all old sockets and HTTP then permits same-secret QR pairing", async () => {
  const f = await desktop(); const first = await f.login(); const other = await f.login(f.other);
  const a = await f.authSocket(), b = await f.authSocket(), c = await f.authSocket(f.other);
  expect(f.devices.remove(f.device.id)).toBe(true); f.host.revokeDevice(f.device.id);
  await Promise.all([a.closed, b.closed]);
  expect((await call("/api/v1/configuration", first.cookie)).status).toBe(401);
  expect((await call("/api/v1/configuration", other.cookie)).status).toBe(200);
  expect(c.isClosed()).toBe(false);
  const paired = await socket();
  paired.send({ type: "pair.complete", token: f.host.createPairingUrl().token, name: "same-browser-again", secretHash: "synthetic-pairing-secret" });
  const response: any = await paired.wait("pair.ok");
  expect(response.device.id).not.toBe(f.device.id);
  paired.send({ type: "auth.device", deviceId: response.device.id, secretHash: "synthetic-pairing-secret" });
  await paired.wait("auth.ok");
  const restored = await f.login(response.device, first.cookie);
  expect((await call("/api/v1/configuration", restored.cookie)).status).toBe(200);
  observations.push({ test: "desktop device deletion and same-browser re-pair", oldWsClosed: 2, otherUnaffected: true, sameSecretRepaired: true });
});

test("Desktop browser logout revokes its HTTP owner while preserving pairing for an explicit re-exchange", async () => {
  const f = await desktop(); const first = await f.login(); const other = await f.login(f.other);
  const a = await f.authSocket(), b = await f.authSocket();
  expect((await call("/api/v1/auth/logout", first.cookie, "POST", {})).status).toBe(200);
  expect(f.revoked).toContain(first.body.session.id);
  expect((await call("/api/v1/configuration", first.cookie)).status).toBe(401);
  expect((await call("/api/v1/configuration", other.cookie)).status).toBe(200);
  expect(f.devices.authenticate(f.device.id, "synthetic-pairing-secret")?.id).toBe(f.device.id);
  expect(a.isClosed()).toBe(false); expect(b.isClosed()).toBe(false);
  const restored = await f.login(f.device);
  expect((await call("/api/v1/configuration", restored.cookie)).status).toBe(200);
  observations.push({ test: "desktop logout contract", httpOwnerRevoked: true, pairingRetained: true, pairedSocketsRetainedAtHttpLayer: true, explicitReExchangeWorks: true });
});
