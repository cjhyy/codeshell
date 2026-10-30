// Isolated cross-repository acceptance fixture. Only the byte transport is in
// memory: real Node HTTP/ws parsers, Account authority, Relay and Host gates run.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const fixtureRoot = process.env.CODESHELL_FIXTURE_ROOT;
const services = process.env.SERVICES_CHECKOUT_PATH;
assert.ok(fixtureRoot && services);
assert.ok(process.env.HOME.startsWith(fixtureRoot));
const directoryOrigin = "https://accounts.fixture.invalid";
const allowedOrigins = new Set([directoryOrigin]);
const agents = new Set(),
  connectors = new Set(),
  listeners = new Map();
let nextPort = 42000;
const nativeRequest = http.request;
const denied = [];

// Install before the first Host/Core/Services evaluation. No producer can open
// a network connection. Test adapters accept only exact registered endpoints.
net.Socket.prototype.connect = function () {
  denied.push("socket");
  throw new Error("Fixture denied a network socket");
};
globalThis.fetch = () => {
  throw new Error("Fixture requires its exact-origin HTTP adapter");
};
https.request = () => {
  throw new Error("Fixture denied an unbound HTTPS request");
};
http.request = function (input, ...args) {
  const options = typeof input === "object" && !(input instanceof URL) ? input : args[0];
  const origin = options?.headers?.Origin ?? options?.headers?.origin;
  const host = options?.headers?.Host ?? options?.headers?.host;
  const relayByteAgent =
    options?.hostname === "relay.invalid" &&
    options.port === 80 &&
    Object.hasOwn(options.agent ?? {}, "createConnection");
  if (
    !allowedOrigins.has(origin) ||
    new URL(origin).host !== host ||
    !(agents.has(options.agent) || connectors.has(options.createConnection) || relayByteAgent)
  )
    throw new Error("Fixture denied an unknown memory HTTP endpoint");
  return nativeRequest.call(this, input, ...args);
};
syncBuiltinESMExports();

const { memoryHttp } = await import(pathToFileURL(join(services, "tests/helpers/memory-http.mjs")));
const { createAccountApplication } = await import(
  pathToFileURL(join(services, "apps/account-server/http.mjs"))
);
const {
  CloudAccountManager,
  CloudAccountStore,
  MobileRemoteController,
  DeviceRelayStore,
  AccountDeviceService,
  AccessPasscode,
  RemoteHostManager,
  TrustedDeviceStore,
  createRelayByteStream,
} = await import("./runtime.mjs");

const originalListen = http.Server.prototype.listen;
const originalAddress = http.Server.prototype.address;
const originalClose = http.Server.prototype.close;
const originalCloseAll = http.Server.prototype.closeAllConnections;
http.Server.prototype.listen = function (_port, host, callback) {
  assert.equal(host, "127.0.0.1");
  const port = nextPort++;
  const memory = memoryHttp(this);
  listeners.set(port, { server: this, memory });
  this.fixturePort = port;
  queueMicrotask(() => {
    this.emit("listening");
    callback?.();
  });
  return this;
};
http.Server.prototype.address = function () {
  return this.fixturePort ? { address: "127.0.0.1", family: "IPv4", port: this.fixturePort } : null;
};
http.Server.prototype.closeAllConnections = function () {
  listeners.get(this.fixturePort)?.memory.close();
};
http.Server.prototype.close = function (callback) {
  const entry = listeners.get(this.fixturePort);
  entry?.memory.close();
  listeners.delete(this.fixturePort);
  queueMicrotask(() => {
    this.emit("close");
    callback?.();
  });
  return this;
};

