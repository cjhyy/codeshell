import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";

export const DESKTOP_CONTROL_PROTOCOL_VERSION = 1;

export interface MobileRemoteOpenResult {
  url: string;
  pairingUrl: string;
  expiresAt: number;
  mode: "tunnel" | "lan";
}

export interface MobileRemoteGatewayStatus {
  running: boolean;
  url?: string;
  mode?: "tunnel" | "lan";
  tunnelRunning: boolean;
  tunnelConnected: boolean;
  passcodeSet: boolean;
  onlineDeviceCount: number;
}

export interface GatewayControlServerOptions {
  descriptorPath: string;
  open: () => Promise<MobileRemoteOpenResult>;
  close: () => Promise<void>;
  status: () => Promise<MobileRemoteGatewayStatus> | MobileRemoteGatewayStatus;
  pairingUrl: () =>
    | Promise<{ pairingUrl: string; expiresAt: number }>
    | { pairingUrl: string; expiresAt: number };
  petChat?: (request: PetChatControlRequest) => Promise<PetChatControlResult>;
}

export interface GatewayControlEventInput {
  type: "tunnel.connected" | "tunnel.disconnected" | "tunnel.error";
  text: string;
  title?: string;
  button?: { text: string; url: string };
}

export interface GatewayControlEvent extends GatewayControlEventInput {
  id: number;
  createdAt: number;
}

export type PetChatControlAttachmentKind = "image" | "file" | "audio" | "video";

export interface PetChatControlAttachment {
  id: string;
  kind: PetChatControlAttachmentKind;
  name?: string;
  mimeType?: string;
  size: number;
  dataBase64: string;
}

export interface PetChatControlRequest {
  message: string;
  attachments?: PetChatControlAttachment[];
  origin?: {
    channel: string;
    target: string;
    senderId: string;
    messageId?: string;
  };
}

export interface PetChatControlResult {
  text: string;
  petSessionId: string;
  reason?: string;
}

export interface DesktopControlDescriptor {
  version: typeof DESKTOP_CONTROL_PROTOCOL_VERSION;
  pid: number;
  baseUrl: string;
  token: string;
  startedAt: number;
}

/**
 * Loopback-only control plane used by the headless IM gateway. Electron remains
 * the owner of the mobile host and cloudflared process; the gateway only asks
 * main to run the same open/close/status operations exposed to the renderer.
 *
 * The random bearer credential is advertised through an owner-only descriptor
 * file. Binding to 127.0.0.1 is not sufficient by itself because any local
 * process can reach a loopback port.
 */
export class GatewayControlServer {
  private server?: Server;
  private descriptor?: DesktopControlDescriptor;
  private readonly events: GatewayControlEvent[] = [];
  private readonly eventWaiters = new Set<() => void>();
  private eventStreamId = "";
  private nextEventId = 1;

  constructor(private readonly opts: GatewayControlServerOptions) {}

  async start(): Promise<DesktopControlDescriptor> {
    if (this.descriptor) return this.descriptor;

    this.eventStreamId = randomBytes(16).toString("hex");
    this.events.splice(0);
    this.nextEventId = 1;
    const token = randomBytes(32).toString("hex");
    const server = createServer((req, res) => {
      void this.handleRequest(token, req, res);
    });
    server.requestTimeout = 180_000;
    server.headersTimeout = 10_000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("IM gateway control server did not receive a TCP address");
    }

    this.server = server;
    this.descriptor = {
      version: DESKTOP_CONTROL_PROTOCOL_VERSION,
      pid: process.pid,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token,
      startedAt: Date.now(),
    };

    try {
      this.writeDescriptor(this.descriptor);
    } catch (error) {
      await closeServer(server);
      this.server = undefined;
      this.descriptor = undefined;
      throw error;
    }
    return this.descriptor;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const descriptor = this.descriptor;
    this.server = undefined;
    this.descriptor = undefined;
    this.wakeEventWaiters();

