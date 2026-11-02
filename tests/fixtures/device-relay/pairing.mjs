import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { token, until } from "./relay.mjs";

/** Opt-in account pairing: advertised only when enabled, lease-bound, never a raw error. */
export async function pairingAcceptance(api, tls, root) {
  const { WebSocketServer } = createRequire(`${root}/package.json`)("ws");
  const server = createServer(tls);
  const wss = new WebSocketServer({ noServer: true });
  const loopback = createTcpServer((socket) => socket.on("error", () => {}));
  const connections = new Set();
  const controls = [];
  const hostId = randomUUID(),
    publicOrigin = `https://${hostId}.devices.example`,
    credential = token();
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections.add(ws);
      ws.on("error", () => {});
      ws.on("close", () => connections.delete(ws));
      const record = {
        ws,
        features: req.headers[api.RELAY_FEATURES_HEADER.toLowerCase()],
        leaseId: token(),
        ready: false,
        closed: false,
        replies: [],
      };
      controls.push(record);
      ws.on("close", () => (record.closed = true));
      ws.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.type === "ready") record.ready = true;
        else record.replies.push(message);
      });
      ws.send(
        JSON.stringify({ type: "welcome", v: 1, hostId, publicOrigin, leaseId: record.leaseId }),
      );
    });
  });
  await new Promise((resolve) => loopback.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const lifetime = new AbortController();
  const localHost = {
    port: loopback.address().port,
    signal: lifetime.signal,
    setPublicBaseUrl: () => {},
  };
  const pairingToken = token();
  let refuse = false;
  const enabled = api.createDeviceRelayConnector({
    relayOrigin: origin,
    hostId,
    publicOrigin,
    credential,
    ca: tls.cert,
    localHost,
    issuePairing: () => {
      if (refuse) throw new Error("rate limited");
      return { token: pairingToken, expiresAt: Date.now() + 60_000 };
    },
  });
  const disabled = api.createDeviceRelayConnector({
    relayOrigin: origin,
    hostId,
    publicOrigin,
    credential,
    ca: tls.cert,
    localHost,
  });
  try {
    enabled.start();
    await until(() => controls[0]?.ready);
    const first = controls[0];
    assert.equal(first.features, api.RELAY_FEATURE_PAIRING);
    const pair = (record, leaseId = record.leaseId) => {
      const requestId = token();
      record.ws.send(JSON.stringify({ type: "pair", v: 1, leaseId, requestId }));
      return requestId;
    };
    const issued = pair(first);
    await until(() => first.replies.length === 1);
    assert.equal(first.replies[0].type, "paired");
    assert.equal(first.replies[0].requestId, issued);
    assert.equal(first.replies[0].leaseId, first.leaseId);
    assert.equal(first.replies[0].token, pairingToken);
    refuse = true;
    const refused = pair(first);
    await until(() => first.replies.length === 2);
    assert.deepEqual(first.replies[1], {
      type: "pair-failed",
      v: 1,
      leaseId: first.leaseId,
      requestId: refused,
    });
    assert.equal(JSON.stringify(first.replies[1]).includes("rate limited"), false);
    pair(first, token());
    await until(() => first.closed);
    await enabled.close();

    disabled.start();
    await until(() => controls.at(-1) !== first && controls.at(-1)?.ready);
    const legacy = controls.at(-1);
    assert.equal(legacy.features, undefined, "pairing is not advertised unless enabled");
    pair(legacy);
    await until(() => legacy.closed);
    assert.equal(legacy.replies.length, 0);
  } finally {
    await enabled.close();
    await disabled.close();
    lifetime.abort();
    for (const ws of connections) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => loopback.close(resolve));
  }
}
