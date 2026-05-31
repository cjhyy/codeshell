/**
 * TcpTransport — newline-delimited JSON over a TCP socket (Duplex stream).
 *
 * Phase 6 of the automation plan: lets the same AgentServer that runs over
 * stdio (agent-server-stdio) also serve over a network socket, so a headless
 * host can be reached by a remote/local client. The transport implements the
 * 3-method Transport interface (send/onMessage/close); AgentServer is unchanged
 * (§0 of docs/automation-plan-2026-05-31.md).
 *
 * Framing mirrors StdioTransport: one JSON value per line. The socket core is
 * separated from listen/accept (`listenTcp`) so the framing is unit-testable
 * against any Duplex without opening a real port.
 *
 * v1 security: intended for localhost / SSH-tunnel use only. There is NO
 * authentication here — do not bind to a public interface without adding auth.
 */

import { createServer, type Server, type Socket } from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Duplex } from "node:stream";
import type { Transport } from "./transport.js";
import type { RpcMessage } from "./types.js";

/** Wrap a connected Duplex socket as a Transport (NDJSON framing). */
export class SocketTransport implements Transport {
  private rl: ReadlineInterface;
  private handlers: Array<(message: RpcMessage) => void> = [];

  constructor(private readonly socket: Duplex) {
    this.rl = createInterface({ input: socket });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as RpcMessage;
        for (const handler of this.handlers) handler(msg);
      } catch {
        // Skip malformed lines (same policy as StdioTransport).
      }
    });
  }

  send(message: RpcMessage): void {
    this.socket.write(JSON.stringify(message) + "\n");
  }

  onMessage(handler: (message: RpcMessage) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.rl.close();
    this.handlers = [];
    this.socket.end();
  }
}

export interface TcpListenResult {
  server: Server;
  /** The actual port bound (useful when 0 was requested). */
  port: number;
  close(): Promise<void>;
}

/**
 * Listen on host:port and invoke `onConnection` with a SocketTransport for each
 * accepted client. Resolves once listening. Defaults to 127.0.0.1 — never bind
 * 0.0.0.0 without auth (v1 has none).
 */
export function listenTcp(
  opts: { port: number; host?: string },
  onConnection: (transport: SocketTransport, socket: Socket) => void,
): Promise<TcpListenResult> {
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      onConnection(new SocketTransport(socket), socket);
    });
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