const accountDirectory = join(fixtureRoot, "existing-account-data");
const relayDirectory = join(fixtureRoot, "relay-data");
const application = await createAccountApplication({
  dataDir: accountDirectory,
  publicOrigin: directoryOrigin,
  allowRegistration: true,
  relay: { dataDir: relayDirectory, deviceBaseOrigin: "https://computers.fixture.invalid" },
});
const server = http.createServer(application.handle);
server.on("upgrade", application.upgrade);
const directory = memoryHttp(server);
agents.add(directory.agent);
connectors.add(directory.connect);
const requests = [];

async function request(url, init = {}) {
  const target = new URL(url);
  assert.ok(allowedOrigins.has(target.origin), "Only an enrolled exact origin is reachable");
  assert.equal(init.redirect, "error");
  const headers = Object.fromEntries(new Headers(init.headers));
  headers.Host = target.host;
  headers.Origin = target.origin;
  if (target.origin !== directoryOrigin) {
    assert.equal(headers.authorization, undefined, "Account bearer must never reach a computer");
    assert.equal(headers["x-codeshell-source-device-credential"], undefined);
  }
  requests.push({
    origin: target.origin,
    path: target.pathname,
    body: init.body && JSON.parse(init.body),
    headers,
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 443,
        path: target.pathname + target.search,
        method: init.method ?? "GET",
        headers,
        agent: directory.agent,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode >= 400)
            console.error("Fixture HTTP rejection", target.pathname, response.statusCode);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: Object.entries(response.headers).flatMap(([key, value]) =>
                value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]],
              ),
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (init.signal) {
      const abort = () => req.destroy(new Error("Fixture request aborted"));
      if (init.signal.aborted) return abort();
      init.signal.addEventListener("abort", abort, { once: true });
      req.once("close", () => init.signal.removeEventListener("abort", abort));
    }
    req.end(init.body);
  });
}
async function accountRequest(input) {
  assert.equal(input.origin, directoryOrigin);
  const response = await request(new URL(input.path, input.origin), {
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    redirect: "error",
    signal: input.signal,
    headers: {
      "Content-Type": "application/json",
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error("Fixture account HTTP rejected"), { status: response.status });
  if (value.publicOrigin) allowedOrigins.add(value.publicOrigin);
  return value;
}
function socket(url, headers) {
  const target = new URL(url);
  const logicalOrigin = target.origin.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  assert.ok(allowedOrigins.has(logicalOrigin));
  const ws = new WebSocket(`ws://127.0.0.1:443${target.pathname}`, {
    headers: { ...headers, Host: new URL(logicalOrigin).host, Origin: logicalOrigin },
    createConnection: directory.connect,
    followRedirects: false,
  });
  ws.on("error", () => {});
  return ws;
}
function cipher() {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt(value) {
      const iv = randomBytes(12),
        encoder = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([encoder.update(value, "utf8"), encoder.final()]);
      return Buffer.concat([iv, encoder.getAuthTag(), bytes]);
    },
    decrypt(value) {
      const decoder = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decoder.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decoder.update(value.subarray(28)), decoder.final()]).toString("utf8");
    },
  };
}
const waitFor = async (predicate, label) => {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Fixture timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 5));
  }
};
const computers = [],
  children = new Set(),
  connectorSockets = new Set();

