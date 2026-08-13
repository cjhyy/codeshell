import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { serveMobile } from "./mobile-static.js";
import { PairingTokenManager } from "./pairing.js";
import type { AccessPasscode } from "./access-passcode.js";
import type { TrustedDeviceStore } from "./trusted-device-store.js";
import type { MobileServerEvent } from "./types.js";
import type { MobileViewerIdentity } from "./viewer-identity.js";
import type { MobileUploadService } from "./mobile-upload-service.js";
import { parseMobileClientEvent } from "./mobile-client-event-validator.js";

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
    ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) ?? candidates[0];
}

export interface RemoteHostStartOptions {
  host: string;
  port: number;
  /**
   * "lan" (default) keeps the existing LAN behaviour unchanged. "tunnel" binds
   * 127.0.0.1 (cloudflared connects to loopback) and inserts a passcode gate in
   * front of every HTTP route and the WS upgrade.
   */
  mode?: "lan" | "tunnel";
  /** Required in tunnel mode: the public access gate. Ignored in lan mode. */
  passcode?: AccessPasscode;
}

export interface RemoteHostStarted {
  host: string;
  port: number;
  url: string;
  mode: "lan" | "tunnel";
}

export interface RemoteHostManagerOptions {
  devices: TrustedDeviceStore;
  onClientEvent: (event: unknown, ws: WebSocket) => void | Promise<void>;
  /**
   * Absolute path to the built mobile app (out/mobile). Defaults to the
   * sibling of the bundled main (out/main → ../mobile). Overridable for tests.
   */
  mobileRootDir?: string;
  /**
   * Dev only: when set (from scripts/dev.ts via MOBILE_DEV_URL), /mobile/* is
   * proxied to the mobile vite dev server for HMR instead of read from disk.
   */
  mobileDevUrl?: string;
  /** One-time upload tickets. The route remains behind the tunnel passcode gate. */
  uploads?: Pick<MobileUploadService, "acceptPut" | "cancelActiveTransfers">;
}

export class RemoteHostManager extends EventEmitter {
  private server?: Server;
  private wss?: WebSocketServer;
  private started?: RemoteHostStarted;
  private starting?: Promise<RemoteHostStarted>;
  private pairing = new PairingTokenManager();
  /** ws → authenticated device id. A socket absent here is unauthenticated. */
  private authed = new WeakMap<WebSocket, string>();
  /** Stable identity for each individual tab/socket, independent of device id. */
  private viewers = new WeakMap<WebSocket, string>();
  private nextViewerId = 1;
  /** deviceId → number of live authenticated sockets (a phone may open more
   *  than one). A device is "online" while its count is > 0. */
  private onlineCounts = new Map<string, number>();
  /** Public base URL (tunnel domain) used by createPairingUrl when set. */
  private publicBaseUrl?: string;
  /** Passcode gate, present only in tunnel mode. */
  private passcode?: AccessPasscode;
  /** Where the built mobile app lives (out/mobile). */
  private readonly mobileRootDir: string;
  /** Dev proxy target for /mobile (HMR); undefined in prod. */
  private readonly mobileDevUrl?: string;

  constructor(private readonly opts: RemoteHostManagerOptions) {
    super();
    // Bundled main is out/main/index.mjs → mobile app is the sibling out/mobile.
    const here = dirname(fileURLToPath(import.meta.url));
    this.mobileRootDir = opts.mobileRootDir ?? resolve(here, "../mobile");
    this.mobileDevUrl = opts.mobileDevUrl ?? process.env.MOBILE_DEV_URL;
  }

  /** Device ids with at least one live socket right now. */
  onlineDeviceIds(): string[] {
    return [...this.onlineCounts.keys()];
  }

  /** Register a live socket for a device; emits `online-change` only when the
   *  device transitions offline→online (first socket). */
  markOnline(deviceId: string): void {
    const prev = this.onlineCounts.get(deviceId) ?? 0;
    this.onlineCounts.set(deviceId, prev + 1);
    if (prev === 0) this.emit("online-change", this.onlineDeviceIds());
  }

  /** Drop a socket for a device; emits `online-change` only when its last
   *  socket goes away (online→offline). */
  markOffline(deviceId: string): void {
    const prev = this.onlineCounts.get(deviceId) ?? 0;
    if (prev <= 1) {
      if (this.onlineCounts.delete(deviceId)) {
        this.emit("online-change", this.onlineDeviceIds());
        this.emit("device-offline", deviceId);
      }
    } else {
      this.onlineCounts.set(deviceId, prev - 1);
    }
  }