    if (server) await closeServer(server);
    if (descriptor) this.removeOwnDescriptor(descriptor.token);
  }

  publish(event: GatewayControlEventInput): GatewayControlEvent {
    const stored: GatewayControlEvent = {
      ...event,
      id: this.nextEventId++,
      createdAt: Date.now(),
    };
    this.events.push(stored);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    this.wakeEventWaiters();
    return stored;
  }

  private async handleRequest(
    token: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json; charset=utf-8");

    if (!hasBearerToken(req, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      req.resume();
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/v1/status") {
        req.resume();
        sendJson(res, 200, await this.opts.status());
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/events")) {
        req.resume();
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== "/v1/events") {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const after = parseBoundedInteger(
          url.searchParams.get("after"),
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const waitMs = parseBoundedInteger(url.searchParams.get("waitMs"), 0, 25_000);
        const events = await this.eventsAfter(after, waitMs);
        sendJson(res, 200, {
          streamId: this.eventStreamId,
          events,
          cursor: events.at(-1)?.id ?? after,
        });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/open") {
        req.resume();
        sendJson(res, 200, await this.opts.open());
        return;
      }
      if (req.method === "POST" && req.url === "/v1/close") {
        req.resume();
        await this.opts.close();
        sendJson(res, 200, { closed: true });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/pairing-url") {
        req.resume();
        sendJson(res, 200, await this.opts.pairingUrl());
        return;
      }
      if (req.method === "POST" && req.url === "/v1/pet/chat" && this.opts.petChat) {
        const body = parsePetChatRequest(await readJsonBody(req, 32 * 1024 * 1024));
        sendJson(res, 200, await this.opts.petChat(body));
        return;
      }
      req.resume();
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof GatewayControlRequestError ? error.status : 500;
      sendJson(res, status, {
        error: "operation_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private writeDescriptor(descriptor: DesktopControlDescriptor): void {
    const dir = dirname(this.opts.descriptorPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows does not implement POSIX modes; the bearer token still gates RPC.
    }

    const tmp = `${this.opts.descriptorPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best-effort on platforms without POSIX modes.
    }
    renameSync(tmp, this.opts.descriptorPath);
    try {
      chmodSync(this.opts.descriptorPath, 0o600);
    } catch {
      // Best-effort on platforms without POSIX modes.
    }
  }

  private async eventsAfter(after: number, waitMs: number): Promise<GatewayControlEvent[]> {
    const read = () => this.events.filter((event) => event.id > after);
    const immediate = read();
    if (immediate.length > 0 || waitMs === 0 || !this.server) return immediate;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.eventWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      this.eventWaiters.add(done);
    });
    return read();
  }

  private wakeEventWaiters(): void {
    for (const wake of [...this.eventWaiters]) wake();
  }

  private removeOwnDescriptor(token: string): void {
    try {
      const current = JSON.parse(readFileSync(this.opts.descriptorPath, "utf-8")) as {
        token?: unknown;
      };
      if (current.token === token) rmSync(this.opts.descriptorPath, { force: true });
    } catch {
      // Already removed, malformed, or replaced by a newer desktop instance.
    }
  }
}

function parseBoundedInteger(value: string | null, min: number, max: number): number {
  if (value === null || value === "") return min;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new GatewayControlRequestError("invalid event cursor or waitMs");
  }
  return parsed;
}

class GatewayControlRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json") {
    req.resume();
    throw new GatewayControlRequestError("content-type must be application/json", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      req.resume();
      throw new GatewayControlRequestError("request body is too large", 413);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new GatewayControlRequestError("request body is not valid JSON");
  }
}

function parsePetChatRequest(value: unknown): PetChatControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayControlRequestError("invalid Mimi Pet request");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.message !== "string" ||
    record.message.length > 100_000 ||
    (record.attachments !== undefined && !Array.isArray(record.attachments))
  ) {
    throw new GatewayControlRequestError("invalid Mimi Pet request");
  }
  const attachments = (record.attachments ?? []) as unknown[];
  if (attachments.length > 4) throw new GatewayControlRequestError("too many attachments");
  const parsedAttachments = attachments.map((attachment) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new GatewayControlRequestError("invalid attachment");
    }
    const item = attachment as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !["image", "file", "audio", "video"].includes(String(item.kind)) ||
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.dataBase64 !== "string" ||
      (item.name !== undefined && typeof item.name !== "string") ||
      (item.mimeType !== undefined && typeof item.mimeType !== "string")
    ) {
      throw new GatewayControlRequestError("invalid attachment");
    }
    return item as unknown as PetChatControlAttachment;
  });
  if (!record.message.trim() && parsedAttachments.length === 0) {
    throw new GatewayControlRequestError("message or attachment is required");
  }
  const origin = parseOrigin(record.origin);
  return {
    message: record.message,
    ...(parsedAttachments.length > 0 ? { attachments: parsedAttachments } : {}),
    ...(origin ? { origin } : {}),
  };
}

function parseOrigin(value: unknown): PetChatControlRequest["origin"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayControlRequestError("invalid message origin");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.channel !== "string" ||
    typeof record.target !== "string" ||
    typeof record.senderId !== "string" ||
    (record.messageId !== undefined && typeof record.messageId !== "string")
  ) {
    throw new GatewayControlRequestError("invalid message origin");
  }
  return {
    channel: record.channel,
    target: record.target,
    senderId: record.senderId,
    ...(record.messageId ? { messageId: record.messageId } : {}),
  };
}

function hasBearerToken(req: IncomingMessage, expected: string): boolean {
  const raw = req.headers.authorization;
  if (!raw?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(raw.slice("Bearer ".length), "utf-8");
  const target = Buffer.from(expected, "utf-8");
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
