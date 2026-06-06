import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { mobileRemoteHtml } from "./mobile-ui.js";
import { PairingTokenManager } from "./pairing.js";
import type { TrustedDeviceStore } from "./trusted-device-store.js";

export interface RemoteHostStartOptions {
  host: string;
  port: number;
}

export interface RemoteHostStarted {
  host: string;
  port: number;
  url: string;
}

export interface RemoteHostManagerOptions {
  devices: TrustedDeviceStore;
  onClientEvent: (event: unknown, ws: WebSocket) => void;
}

export class RemoteHostManager {
  private server?: Server;
  private wss?: WebSocketServer;
  private started?: RemoteHostStarted;
  private pairing = new PairingTokenManager();

  constructor(private readonly opts: RemoteHostManagerOptions) {}

  async start(options: RemoteHostStartOptions): Promise<RemoteHostStarted> {
    if (this.started) return this.started;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/mobile")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(mobileRemoteHtml());
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        try {
          this.opts.onClientEvent(JSON.parse(String(raw)), ws);
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : options.port;
    this.started = { host: options.host, port, url: `http://${options.host}:${port}` };
    return this.started;
  }

  createPairingUrl(): { token: string; url: string; expiresAt: number } {
    if (!this.started) throw new Error("Remote host is not running");
    const token = this.pairing.createToken();
    return {
      token: token.value,
      expiresAt: token.expiresAt,
      url: `${this.started.url}/mobile?pairing=${token.value}`,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.wss?.close();
    this.wss = undefined;
    this.server = undefined;
    this.started = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): RemoteHostStarted | undefined {
    return this.started;
  }
}