  async start(options: RemoteHostStartOptions): Promise<RemoteHostStarted> {
    if (this.started) return this.started;
    if (this.starting) return this.starting;
    const attempt = this.startOnce(options);
    this.starting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.starting === attempt) this.starting = undefined;
    }
  }

  private async startOnce(options: RemoteHostStartOptions): Promise<RemoteHostStarted> {
    const tunnel = options.mode === "tunnel";
    this.passcode = tunnel ? options.passcode : undefined;
    const gate = this.passcode;
    const server = createServer((req, res) => {
      // Tunnel mode: a passcode gate sits in front of EVERY route. The gate
      // either allows (returns true) or writes its own 401/403 challenge.
      if (gate && !gate.gate(req, res)) return;
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const uploadPath = req.url
        ? new URL(req.url, "http://localhost").pathname.match(
            /^\/api\/mobile\/uploads\/([A-Za-z0-9_-]+)$/,
          )
        : null;
      if (uploadPath && this.opts.uploads) {
        void this.opts.uploads.acceptPut(uploadPath[1]!, req, res);
        return;
      }
      // The mobile app is built/served with vite base "/mobile/", so ALL of its
      // assets — and in dev, vite's HMR/module URLs — live under the /mobile
      // prefix. A single prefix route serves prod (static out/mobile) and dev
      // (proxy to the mobile vite server) symmetrically. Tunnel mode never
      // proxies dev: Vite's HMR socket and @fs module URLs don't survive a
      // public trycloudflare hop, so a public tunnel always serves the build.
      // Match the route family exactly ("/mobile", "/mobile/…", "/mobile?…",
      // "/mobile#…") — NOT a sibling like "/mobilexyz", which falls to 404.
      if (req.url && /^\/mobile(?:[/?#]|$)/.test(req.url)) {
        serveMobile(req, res, {
          rootDir: this.mobileRootDir,
          devUrl: tunnel ? undefined : this.mobileDevUrl,
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    // In tunnel mode we must gate the WS handshake too. `noServer` lets us run
    // the passcode check during the HTTP `upgrade` event before completing the
    // handshake; in lan mode behaviour is unchanged (the same path/server bind).
    this.wss = gate
      ? new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
      : new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024 });
    // ws re-emits its HTTP server's bind errors. Without an error listener a
    // handled EADDRINUSE rejection still becomes an uncaught EventEmitter error.
    this.wss.on("error", (error) => this.emit("host-error", error));
    if (gate) {
      server.on("upgrade", (req, socket, head) => {
        let isWebSocketPath = false;
        try {
          isWebSocketPath = new URL(req.url ?? "", "http://localhost").pathname === "/ws";
        } catch {
          // Invalid request targets are not valid WebSocket endpoints.
        }
        if (!isWebSocketPath) {
          socket.destroy();
          return;
        }
        if (
          !gate.allows(
            req as unknown as {
              url?: string;
              headers: Record<string, string | string[] | undefined>;
            },
          )
        ) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit("connection", ws, req);
        });
      });
    }
    this.wss.on("connection", (ws) => {
      const viewerId = `viewer-${this.nextViewerId++}`;
      this.viewers.set(ws, viewerId);
      ws.on("message", (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          return;
        }
        const event = parseMobileClientEvent(parsed);
        if (!event) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid client event" }));
          return;
        }
        // Pairing/auth are handled inline and bind device identity to this
        // socket. Everything else is gated: an unauthenticated socket cannot
        // send chat/approval/run/job events (design §6.1).
        let reply: MobileServerEvent | undefined;
        try {
          reply = this.handleClientEvent(event);
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Client event failed" }));
          return;
        }
        if (event.type === "auth.device" && reply?.type === "auth.ok") {
          if (!this.authed.has(ws)) this.markOnline(reply.device.id);
          this.authed.set(ws, reply.device.id);
        }
        // Pairing also yields a live, identified socket → count it online.
        if (event.type === "pair.complete" && reply?.type === "pair.ok") {
          if (!this.authed.has(ws)) this.markOnline(reply.device.id);
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
        try {
          const dispatched = this.opts.onClientEvent(
            { ...event, deviceId: this.authed.get(ws), viewerId: this.viewers.get(ws) },
            ws,
          );
          void Promise.resolve(dispatched).catch(() => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "error", message: "Client event failed" }));
            }
          });
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Client event failed" }));
        }
      });
      ws.on("close", () => {
        this.releaseSocket(ws);
      });
    });
    this.server = server;
    // host: "lan" → resolve the Mac's real LAN IPv4 so a phone on the same
    // Wi-Fi can reach us. We bind that concrete address (never 0.0.0.0). If no
    // LAN interface is found, fall back to the requested host (e.g. localhost).
    const bindHost = tunnel
      ? "127.0.0.1"
      : options.host === "lan"
        ? (resolveLanHost() ?? "127.0.0.1")
        : options.host;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(options.port, bindHost, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      for (const client of this.wss?.clients ?? []) client.terminate();
      try {
        this.wss?.close();
      } catch {
        // A noServer WebSocketServer may not have entered a running state yet.
      }
      server.closeAllConnections?.();
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
      if (this.server === server) this.server = undefined;
      this.wss = undefined;
      this.passcode = undefined;
      throw error;
    }
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : options.port;
    this.started = {
      host: bindHost,
      port,
      url: `http://${bindHost}:${port}`,
      mode: tunnel ? "tunnel" : "lan",
    };
    return this.started;
  }

  /**
   * Override the base URL used to build pairing URLs (tunnel mode points this
   * at the `https://*.trycloudflare.com` domain so the QR encodes the public
   * address, not the loopback bind). Pass undefined to clear it.
   */
  setPublicBaseUrl(url?: string): void {
    this.publicBaseUrl = url;
  }

  createPairingUrl(): { token: string; url: string; expiresAt: number } {
    if (!this.started) throw new Error("Remote host is not running");
    const token = this.pairing.createToken();
    const base = this.publicBaseUrl ?? this.started.url;
    return {
      token: token.value,
      expiresAt: token.expiresAt,
      url: `${base}/mobile?pairing=${token.value}`,
    };
  }

  /**
   * Handle pairing/auth client events. Returns a server event for those two
   * cases (consumed inline by the WS layer) or `undefined` for events the
   * caller should route elsewhere. Pairing tokens are one-use; auth checks the
   * trusted-device store (which rejects revoked devices), so the remote host
   * never executes tools itself — it only gates transport.
   */
  handleClientEvent(input: unknown): MobileServerEvent | undefined {
    const event = parseMobileClientEvent(input);
    if (!event) return { type: "error", message: "Invalid client event" };
    if (event.type === "pair.complete") {
      let device;
      try {
        device = this.pairing.commit(event.token, () =>
          this.opts.devices.addDevice({
            name: event.name,
            secretHash: event.secretHash,
          }),
        );
      } catch {
        return { type: "pair.failed", message: "Trusted device store is unavailable" };
      }
      if (!device) {
        return { type: "pair.failed", message: "Pairing token expired or invalid" };
      }
      return { type: "pair.ok", device };
    }
    if (event.type === "auth.device") {
      let device;
      try {
        device = this.opts.devices.authenticate(event.deviceId, event.secretHash);
      } catch {
        return { type: "auth.failed", message: "Trusted device store is unavailable" };
      }
      if (!device) return { type: "auth.failed", message: "Device is not trusted" };
      return { type: "auth.ok", device };
    }
    return undefined;
  }

  /** Broadcast a server event to every connected, authenticated mobile socket. */
  broadcast(event: MobileServerEvent): void {
    this.broadcastRaw(JSON.stringify(event));
  }

  /** Send a server event to ONLY the sockets belonging to one device. Used for
   *  per-device replies (chat.accepted, session.list.ok, permission.mode, …) so
   *  one phone's session/permission state never leaks onto another's screen.
   *  A device with no live socket (raced a disconnect) is a silent no-op. */
  sendToDevice(deviceId: string, event: MobileServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss?.clients ?? []) {
      if (client.readyState === client.OPEN && this.authed.get(client) === deviceId) {
        client.send(payload);
      }
    }
  }

  /** Send a raw JSON-RPC worker line to ONLY one authenticated device. */
  sendRawToDevice(deviceId: string, payload: string): void {
    for (const client of this.wss?.clients ?? []) {
      if (client.readyState === client.OPEN && this.authed.get(client) === deviceId) {
        client.send(payload);
      }
    }
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

  private releaseSocket(ws: WebSocket): void {
    const deviceId = this.authed.get(ws);
    const viewerId = this.viewers.get(ws);
    this.authed.delete(ws);
    this.viewers.delete(ws);
    if (!deviceId) return;
    if (viewerId) {
      this.emit("viewer-offline", { deviceId, viewerId } satisfies MobileViewerIdentity);
    }
    this.markOffline(deviceId);
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const server = this.server;
    // Forcibly drop live WS sockets first. wss.close() alone waits for clients
    // to disconnect, so a phone left connected would hang stop() indefinitely.
    // terminate() severs each immediately.
    for (const client of this.wss?.clients ?? []) {
      // Release viewer-owned resources synchronously. The later socket close
      // event is idempotent because releaseSocket removes its auth binding.
      this.releaseSocket(client);
      client.terminate();
    }
    this.wss?.close();
    this.wss = undefined;
    this.server = undefined;
    this.started = undefined;
    this.publicBaseUrl = undefined;
    this.passcode = undefined;
    // releaseSocket normally empties this map. Retain a defensive fallback for
    // manually injected bookkeeping (tests / future non-WS transports).
    for (const deviceId of this.onlineCounts.keys()) this.emit("device-offline", deviceId);
    this.onlineCounts.clear();
    await this.opts.uploads?.cancelActiveTransfers();
    if (!server) return;
    // server.close() only stops accepting new connections and waits for live
    // ones to end — a lingering upgraded/keep-alive socket keeps its callback
    // from ever firing. Destroy any remaining connections so close() resolves.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): RemoteHostStarted | undefined {
    return this.started;
  }
}
