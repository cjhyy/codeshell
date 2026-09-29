import { Duplex } from "node:stream";
import { createWebSocketStream, type WebSocket } from "ws";
import { RELAY_DATA_CHUNK_BYTES, RELAY_DATA_MAX_BYTES } from "./protocol.js";

/**
 * One raw TCP connection over one authenticated, OPEN data WebSocket. Callers
 * must create ws with maxPayload=RELAY_DATA_MAX_BYTES and compression disabled.
 * Native ws/Node streams supply backpressure; there is no multiplex/credit queue.
 * EOF closes the entire connection (HTTP framing does not use stream EOF).
 */
export function createRelayByteStream(ws: WebSocket): Duplex {
  if (ws.readyState !== ws.OPEN) throw new Error("Relay data WebSocket is not open");
  // Register before createWebSocketStream so invalid frames never reach consumers.
  ws.on("message", (data, binary) => {
    const size = Array.isArray(data)
      ? data.reduce((total, item) => total + item.length, 0)
      : data.byteLength;
    if (!binary || size > RELAY_DATA_MAX_BYTES) {
      stream.destroy(new Error("Invalid relay data frame"));
    }
  });
  const wire = createWebSocketStream(ws, {
    highWaterMark: RELAY_DATA_MAX_BYTES,
    // The outer Duplex owns EOF: inner auto-finalization can race unread
    // outer buffers or wait forever for finish after an abrupt WS close.
    allowHalfOpen: true,
  });
  const stream = new Duplex({
    highWaterMark: RELAY_DATA_MAX_BYTES,
    allowHalfOpen: false,
    read() {
      wire.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      const next = (error?: Error | null): void => {
        if (error) return callback(error);
        if (offset === chunk.length) return callback();
        const end = Math.min(offset + RELAY_DATA_CHUNK_BYTES, chunk.length);
        const part = chunk.subarray(offset, end);
        offset = end;
        wire.write(part, next);
      };
      next();
    },
    final(callback) {
      if (ws.readyState === ws.CLOSED) callback();
      else wire.end(callback);
    },
    destroy(error, callback) {
      wire.destroy();
      callback(error);
    },
  });
  wire.on("data", (chunk: Buffer) => {
    if (!stream.destroyed && !stream.push(chunk)) wire.pause();
  });
  wire.on("end", () => stream.push(null));
  wire.on("error", (error) => stream.destroy(error));
  wire.on("close", () => {
    // A normal EOF may still be buffered by a slow outer reader. Preserve it.
    if (!wire.readableEnded) stream.destroy();
  });
  return stream;
}