// Test-only outbound network adapter. It uses the production Relay v1 control
// messages and published byte stream, with memory sockets replacing TLS/TCP.
function connectorFactory(options) {
  let closed = false,
    control;
  const data = new Set();
  const close = async () => {
    closed = true;
    control?.terminate();
    for (const ws of data) ws.terminate();
  };
  return {
    start() {
      options.onState?.("connecting");
      void (async () => {
        const credential = await options.getCredential(options.localHost.signal);
        if (closed) return;
        control = socket(
          `${directoryOrigin.replace("https:", "wss:")}/api/v1/remote-hosts/connect`,
          { Authorization: `Bearer ${credential}` },
        );
        connectorSockets.add(control);
        control.on("close", () => {
          connectorSockets.delete(control);
          if (!closed) options.onState?.("disconnected");
        });
        control.on("message", (bytes) => {
          const message = JSON.parse(String(bytes));
          if (message.type === "welcome") {
            assert.equal(message.hostId, options.hostId);
            assert.equal(message.publicOrigin, options.publicOrigin);
            options.localHost.setPublicBaseUrl(message.publicOrigin);
            control.send(JSON.stringify({ type: "ready", v: 1, leaseId: message.leaseId }));
            setImmediate(() => options.onState?.("ready"));
          } else if (message.type === "open") {
            const ws = socket(
              `${directoryOrigin.replace("https:", "wss:")}/api/v1/remote-hosts/streams/${message.streamId}`,
              {
                Authorization: `Bearer ${credential}`,
                "X-CodeShell-Relay-Lease": message.leaseId,
                "X-CodeShell-Relay-Ticket": message.ticket,
              },
            );
            data.add(ws);
            connectorSockets.add(ws);
            ws.once("close", () => {
              data.delete(ws);
              connectorSockets.delete(ws);
            });
            ws.once("open", () => {
              const entry = listeners.get(options.localHost.port);
              assert.ok(entry, "Relay may reach only its granted local Host");
              const local = entry.memory.connect(),
                bytes = createRelayByteStream(ws);
              bytes.on("error", () => local.destroy());
              local.on("error", () => bytes.destroy());
              bytes.once("close", () => local.destroy());
              local.once("close", () => bytes.destroy());
              bytes.pipe(local).pipe(bytes);
            });
          }
        });
      })().catch(() => options.onState?.("unauthorized"));
      options.localHost.signal.addEventListener("abort", () => void close(), { once: true });
    },
    close,
  };
}

const producerSource = String.raw`
const {createInterface}=require("node:readline");
const label=process.argv[1];let active;
const emit=value=>process.stdout.write(JSON.stringify(value)+"\n");
createInterface({input:process.stdin}).on("line",line=>{
 const command=JSON.parse(line);
 if(command.op==="run"){
  active=command.sessionId;
  emit({type:"output",sessionId:active,text:label+":"+command.text});
  if(command.text==="approval")emit({type:"approval",sessionId:active,requestId:"approval-"+active});
  else if(command.text!=="long")emit({type:"done",sessionId:active});
 }else if(command.op==="approve"){
  emit({type:"output",sessionId:active,text:label+":approved"});emit({type:"done",sessionId:active});
 }else if(command.op==="stop"){
  emit({type:"output",sessionId:active,text:label+":cancelled"});emit({type:"done",sessionId:active});
 }
});
`;

