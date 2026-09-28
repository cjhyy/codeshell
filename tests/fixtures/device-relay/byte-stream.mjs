import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

export async function byteStreamAcceptance(root, tls, api) {
  const { WebSocket, WebSocketServer } = createRequire(`${root}/package.json`)("ws");
  const server = createServer(tls);
  const wss = new WebSocketServer({
    server,
    maxPayload: api.RELAY_DATA_MAX_BYTES,
    perMessageDeflate: false,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const length of [16 * 1024, 32 * 1024, 64 * 1024, 96 * 1024, 1024 * 1024 + 13]) {
      const connected = once(wss, "connection");
      const client = new WebSocket(`wss://127.0.0.1:${server.address().port}`, {
        ca: tls.cert,
        maxPayload: api.RELAY_DATA_MAX_BYTES,
        perMessageDeflate: false,
      });
      const [peer] = await connected;
      await once(client, "open");
      const writer = api.createRelayByteStream(peer);
      const reader = api.createRelayByteStream(client);
      writer.on("error", () => {});
      reader.on("error", () => {});
      try {
        const payload = Buffer.alloc(length, 0x61);
        const sent = new Promise((resolve, reject) =>
          writer.end(payload, (error) => (error ? reject(error) : resolve())),
        );
        await delay(80);
        const chunks = [];
        for await (const chunk of reader) {
          chunks.push(chunk);
          await delay(5);
        }
        await sent;
        assert.deepEqual(Buffer.concat(chunks), payload, `slow EOF reader lost bytes at ${length}`);
      } finally {
        reader.destroy();
        writer.destroy();
        client.terminate();
        peer.terminate();
      }
    }
    // Abrupt network loss must finish the Duplex lifecycle, not wait for a TCP
    // finish event that will never arrive on an already-destroyed TLS socket.
    const connected = once(wss, "connection");
    const client = new WebSocket(`wss://127.0.0.1:${server.address().port}`, { ca: tls.cert });
    const [peer] = await connected;
    await once(client, "open");
    const reader = api.createRelayByteStream(client);
    reader.on("error", () => {});
    const closed = once(reader, "close");
    reader.resume();
    peer.terminate();
    await closed;
    console.log("PASS delayed readers at 16/32/64/96KiB and 1MiB+tail, abrupt data disconnect");
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
}
