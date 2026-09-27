import type { ConnectionOptions } from "node:tls";
import { WebSocket } from "ws";
import { openRelayStream, type RelayLocalStream } from "./local-stream.js";
import {
  isRelayHostId,
  isRelayOrigin,
  isRelayToken,
  parseRelayControlMessage,
  RELAY_CONNECT_PATH,
  RELAY_CONTROL_MAX_BYTES,
  RELAY_MAX_STREAMS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PONG_TIMEOUT_MS,
  RELAY_SETUP_TIMEOUT_MS,
} from "./protocol.js";

export type DeviceRelayState = "connecting" | "ready" | "disconnected" | "closed";
/** Issued by RemoteHostManager.relayTarget(), bound to one running relay Host. */
export interface RelayLocalTarget {
  readonly port: number;
  readonly signal: AbortSignal;
  setPublicBaseUrl(origin: string): void;
}

export interface DeviceRelayConnectorOptions {
  /** Directory HTTPS origin, never a relay-selected destination. */
  relayOrigin: string;
  hostId: string;
  publicOrigin: string;
  credential: string;
  /** Target is always 127.0.0.1; stopping its Host revokes this capability. */
  localHost: RelayLocalTarget;
  /** Additional trusted CA for private installations; TLS verification stays enabled. */
  ca?: ConnectionOptions["ca"];
  onState?: (state: DeviceRelayState) => void;
}
export interface DeviceRelayConnector {
  /** Idempotent while running. Callers must await close before restarting. */
  start(): void;
  /** Fences callbacks immediately, then waits for control/TCP/data connections to close. */
  close(): Promise<void>;
}

export function createDeviceRelayConnector(
  options: DeviceRelayConnectorOptions,
): DeviceRelayConnector {
  if (
    !isRelayOrigin(options.relayOrigin) ||
    !isRelayOrigin(options.publicOrigin) ||
    !isRelayHostId(options.hostId) ||
    !isRelayToken(options.credential) ||
    !options.localHost ||
    !Number.isInteger(options.localHost.port) ||
    options.localHost.port < 1 ||
    options.localHost.port > 65535
  ) {
    throw new Error("Invalid device relay configuration");
  }
  // Do not let a caller's later object mutation change authenticated endpoints.
  const config = {
    ...options,
    localHost: {
      port: options.localHost.port,
      signal: options.localHost.signal,
      setPublicBaseUrl: options.localHost.setPublicBaseUrl.bind(options.localHost),
    },
  };
  let generation = 0;
  let running = false;
  let closing: Promise<void> | undefined;
  let control: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const pending = new Set<Promise<void>>();
  const streams = new Set<RelayLocalStream>();
  const state = (value: DeviceRelayState) => {
    try {
      config.onState?.(value);
    } catch {
      /* Observers cannot retain live transports. */
    }
  };
  const track = (done: Promise<void>) => {
    pending.add(done);
    void done.finally(() => pending.delete(done));
  };
  const connect = (attempt: number) => {
    if (!running || generation !== attempt || config.localHost.signal.aborted) return;
    state("connecting");
    if (!running || generation !== attempt || config.localHost.signal.aborted) return;
    const url = new URL(RELAY_CONNECT_PATH, config.relayOrigin);
    url.protocol = "wss:";
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.credential}` },
      ca: config.ca,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: RELAY_CONTROL_MAX_BYTES,
      handshakeTimeout: RELAY_SETUP_TIMEOUT_MS,
    });
    control = ws;
    const current = () =>
      running && generation === attempt && control === ws && !config.localHost.signal.aborted;
    let leaseId: string | undefined;
    let lastPong = Date.now();
    const owned = new Map<string, RelayLocalStream>();
    const deadline = setTimeout(() => ws.terminate(), RELAY_SETUP_TIMEOUT_MS);
    const heartbeat = setInterval(() => {
      if (!current() || Date.now() - lastPong >= RELAY_PONG_TIMEOUT_MS) return ws.terminate();
      if (ws.readyState === ws.OPEN) ws.ping();
    }, RELAY_PING_INTERVAL_MS);
    track(
      new Promise<void>((resolve) =>
        ws.once("close", () => {
          clearTimeout(deadline);
          clearInterval(heartbeat);
          for (const stream of owned.values()) stream.close();
          if (current()) {
            control = undefined;
            state("disconnected");
            if (!running || generation !== attempt || control || config.localHost.signal.aborted)
              return resolve();
            const delay = Math.min(30_000, 500 * 2 ** Math.min(failures++, 6));
            reconnect = setTimeout(() => connect(attempt), delay * (0.75 + Math.random() * 0.5));
          }
          resolve();
        }),
      ),
    );
    ws.on("error", () => {
      /* close owns cleanup/retry; never log credentials or request data. */
    });
    ws.on("pong", () => {
      if (current()) lastPong = Date.now();
    });
    ws.on("message", (data, binary) => {
      if (!current()) return ws.terminate();
      let message;
      try {
        if (binary || Buffer.byteLength(data.toString()) > RELAY_CONTROL_MAX_BYTES)
          throw new Error("Invalid control frame");
        message = parseRelayControlMessage(JSON.parse(data.toString()));
      } catch {
        ws.terminate();
        return;
      }
      if (!message) return ws.terminate();
      if (message.type === "welcome" && !leaseId) {
        if (message.hostId !== config.hostId || message.publicOrigin !== config.publicOrigin)
          return ws.terminate();
        try {
          config.localHost.setPublicBaseUrl(message.publicOrigin);
        } catch {
          ws.terminate();
          return;
        }
        if (!current()) return ws.terminate();
        leaseId = message.leaseId;
        clearTimeout(deadline);
        ws.send(JSON.stringify({ type: "ready", v: 1, leaseId }));
        failures = 0;
        state("ready");
        return;
      }
      if (
        message.type !== "open" ||
        !leaseId ||
        message.leaseId !== leaseId ||
        owned.has(message.streamId)
      )
        return ws.terminate();
      const failed = () => {
        if (current() && ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: "failed", v: 1, leaseId, streamId: message.streamId }));
      };
      if (owned.size >= RELAY_MAX_STREAMS) return failed();
      const stream = openRelayStream(config, message, failed);
      owned.set(message.streamId, stream);
      streams.add(stream);
      const done = stream.done.then(() => {
        owned.delete(message.streamId);
        streams.delete(stream);
      });
      track(done);
    });
  };
  const connector: DeviceRelayConnector = {
    start() {
      config.localHost.signal.throwIfAborted();
      if (running) return;
      if (closing) throw new Error("Device relay connector is closing");
      config.localHost.signal.addEventListener("abort", revoke, { once: true });
      running = true;
      failures = 0;
      connect(++generation);
    },
    close() {
      if (closing) return closing;
      running = false;
      config.localHost.signal.removeEventListener("abort", revoke);
      generation++;
      clearTimeout(reconnect);
      reconnect = undefined;
      control?.terminate();
      control = undefined;
      for (const stream of streams) stream.close();
      closing = Promise.all([...pending])
        .then(() => {
          state("closed");
        })
        .finally(() => {
          closing = undefined;
        });
      return closing;
    },
  };
  function revoke() {
    void connector.close();
  }
  return connector;
}