function computer(label) {
  const root = join(fixtureRoot, label),
    projectId = randomUUID(),
    projectPath = join(root, "actual-project");
  mkdirSync(projectPath, { recursive: true });
  const accountStore = new CloudAccountStore(join(root, "account.bin"), cipher());
  const relayStore = new DeviceRelayStore(join(root, "relay.bin"), cipher());
  const devices = new TrustedDeviceStore(join(root, "trusted-devices.json"));
  const sessions = new Map(),
    actions = [];
  const value = {
    label,
    root,
    projectId,
    projectPath,
    accountStore,
    relayStore,
    sessions,
    actions,
  };
  const host = new RemoteHostManager({
    devices,
    onClientEvent: async (event, ws) => {
      actions.push({ ...event, host: label });
      if (event.type === "session.create") {
        assert.equal(event.projectId, projectId);
        const sessionId = randomUUID();
        sessions.set(sessionId, { deviceId: event.deviceId, cwd: projectPath });
        ws.send(
          JSON.stringify({
            type: "chat.accepted",
            clientRequestId: event.clientRequestId,
            sessionId,
            projectId,
            cwd: projectPath,
          }),
        );
        return;
      }
      const selection = sessions.get(event.sessionId);
      assert.ok(selection && selection.deviceId === event.deviceId);
      const write = (command) =>
        selection.child.stdin.write(
          JSON.stringify({ ...command, sessionId: event.sessionId }) + "\n",
        );
      if (event.type === "chat.send") {
        assert.equal(selection.cwd, projectPath);
        if (!selection.child) {
          const child = spawn(process.execPath, ["-e", producerSource, label], {
            cwd: selection.cwd,
            env: { HOME: process.env.HOME, PATH: process.env.PATH },
            stdio: ["pipe", "pipe", "pipe"],
          });
          selection.child = child;
          children.add(child);
          child.once("exit", () => children.delete(child));
          createInterface({ input: child.stdout }).on("line", (line) => {
            const output = JSON.parse(line);
            const inner =
              output.type === "approval"
                ? {
                    method: "agent/approvalRequest",
                    params: {
                      sessionId: output.sessionId,
                      requestId: output.requestId,
                      request: {
                        toolName: "FixtureWrite",
                        description: "Controlled fixture approval",
                      },
                    },
                  }
                : {
                    method: "agent/streamEvent",
                    params: {
                      sessionId: output.sessionId,
                      event:
                        output.type === "done"
                          ? { type: "turn_complete", reason: "completed" }
                          : { type: "text_delta", text: output.text },
                    },
                  };
            host.sendToDevice(selection.deviceId, {
              type: "session.stream",
              sessionId: output.sessionId,
              event: inner,
            });
          });
        }
        ws.send(
          JSON.stringify({
            type: "chat.accepted",
            sessionId: event.sessionId,
            clientMessageId: event.clientMessageId,
          }),
        );
        write({ op: "run", text: event.text });
      } else if (event.type === "approval.respond") {
        assert.equal(event.approvalId, "approval-" + event.sessionId);
        assert.equal(event.decision, "approve");
        write({ op: "approve" });
      } else if (event.type === "run.stop") write({ op: "stop" });
      else throw new Error("Unexpected fixture action");
    },
  });
  host.on("host-error", (error) => {
    throw error;
  });
  value.host = host;
  value.make = () => {
    value.account = new CloudAccountManager({
      store: accountStore,
      request: accountRequest,
      changed: () => {},
      openExternal: async () => {
        throw new Error("No external navigation allowed");
      },
      activateRelay: (identity, authorized) =>
        value.controller.activateAccountRelay(identity, authorized),
      retireRelay: async (identity) => {
        value.client?.retireIdentity();
        await value.controller.retireAccountRelay(identity);
      },
    });
    value.controller = new MobileRemoteController({
      host,
      tunnel: { stop: async () => {}, isConnected: () => false, isRunning: () => false },
      binary: {},
      passcode: new AccessPasscode({ filePath: join(root, "passcode.json") }),
      store: relayStore,
      environmentDir: join(root, "environment"),
      changed: () => {},
      account: value.account,
      accountRequest,
      connectorFactory,
      listProjects: async () => [
        { id: projectId, name: label + " actual project", path: projectPath },
      ],
    });
  };
  value.make();
  value.client = new AccountDeviceService({
    identity: () => {
      const status = value.account.status();
      return status.state === "signed-in"
        ? { origin: status.origin, accountId: status.account.id }
        : undefined;
    },
    credential: (identity, signal) =>
      value.account.getCredential(identity.origin, identity.accountId, signal),
    sourceProof: (identity, signal) => value.controller.accountRelaySource(identity, signal),
    relayOrigin: async (identity) =>
      (await value.account.capabilities(identity.origin)).relay.directoryOrigin,
    fetch: request,
    socket,
  });
  value.events = [];
  value.client.setEventSink((owner, event) => value.events.push({ owner, ...event }));
  computers.push(value);
  return value;
}

