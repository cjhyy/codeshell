import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { mobileRemoteHtml } from "./mobile-ui.js";
import { PairingTokenManager } from "./pairing.js";
import type { TrustedDeviceStore } from "./trusted-device-store.js";
import type { MobileClientEvent, MobileServerEvent } from "./types.js";

/**
 * Pick the Mac's real LAN IPv4 so a phone on the same Wi-Fi can reach the
 * remote host. We bind to a concrete LAN address (NOT 0.0.0.0) per the design's
 * §6.5 network-safety rule. Excludes loopback (127.x), link-local (169.254.x),
 * and common VPN/tunnel ranges (198.18.x carrier-grade test net used by some
 * VPN clients) so we don't advertise an address the phone can't route to.
 * Returns undefined if no suitable interface is found.
 */
export function resolveLanHost(): string | undefined {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (ip.startsWith("127.") || ip.startsWith("169.254.") || ip.startsWith("198.18.")) {
        continue;
      }
      candidates.push(ip);
    }
  }
  // Prefer private LAN ranges (192.168.x, 10.x, 172.16-31.x) over anything else.
  const isPrivate = (ip: string) =>
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) ?? candidates[0];
}

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
  /** ws → authenticated device id. A socket absent here is unauthenticated. */
  private authed = new WeakMap<WebSocket, string>();

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
        let event: MobileClientEvent;
        try {
          event = JSON.parse(String(raw)) as MobileClientEvent;
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          return;
        }
        // Pairing/auth are handled inline and bind device identity to this
        // socket. Everything else is gated: an unauthenticated socket cannot
        // send chat/approval/run/job events (design §6.1).
        const reply = this.handleClientEvent(event);
        if (event.type === "auth.device" && reply?.type === "auth.ok") {
          this.authed.set(ws, reply.device.id);
        }
        if (reply) {
          ws.send(JSON.stringify(reply));
          return;
        }
        if (!this.authed.has(ws)) {
          ws.send(JSON.stringify({ type: "auth.failed", message: "Not authenticated" }));
          return;
        }
        // Authenticated, non-auth event → hand to the main dispatcher, which
        // routes chat/approval into the existing run/permission path.
        this.opts.onClientEvent({ ...event, deviceId: this.authed.get(ws) }, ws);
      });
      ws.on("close", () => {
        this.authed.delete(ws);
      });
    });
    this.server = server;
    // host: "lan" → resolve the Mac's real LAN IPv4 so a phone on the same
    // Wi-Fi can reach us. We bind that concrete address (never 0.0.0.0). If no
    // LAN interface is found, fall back to the requested host (e.g. localhost).
    const bindHost =
      options.host === "lan" ? (resolveLanHost() ?? "127.0.0.1") : options.host;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, bindHost, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : options.port;
    this.started = { host: bindHost, port, url: `http://${bindHost}:${port}` };
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

  /**
   * Handle pairing/auth client events. Returns a server event for those two
   * cases (consumed inline by the WS layer) or `undefined` for events the
   * caller should route elsewhere. Pairing tokens are one-use; auth checks the
   * trusted-device store (which rejects revoked devices), so the remote host
   * never executes tools itself — it only gates transport.
   */
  handleClientEvent(event: MobileClientEvent): MobileServerEvent | undefined {
    if (event.type === "pair.complete") {
      if (!this.pairing.consume(event.token)) {
        return { type: "pair.failed", message: "Pairing token expired or invalid" };
      }
      const device = this.opts.devices.addDevice({
        name: event.name,
        secretHash: event.secretHash,
      });
      return { type: "pair.ok", device };
    }
    if (event.type === "auth.device") {
      const device = this.opts.devices.authenticate(event.deviceId, event.secretHash);
      if (!device) return { type: "auth.failed", message: "Device is not trusted" };
      return { type: "auth.ok", device };
    }
    return undefined;
  }

  /** Broadcast a server event to every connected, authenticated mobile socket. */
  broadcast(event: MobileServerEvent): void {
    this.broadcastRaw(JSON.stringify(event));
  }

  /** Broadcast a raw line (e.g. a mirrored worker→renderer JSON-RPC line) to
   *  every authenticated mobile socket. Unauthenticated sockets are skipped so
   *  a half-paired client never sees session output. */
  broadcastRaw(payload: string): void {
    for (const client of this.wss?.clients ?? []) {
      if (client.readyState === client.OPEN && this.authed.has(client)) {
        client.send(payload);
      }
    }
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
