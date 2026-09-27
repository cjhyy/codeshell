import assert from "node:assert/strict";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { token, until } from "./relay.mjs";

/** Native Node WSS handshakes: only authenticated TLS 401/403 retire credentials. */
export async function authRefusalAcceptance(api, tls) {
  for (const status of [401, 403, 503]) {
    let requests = 0;
    const sockets = new Set();
    const server = createServer(tls);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (_req, socket) => {
      requests++;
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const states = [];
    const connector = api.createDeviceRelayConnector({
      relayOrigin: `https://127.0.0.1:${server.address().port}`,
      publicOrigin: "https://computer.devices.test",
      hostId: randomUUID(),
      credential: token(),
      ca: tls.cert,
      localHost: {
        port: 9,
        signal: new AbortController().signal,
        setPublicBaseUrl() {
          assert.fail("rejected handshake cannot authorize a local target");
        },
      },
      onState: (state) => states.push(state),
    });
    try {
      connector.start();
      if (status === 503) {
        await until(() => requests >= 2);
        assert.ok(states.includes("disconnected"));
        assert.ok(!states.includes("unauthorized"));
      } else {
        await until(() => states.includes("unauthorized"));
        await delay(800);
        assert.equal(requests, 1, "revoked credentials must not reconnect");
        assert.ok(!states.includes("ready"));
      }
    } finally {
      await connector.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
