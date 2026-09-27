import assert from "node:assert/strict";
import { createServer } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

export const token = () => randomBytes(32).toString("base64url");
export async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for relay state");
}
export async function relayFixture(root, tls, api) {
  const { WebSocketServer } = createRequire(`${root}/package.json`)("ws");
  const server = createServer(tls);
  const controlWss = new WebSocketServer({
    noServer: true,
    maxPayload: api.RELAY_CONTROL_MAX_BYTES,
    perMessageDeflate: false,
  });
  const dataWss = new WebSocketServer({
    noServer: true,
    maxPayload: api.RELAY_DATA_MAX_BYTES,
    perMessageDeflate: false,
  });
  const pending = new Map();
  const records = [];
  const connections = new Set();
  const credential = token(),
    hostId = randomUUID(),
    publicOrigin = `https://${hostId}.devices.test`;
  let welcomeOverride;
  let handshakeDelay = false;
  let dataFrames = 0,
    maxFrame = 0,
    failed = 0;
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers.authorization, `Bearer ${credential}`);
    assert.ok(!req.url.includes("?"));
    if (req.url === api.RELAY_CONNECT_PATH) {
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        connections.add(ws);
        const record = { ws, leaseId: token(), ready: false, streams: new Set() };
        records.push(record);
        ws.on("error", () => {});
        ws.on("message", (raw) => {
          const event = api.parseRelayControlMessage(JSON.parse(raw));
          assert.equal(event.leaseId, record.leaseId);
          if (event.type === "ready") record.ready = true;
          else if (event.type === "failed") failed++;
          else assert.fail("Unexpected computer control event");
        });
        ws.on("close", () => {
          record.ready = false;
          connections.delete(ws);
          for (const data of record.streams) data.terminate();
        });
        if (!handshakeDelay)
          ws.send(
            JSON.stringify({
              type: "welcome",
              v: 1,
              hostId,
              publicOrigin,
              leaseId: record.leaseId,
              ...welcomeOverride,
            }),
          );
      });
      return;
    }
    const id = req.url.slice(api.RELAY_STREAMS_PATH.length);
    const entry = pending.get(id);
    if (
      !entry ||
      entry.record !== records.at(-1) ||
      !entry.record.ready ||
      req.headers["x-codeshell-relay-lease"] !== entry.record.leaseId ||
      req.headers["x-codeshell-relay-ticket"] !== entry.ticket
    ) {
      socket.destroy();
      return;
    }
    pending.delete(id);
    dataWss.handleUpgrade(req, socket, head, (ws) => {
      connections.add(ws);
      entry.record.streams.add(ws);
      ws.on("error", () => {});
      ws.on("close", () => {
        connections.delete(ws);
        entry.record.streams.delete(ws);
      });
      ws.on("message", (raw, binary) => {
        assert.ok(binary);
        dataFrames++;
        maxFrame = Math.max(maxFrame, raw.length);
      });
      const stream = api.createRelayByteStream(ws);
      stream.on("error", () => {});
      entry.resolve({ stream, ws });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `https://127.0.0.1:${server.address().port}`,
    credential,
    hostId,
    publicOrigin,
    records,
    get current() {
      return records.at(-1);
    },
    get failed() {
      return failed;
    },
    get maxFrame() {
      return maxFrame;
    },
    get dataFrames() {
      return dataFrames;
    },
    set welcomeOverride(value) {
      welcomeOverride = value;
    },
    set handshakeDelay(value) {
      handshakeDelay = value;
    },
    open(extra = {}) {
      const record = records.at(-1);
      assert.ok(record.ready);
      const streamId = token(),
        ticket = token();
      const opened = new Promise((resolve) => pending.set(streamId, { record, ticket, resolve }));
      record.ws.send(
        JSON.stringify({ type: "open", v: 1, leaseId: record.leaseId, streamId, ticket, ...extra }),
      );
      return opened;
    },
    send(event) {
      records.at(-1).ws.send(JSON.stringify(event));
    },
    async close() {
      for (const ws of connections) ws.terminate();
      await Promise.all([
        new Promise((resolve) => controlWss.close(resolve)),
        new Promise((resolve) => dataWss.close(resolve)),
      ]);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
