import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import type { DeviceRelayConnectorOptions } from "./connector.js";
import { createRelayByteStream } from "./byte-stream.js";
import {
  RELAY_DATA_MAX_BYTES,
  RELAY_SETUP_TIMEOUT_MS,
  RELAY_STREAMS_PATH,
  type RelayControlMessage,
} from "./protocol.js";

const ERROR_DRAIN_TIMEOUT_MS = 2000;

export interface RelayLocalStream {
  close(): void;
  done: Promise<void>;
}

/** One fixed loopback connection. Never accept a target, URL, or port from control messages. */
export function openRelayStream(
  config: DeviceRelayConnectorOptions,
  message: Extract<RelayControlMessage, { type: "open" }>,
  failed: () => void,
): RelayLocalStream {
  const socket = connect({ host: "127.0.0.1", port: config.localHost.port });
  let ws: WebSocket | undefined;
  let bytes: Duplex | undefined;
  let disposed = false;
  let attached = false;
  let tcpClosed = false;
  let wsClosed = true;
  let drainingResponse = false;
  let errorDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const settle = () => {
    if (tcpClosed && wsClosed) resolveDone();
  };
  const close = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(errorDrainTimer);
    socket.destroy();
    bytes?.destroy();
    ws?.terminate();
  };
  const fail = () => {
    if (!disposed && !attached) failed();
    close();
  };
  const drainResponse = () => {
    if (disposed || drainingResponse || !bytes) return;
    drainingResponse = true;
    socket.unpipe(bytes);
    bytes.unpipe(socket);
    // An early HTTP rejection can arrive before the request finishes writing.
    // Preserve already-read response bytes instead of turning them into EPIPE
    // at the peer. HTTP framing still rejects genuinely truncated responses.
    // The dead TCP target receives no further body; discard inbound frames only
    // during this bounded WSS close handshake so they cannot stall its close.
    errorDrainTimer = setTimeout(close, ERROR_DRAIN_TIMEOUT_MS);
    errorDrainTimer.unref?.();
    bytes.resume();
    bytes.end();
  };
  const timer = setTimeout(fail, RELAY_SETUP_TIMEOUT_MS);
  socket.on("error", (error: NodeJS.ErrnoException) => {
    if (attached && socket.bytesRead > 0 && ["EPIPE", "ECONNRESET"].includes(error.code ?? ""))
      drainResponse();
    else fail();
  });
  socket.once("close", () => {
    tcpClosed = true;
    // A clean local EOF must flush queued response bytes before closing WSS.
    if (!attached) fail();
    else if (!socket.readableEnded || !socket.writableFinished) {
      if (socket.bytesRead > 0) drainResponse();
      else fail();
    }
    settle();
  });
  socket.once("connect", () => {
    if (disposed) return;
    const url = new URL(RELAY_STREAMS_PATH + message.streamId, config.relayOrigin);
    url.protocol = "wss:";
    wsClosed = false;
    ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.credential}`,
        "X-CodeShell-Relay-Lease": message.leaseId,
        "X-CodeShell-Relay-Ticket": message.ticket,
      },
      ca: config.ca,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: RELAY_DATA_MAX_BYTES,
      handshakeTimeout: RELAY_SETUP_TIMEOUT_MS,
    });
    ws.on("error", fail);
    ws.once("close", () => {
      wsClosed = true;
      clearTimeout(errorDrainTimer);
      // The stream drains received bytes before ending the local TCP socket.
      if (!attached) fail();
      settle();
    });
    ws.once("open", () => {
      if (disposed) return ws!.terminate();
      clearTimeout(timer);
      attached = true;
      bytes = createRelayByteStream(ws!);
      bytes.on("error", close);
      bytes.on("close", () => {
        if (bytes!.readableEnded && bytes!.writableFinished) socket.end();
        else close();
      });
      socket.pipe(bytes).pipe(socket);
    });
  });
  return { close, done };
}
