import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.HOME;
assert.ok(home.includes("codeshell-native-smoke-"));
assert.equal(fs.realpathSync(home), home);
const origins = new Set();
const denied = () => {
  throw new Error("Compiled Server fixture refused external transport/process");
};
const allow = (url) => {
  if (!origins.has(new URL(url).origin)) denied();
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  allow(typeof input === "string" || input instanceof URL ? input : input.url);
  if (init?.dispatcher) denied();
  return nativeFetch(input, { ...init, redirect: "error" });
};
for (const [module, scheme] of [
  [http, "http:"],
  [https, "https:"],
])
  for (const key of ["request", "get"]) {
    const original = module[key];
    module[key] = function (input, ...args) {
      const url = typeof input === "string" || input instanceof URL ? new URL(input) : undefined;
      const options = url ? (typeof args[0] === "object" ? args[0] : {}) : input;
      if (options.socketPath || options.createConnection || options.agent || options.lookup)
        denied();
      const protocol = options.protocol ?? url?.protocol ?? scheme;
      allow(
        `${protocol}//${options.hostname ?? options.host ?? url?.hostname ?? "localhost"}:${options.port ?? url?.port ?? (protocol === "http:" ? 80 : 443)}`,
      );
      return original.call(this, input, ...args);
    };
  }
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const o = typeof a[0] === "object" ? a[0] : { port: a[0], host: a[1] };
  if (o.path || !o.port) denied();
  allow(`http://${o.hostname ?? o.host ?? "localhost"}:${o.port}`);
  return originalConnect.apply(this, args);
};
tls.connect = denied;
dgram.createSocket = denied;
globalThis.WebSocket = denied;
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  cp[key] = denied;
syncBuiltinESMExports();
let blocked = 0;
for (const probe of [
  () => fetch("https://external.invalid"),
  () => http.get("http://127.0.0.1:1"),
  () => net.connect(2, "127.0.0.1"),
  () => cp.spawn("sh"),
])
  try {
    probe();
  } catch {
    blocked++;
  }
assert.equal(blocked, 4);
const base = new URL("../../../dist/project-runtime/", import.meta.url);
const { acquireProjectControllerLock } = await import(new URL("lock.js", base).href);
const { startProjectControlServer } = await import(new URL("control-server.js", base).href);
const heartbeat = fs.mkdtempSync(path.join(home, "native-heartbeat-"));
const lease = acquireProjectControllerLock(heartbeat);
const before = fs.lstatSync(heartbeat + ".lock").mtimeMs;
await new Promise((done) => setTimeout(done, 10_250));
lease.assertHeld();
const after = fs.lstatSync(heartbeat + ".lock").mtimeMs;
assert.ok(after > before, "healthy native Node heartbeat must renew");
lease.release();
assert.equal(fs.existsSync(heartbeat + ".lock"), false);

const root = fs.mkdtempSync(path.join(home, "native-controller-"));
fs.writeFileSync(path.join(root, "index.html"), "<title>Controller smoke</title>");
const running = new Set();
let providerClosed = false,
  requests = 0;
const server = await startProjectControlServer({
  dataDir: root,
  staticRootDir: root,
  host: "127.0.0.1",
  port: 0,
  provider: {
    availability: async () => ({ available: true }),
    ensure: async (p) => {
      running.add(p.id);
      return {
        url: "http://127.0.0.1:65534",
        username: p.runtimeUsername,
        password: p.runtimePassword,
        generation: p.generation,
      };
    },
    status: async (p) =>
      running.has(p.id)
        ? { state: "running", url: "http://127.0.0.1:65534" }
        : { state: "stopped" },
    stop: async (p) => {
      running.delete(p.id);
    },
    close: async () => {
      providerClosed = true;
    },
  },
});
origins.add(server.url);
let finished = false;
try {
  const setup = await fetch(server.url + "/api/v1/auth/setup", {
    method: "POST",
    headers: { Origin: server.url, "Content-Type": "application/json" },
    body: JSON.stringify({
      token: server.bootstrapToken,
      username: "synthetic.owner",
      password: "synthetic-native-smoke-password",
    }),
  });
  requests++;
  assert.equal(setup.status, 200);
  await setup.arrayBuffer();
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const request = async (url, method = "GET", body) => {
    requests++;
    return fetch(server.url + url, {
      method,
      headers: {
        Origin: server.url,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const create = await request("/api/v1/projects", "POST", {
    name: "Synthetic compiled lifecycle",
  });
  assert.equal(create.status, 201);
  const { project } = await create.json();
  const start = await request(`/api/v1/projects/${project.id}/start`, "POST", {});
  assert.equal(start.status, 200);
  assert.equal((await start.json()).project.status, "running");
  const stop = await request(`/api/v1/projects/${project.id}/stop`, "POST", {});
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).project.status, "stopped");
  const list = await request("/api/v1/projects");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).projects.length, 1);
  const control = path.join(root, "project-control");
  const lockPath = control + ".lock";
  fs.renameSync(lockPath, lockPath + ".original");
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const replacement = fs.lstatSync(lockPath);
  const deniedList = await request("/api/v1/projects");
  assert.ok(deniedList.status >= 400);
  await deniedList.arrayBuffer();
  await assert.rejects(server.close());
  assert.equal(providerClosed, true);
  assert.equal(fs.lstatSync(lockPath).ino, replacement.ino);
  await assert.rejects(fetch(server.url + "/health"));
  finished = true;
  console.log(
    JSON.stringify({
      passed: true,
      nativeNode: process.versions.node,
      compiledServer: true,
      healthyHeartbeat: true,
      actualHttpLifecycle: true,
      leaseLossDenied: true,
      replacementPreserved: true,
      providerClosed,
      listenerClosed: true,
      requests,
      negativeGuards: blocked,
      externalNetwork: false,
      runtimeProvider: "synthetic,no Docker/model/Services",
    }),
  );
} finally {
  if (!finished) await server.close().catch(() => {});
}