try {
  const a = computer("computer-a"),
    b = computer("computer-b"),
    c = computer("computer-c");
  const password = "only-fixture-password-12345";
  await a.account.signIn("register", { origin: directoryOrigin, username: "alice", password });
  await b.account.signIn("login", { origin: directoryOrigin, username: "alice", password });
  await c.account.signIn("register", { origin: directoryOrigin, username: "bob", password });
  for (const item of computers)
    assert.equal(
      item.controller.relayStatus().state,
      "ready",
      JSON.stringify({
        label: item.label,
        status: item.controller.relayStatus(),
        paths: requests.map((item) => item.path),
      }),
    );
  const aId = a.controller.relayStatus().hostId,
    bId = b.controller.relayStatus().hostId,
    cId = c.controller.relayStatus().hostId;
  const aliceHosts = await b.client.list();
  assert.deepEqual(new Set(aliceHosts.map((host) => host.hostId)), new Set([aId, bId]));
  assert.ok(aliceHosts.every((host) => host.online));
  assert.deepEqual(
    (await c.client.list()).map((host) => host.hostId),
    [cId],
  );
  await assert.rejects(c.client.connect(8, { hostId: aId, projectId: a.projectId }), /账号授权/);
  const projects = await b.client.projects(7, { hostId: aId });
  assert.deepEqual(projects, [
    { id: a.projectId, name: "computer-a actual project", path: a.projectPath },
  ]);
  const one = await b.client.connect(7, { hostId: aId, projectId: a.projectId });
  b.client.send(7, { connectionId: one.id, text: "approval" });
  await waitFor(
    () =>
      b.events.some(
        (event) =>
          event.connectionId === one.id && event.event?.event?.method === "agent/approvalRequest",
      ),
    "real producer approval",
  );
  b.client.approve(7, {
    connectionId: one.id,
    approvalId: "approval-" + one.sessionId,
    approved: true,
  });
  await waitFor(
    () => JSON.stringify(b.events).includes("computer-a:approved"),
    "producer approval output",
  );
  b.client.send(7, { connectionId: one.id, text: "long" });
  await waitFor(() => JSON.stringify(b.events).includes("computer-a:long"), "first target running");
  const two = await b.client.connect(7, { hostId: bId, projectId: b.projectId });
  b.client.send(7, { connectionId: two.id, text: "quick" });
  await waitFor(
    () => JSON.stringify(b.events).includes("computer-b:quick"),
    "second target output",
  );
  b.client.stop(7, { connectionId: one.id });
  await waitFor(
    () => JSON.stringify(b.events).includes("computer-a:cancelled"),
    "old target receives Stop",
  );
  assert.equal(
    a.actions.filter((event) => event.type === "run.stop").at(-1).sessionId,
    one.sessionId,
  );
  assert.equal(b.actions.filter((event) => event.type === "run.stop").length, 0);
  for (const event of b.events.filter((event) => event.connectionId === one.id)) {
    assert.equal(event.hostId, aId);
    assert.equal(event.projectId, a.projectId);
    assert.equal(event.sessionId, one.sessionId);
  }
  assert.equal(a.sessions.get(one.sessionId).cwd, a.projectPath);
  assert.equal(b.sessions.get(two.sessionId).cwd, b.projectPath);
  assert.throws(() => b.client.stop(99, { connectionId: one.id }), /断线|授权/);

  const before = requests.filter((request) => request.path.endsWith("/ensure")).length;
  await a.account.resume();
  await a.account.resume();
  assert.equal(requests.filter((request) => request.path.endsWith("/ensure")).length, before);
  const saved = a.accountStore.load();
  a.accountStore.save({ ...saved, accessTokenExpiresAt: Date.now() - 1 });
  const epoch = a.relayStore.load().credentialEpoch;
  await a.controller.stop();
  a.make();
  await a.account.resume();
  assert.equal(a.controller.relayStatus().hostId, aId);
  assert.equal(a.relayStore.load().credentialEpoch, epoch);
  assert.equal(requests.filter((request) => request.path.endsWith("/ensure")).length, before);
  assert.ok(requests.some((request) => request.path === "/api/v1/account/refresh"));
  await waitFor(
    () => b.events.some((event) => event.connectionId === one.id && event.type === "disconnected"),
    "restart ends old grant",
  );
  assert.throws(
    () => b.client.send(7, { connectionId: one.id, text: "must-not-retry" }),
    /断线|授权/,
  );

  const three = await b.client.connect(7, { hostId: aId, projectId: a.projectId });
  const sourceRun = await a.client.connect(9, { hostId: bId, projectId: b.projectId });
  a.client.send(9, { connectionId: sourceRun.id, text: "long" });
  await waitFor(
    () => JSON.stringify(a.events).includes("computer-b:long"),
    "source-bound remote task",
  );
  const token = await b.account.getCredential(directoryOrigin, b.account.status().account.id);
  await accountRequest({
    origin: directoryOrigin,
    path: `/api/v1/remote-hosts/${aId}`,
    method: "DELETE",
    token,
  });
  await waitFor(
    () =>
      b.events.some((event) => event.connectionId === three.id && event.type === "disconnected"),
    "revocation ends target stream",
  );
  assert.throws(() => b.client.stop(7, { connectionId: three.id }), /断线|授权/);
  await waitFor(
    () =>
      a.events.some(
        (event) => event.connectionId === sourceRun.id && event.type === "disconnected",
      ),
    "source revocation ends remote access",
  );
  assert.throws(() => a.client.stop(9, { connectionId: sourceRun.id }), /断线|授权/);
  assert.equal(b.controller.relayStatus().state, "ready");
  await assert.rejects(b.client.connect(7, { hostId: aId, projectId: a.projectId }), /授权/);
  await b.controller.stop();
  assert.equal((await b.client.list()).find((host) => host.hostId === bId).online, false);
  await assert.rejects(b.client.connect(7, { hostId: bId, projectId: b.projectId }), /离线/);
  await b.account.logout();
  await assert.rejects(b.client.list(), /登录/);
  assert.equal(c.controller.relayStatus().state, "ready");
  assert.equal((await c.client.list())[0].hostId, cId);
  const publicState = JSON.stringify({
    list: aliceHosts,
    projects,
    connections: [one, two],
    events: b.events,
  });
  for (const item of computers) {
    const grant = item.relayStore.load();
    if (grant) {
      assert.ok(!publicState.includes(grant.credential));
      assert.ok(!publicState.includes(grant.refreshToken));
    }
  }
  const accountToken = saved.accessToken,
    accountRefresh = saved.refreshToken;
  assert.ok(!publicState.includes(accountToken));
  assert.ok(!publicState.includes(accountRefresh));
  assert.ok(!readFileSync(join(a.root, "account.bin")).includes(Buffer.from(accountRefresh)));
  assert.equal(denied.length, 0);
  console.log(
    JSON.stringify({
      ok: true,
      transport: "native HTTP/ws parsers over isolated memory bytes; no TCP/TLS claim",
      automaticLoginOnline: 3,
      accounts: 2,
      projects: "actual per-Host fixture directories",
      controlledStdio: ["output", "approval", "cancel"],
      verified: [
        "same-account discovery",
        "foreign-account denied",
        "selected Host/project/session ownership",
        "old-target Stop after switch",
        "refresh/restart reuse",
        "target and source revocation disconnect",
        "offline dispatch denied",
        "logout isolation",
        "main-only credentials",
      ],
    }),
  );
} finally {
  for (const child of children) child.kill();
  for (const item of computers) {
    item.client.retireIdentity();
    await item.controller.dispose().catch(() => {});
  }
  for (const ws of connectorSockets) ws.terminate();
  directory.close();
  await application.close();
  for (const { memory } of listeners.values()) memory.close();
  http.Server.prototype.listen = originalListen;
  http.Server.prototype.address = originalAddress;
  http.Server.prototype.close = originalClose;
  http.Server.prototype.closeAllConnections = originalCloseAll;
}
