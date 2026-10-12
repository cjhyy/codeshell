// Actual Node, builtins and the pinned local ws package only. No Core or provider.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const config = JSON.parse(readFileSync(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG));
const mode = process.argv[2];
if (mode !== "preload") process.env.NODE_OPTIONS = `--import=${config.preload}`;
const { loadCandidateStockWebSocket, pinCandidateStockWebSocket } = await import(
  new URL("./docker-candidate-stock-ws.mjs", pathToFileURL(config.preload))
);
if (config.hardlinkedSourceAnchor)
  assert.throws(
    () => pinCandidateStockWebSocket(config.hardlinkedSourceAnchor),
    /Docker candidate refused/,
  );
let guard,
  loaderCalls = 0,
  nativeRequests = 0,
  requestOptions;
const requestCut = new Error("controlled native HTTP no-delegate cut");
const native = http.request;
if (mode !== "preload") {
  http.request = function (...args) {
    nativeRequests++;
    if (mode === "cuts") {
      requestOptions = args[0];
      throw requestCut;
    }
    return native.apply(this, args);
  };
  const { installDockerCandidateGuard } = await import(
    new URL("./docker-candidate-guard.mjs", pathToFileURL(config.preload))
  );
  guard = installDockerCandidateGuard(config, {
    loadStockWebSocket() {
      loaderCalls++;
      assert.equal(globalThis[Symbol.for("codeshell.docker-candidate.pre-core")].negativeProbes, 6);
      assert.equal(
        globalThis[Symbol.for("codeshell.docker-candidate.pre-core")].dnsNegativeProbes,
        4,
      );
      assert.throws(() => fetch("https://external.invalid/"), /Docker candidate refused/);
      return loadCandidateStockWebSocket(config.stockWebSocket);
    },
  });
  assert.equal(loaderCalls, 1);
  assert.equal(nativeRequests, 0, "observation must not delegate any native request");
  assert.deepEqual(Object.keys(guard).sort(), [
    "WebSocket",
    "allowOrigin",
    "record",
    "revokeOrigin",
  ]);
}
const WebSocket = loadCandidateStockWebSocket(config.stockWebSocket);
const { WebSocket: productionConstructor } = await import(
  pathToFileURL(`${config.stockWebSocket.packageRoot}/wrapper.mjs`)
);
// The unchanged production proxy imports this ESM entry. It must share the exact
// connector identity observed through the trusted CJS loader in its preload.
assert.equal(WebSocket, productionConstructor);
if (guard) assert.equal(guard.WebSocket, productionConstructor);
const blocked = /Docker candidate refused/;
let customCalls = 0;
const custom = () => {
  customCalls++;
  throw new Error("custom connector ran");
};
const server = http.createServer((_request, response) => response.end("owned"));
const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
const peers = new Set();
const wss = new WebSocket.WebSocketServer({ noServer: true, perMessageDeflate: false });
let upgrades = 0;
server.on("upgrade", (request, socket, head) => {
  upgrades++;
  wss.handleUpgrade(request, socket, head, (peer) => {
    peers.add(peer);
    peer.once("close", () => peers.delete(peer));
    peer.on("message", (bytes, binary) => peer.send(bytes, { binary }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let client;
try {
  assert.throws(
    () => new WebSocket(origin.replace("http:", "ws:"), { createConnection: custom }),
    blocked,
  );
  const agent = new http.Agent();
  agent.createConnection = custom;
  assert.throws(() => new WebSocket(origin.replace("http:", "ws:"), { agent }), blocked);
  assert.throws(() => new WebSocket("ws://127.0.0.1:1/"), blocked);
  assert.throws(() => new WebSocket(origin.replace("http:", "ws:"), { lookup: custom }), blocked);
  assert.throws(
    () => new WebSocket(origin.replace("http:", "ws:"), { rejectUnauthorized: false }),
    blocked,
  );
  assert.throws(() => new WebSocket(origin.replace("http:", "wss:")), blocked);
  assert.equal(customCalls, 0);
  if (mode === "cuts") {
    const captured = () => {
      assert.throws(
        () => new WebSocket(`${origin.replace("http:", "ws:")}/ws`),
        (error) => error === requestCut,
      );
      assert.equal(typeof requestOptions.createConnection, "function");
      return { invoke: requestOptions.createConnection, options: { ...requestOptions } };
    };
    const revoked = captured();
    guard.revokeOrigin(origin);
    assert.throws(() => revoked.invoke(revoked.options), blocked);
    guard.allowOrigin(origin);
    // A failed or revoked attempt consumes the one-shot connector too.
    assert.throws(() => revoked.invoke(revoked.options), blocked);
    for (const change of [
      { host: "external.invalid" },
      { hostname: "external.invalid" },
      { port: 1 },
      { lookup: custom },
      { socketPath: "/tmp/unowned.sock" },
      { localAddress: "127.0.0.2" },
      { protocol: "https:" },
      { rejectUnauthorized: false },
      { socket: {} },
    ]) {
      const entry = captured();
      assert.throws(() => entry.invoke({ ...entry.options, ...change }), blocked);
    }
    const accessor = captured();
    let getterCalls = 0;
    Object.defineProperty(accessor.options, "host", {
      get() {
        getterCalls++;
        return "external.invalid";
      },
    });
    assert.throws(() => accessor.invoke(accessor.options), blocked);
    assert.equal(getterCalls, 0);
    assert.equal(customCalls, 0);
    assert.equal(upgrades, 0);
    assert.equal(sockets.size, 0, "every rejected cut precedes native TCP");
    const valid = captured();
    const connection = valid.invoke(valid.options);
    connection.on("error", () => {});
    await once(connection, "connect");
    assert.throws(() => valid.invoke(valid.options), blocked);
    const closed = once(connection, "close");
    connection.destroy();
    await closed;
  } else {
    // Same constructor and options as unmodified project-runtime/proxy.ts.
    client = new productionConstructor(`${origin.replace("http:", "ws:")}/ws`, {
      headers: { origin },
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 2000,
    });
    client.on("error", () => {});
    await once(client, "open");
    const text = once(client, "message");
    client.send("owned stock ws");
    assert.equal((await text)[0].toString(), "owned stock ws");
    const binary = once(client, "message");
    client.send(Buffer.from([1, 2, 3]));
    const [bytes, isBinary] = await binary;
    assert.deepEqual(bytes, Buffer.from([1, 2, 3]));
    assert.equal(isBinary, true);
    const closed = once(client, "close");
    client.close();
    await closed;
    assert.equal(upgrades, 1);
    // Native agent:false normally bypasses options.createConnection. This path
    // must normalize it and never instantiate a caller's _defaultAgent.
    const agentFalse = new WebSocket(origin.replace("http:", "ws:"), {
      agent: false,
      _defaultAgent: { constructor: custom },
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 2000,
    });
    agentFalse.on("error", () => {});
    await once(agentFalse, "open");
    const agentFalseClosed = once(agentFalse, "close");
    agentFalse.close();
    await agentFalseClosed;
    assert.equal(customCalls, 0);
    assert.equal(upgrades, 2);
    if (guard) {
      assert.equal(nativeRequests, 2);
      guard.revokeOrigin(origin);
      assert.throws(() => new WebSocket(origin.replace("http:", "ws:")), blocked);
    }
  }
} finally {
  client?.terminate();
  for (const peer of peers) peer.terminate();
  await Promise.all(
    [...sockets].map(async (socket) => {
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
    }),
  );
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (guard) guard.revokeOrigin(origin);
}
assert.equal(sockets.size, 0);
assert.equal(peers.size, 0);
const require = createRequire(import.meta.url);
const indexPath = `${config.stockWebSocket.packageRoot}/index.js`;
const previous = require.cache[indexPath].exports;
let unknownConstructorCalls = 0;
const unknown = function () {
  unknownConstructorCalls++;
};
unknown.WebSocket = unknown;
try {
  require.cache[indexPath].exports = unknown;
  assert.throws(
    () => loadCandidateStockWebSocket(config.stockWebSocket),
    /stock WebSocket source refused/,
  );
  assert.equal(unknownConstructorCalls, 0);
} finally {
  require.cache[indexPath].exports = previous;
}
console.log(
  JSON.stringify({
    passed: true,
    pid: process.pid,
    role: config.role,
    packageVersion: config.stockWebSocket.packageVersion,
    loaderCalls,
    observationNativeRequests: 0,
    upgrades,
    customCalls,
    sockets: sockets.size,
    listenersClosed: !server.listening,
    esmConstructorIdentical: true,
  }),
);
