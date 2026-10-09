import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { token, until } from "./relay.mjs";

export async function credentialRotationAcceptance(api, tls, root) {
  const { WebSocketServer } = createRequire(`${root}/package.json`)("ws");
  const server = createServer(tls);
  const wss = new WebSocketServer({ noServer: true });
  const loopback = createTcpServer((socket) => socket.on("error", () => {}));
  const connections = new Set();
  const controls = [],
    data = [];
  const hostId = randomUUID(),
    publicOrigin = `https://${hostId}.devices.example`;
  let activeToken = token(),
    resolutions = 0;
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections.add(ws);
      ws.on("error", () => {});
      ws.on("close", () => connections.delete(ws));
      if (req.url === api.RELAY_CONNECT_PATH) {
        const record = { ws, token: req.headers.authorization, leaseId: token(), ready: false };
        controls.push(record);
        ws.on("message", (raw) => {
          if (JSON.parse(raw).type === "ready") record.ready = true;
        });
        ws.send(
          JSON.stringify({ type: "welcome", v: 1, hostId, publicOrigin, leaseId: record.leaseId }),
        );
      } else {
        data.push(req.headers.authorization);
        ws.close();
      }
    });
  });
  await new Promise((resolve) => loopback.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const lifetime = new AbortController();
  const target = {
    port: loopback.address().port,
    signal: lifetime.signal,
    setPublicBaseUrl: () => {},
  };
  const connector = api.createDeviceRelayConnector({
    relayOrigin: origin,
    hostId,
    publicOrigin,
    ca: tls.cert,
    getCredential: async (signal) => {
      signal.throwIfAborted();
      resolutions++;
      return activeToken;
    },
    localHost: target,
  });
  try {
    connector.start();
    await until(() => controls[0]?.ready);
    const firstToken = activeToken;
    activeToken = token();
    controls[0].ws.send(
      JSON.stringify({
        type: "open",
        v: 1,
        leaseId: controls[0].leaseId,
        streamId: token(),
        ticket: token(),
      }),
    );
    await until(() => data.length === 1);
    assert.equal(
      data[0],
      `Bearer ${firstToken}`,
      "data uses the credential authenticated by its own control connection",
    );
    controls[0].ws.terminate();
    await until(() => controls[1]?.ready);
    assert.equal(controls[1].token, `Bearer ${activeToken}`);
    assert.equal(resolutions, 2);
    await connector.close();
    let release;
    let acquisitionSignal;
    const blocked = api.createDeviceRelayConnector({
      relayOrigin: origin,
      hostId,
      publicOrigin,
      ca: tls.cert,
      localHost: target,
      getCredential: (signal) => {
        acquisitionSignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    blocked.start();
    await until(() => !!release);
    await blocked.close();
    assert.equal(acquisitionSignal.aborted, true);
    release(token());
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      controls.length,
      2,
      "a credential resolved after close cannot open a control socket",
    );
  } finally {
    await connector.close();
    lifetime.abort();
    for (const ws of connections) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => loopback.close(resolve));
  }
}
