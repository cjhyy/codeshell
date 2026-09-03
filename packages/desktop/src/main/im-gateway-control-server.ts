import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute } from "node:path";
import { dlog } from "./desktop-logger.js";

export const DESKTOP_CONTROL_PROTOCOL_VERSION = 1;

const GATEWAY_EVENT_OUTBOX_VERSION = 2;
const MAX_GATEWAY_EVENTS = 200;
const MAX_GATEWAY_EVENT_TEXT_LENGTH = 100_000;
const MAX_GATEWAY_EVENT_OUTBOX_BYTES = 96 * 1024 * 1024;
const MAX_GATEWAY_EVENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const GATEWAY_EVENT_CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const GATEWAY_EVENT_DELIVERY_KEY_RE = /^[a-f0-9]{64}$/u;
const GATEWAY_EVENT_STREAM_ID_RE = /^[a-f0-9]{32}$/u;
const GATEWAY_EVENT_TYPES = new Set<GatewayControlEventInput["type"]>([
  "tunnel.connected",
  "tunnel.disconnected",
  "tunnel.error",
  "pet.task.completed",
  "pet.task.failed",
  "pet.task.cancelled",
  "pet.task.reported",
  "session.reply",
  "automation.completed",
  "automation.failed",
  "automation.stopped",
  "automation.cancelled",
  "automation.missed",
]);

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
  /** Opaque 256-bit key for resuming one durable notification across restarts. */
  deliveryKey?: string;
  type:
    | "tunnel.connected"
    | "tunnel.disconnected"
    | "tunnel.error"
    | "pet.task.completed"
    | "pet.task.failed"
    | "pet.task.cancelled"
    | "pet.task.reported"
    | "session.reply"
    | "automation.completed"
    | "automation.failed"
    | "automation.stopped"
    | "automation.cancelled"
    | "automation.missed";
  text: string;
  title?: string;
  button?: { text: string; url: string };
  attachments?: GatewayControlEventAttachment[];
  target?: { channel: string; target: string };
}

export interface GatewayControlEventAttachment {
  kind: PetChatControlAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  /** Validated local path consumed only by the owner-authenticated loopback gateway. */
  path: string;
}

export interface GatewayControlEvent extends GatewayControlEventInput {
  id: number;
  createdAt: number;
}

export interface GatewayControlEventContext {
  streamId: string;
}

interface GatewayControlEventOutbox {
  version: typeof GATEWAY_EVENT_OUTBOX_VERSION;
  streamId: string;
  acknowledgedEventId: number;
  nextEventId: number;
  events: GatewayControlEvent[];
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
    capabilities: PetChatControlChannelCapabilities;
    channels?: PetChatControlGatewayChannel[];
  };
}

export interface PetChatControlGatewayChannel {
  channel: string;
  capabilities: PetChatControlChannelCapabilities;
}

export interface PetChatControlChannelCapabilities {
  inbound: {
    text: true;
    attachments: PetChatControlAttachmentKind[];
  };
  outbound: {
    text: true;
    /** Owner-addressed send outside the current reply call. Optional for legacy Gateway clients. */
    proactive?: boolean;
    /** Fresh-adapter send support. Optional for legacy Gateway clients. */
    direct?: boolean;
    maxTextLength?: number;
    button: "native" | "link";
    attachments: PetChatControlAttachmentKind[];
    maxAttachments?: number;
    maxAttachmentBytes?: number;
  };
}

export interface PetChatControlResult {
  text: string;
  petSessionId: string;
  reason?: string;
  /** This input joined an in-flight Mimi turn; no separate channel reply is due. */
  suppressReply?: boolean;
  button?: { text: string; url: string };
  /** Host-produced reply attachments for attachment-capable channels. */
  attachments?: GatewayControlEventAttachment[];
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
  private eventOutboxReady = false;
  private eventMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: GatewayControlServerOptions) {}

  async start(): Promise<DesktopControlDescriptor> {
    if (this.descriptor) return this.descriptor;

    this.eventOutboxReady = false;
    let restored: GatewayControlEventOutbox | undefined;
    try {
      restored = this.readEventOutbox();
    } catch (error) {
      // A corrupt/insecure events file must only cost its own pending events,
      // never the whole control plane (pet chat RPC, tunnel control,
      // notifications). Quarantine it for inspection and start a fresh stream.
      this.quarantineEventOutbox(error);
    }
    const outbox =
      restored ??
      ({
        version: GATEWAY_EVENT_OUTBOX_VERSION,
        streamId: randomBytes(16).toString("hex"),
        acknowledgedEventId: 0,
        nextEventId: 1,
        events: [],
      } satisfies GatewayControlEventOutbox);
    // Also rewrites a validated v1 file into the current schema atomically.
    await this.writeEventOutbox(outbox);
    this.restoreEventOutbox(outbox);
    this.eventOutboxReady = true;
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
    // A caller may have started a durable publication immediately before
    // shutdown. Let the already-queued mutation reach disk before marking the
    // outbox unavailable; otherwise the queued callback would observe false
    // and reject even though publish() was accepted while the server was live.
    await this.eventMutationTail.catch(() => undefined);
    this.eventOutboxReady = false;
    if (descriptor) this.removeOwnDescriptor(descriptor.token);
  }

  publish(event: GatewayControlEventInput): Promise<GatewayControlEvent> {
    return this.enqueueEventMutation(async () => {
      if (!this.eventOutboxReady || !this.eventStreamId) {
        throw new Error("Gateway control event stream is not started");
      }
      if (this.events.length >= MAX_GATEWAY_EVENTS) {
        throw new Error(
          `Gateway control event outbox is full (${MAX_GATEWAY_EVENTS} unacknowledged events)`,
        );
      }
      const stored = parseGatewayControlEvent({
        ...event,
        // Every event needs an identity independent of streamId:id. This keeps
        // notification progress safe when a client resets a cursor against a
        // restored/rolled-back stream whose numeric ids may be reused.
        deliveryKey: event.deliveryKey ?? randomBytes(32).toString("hex"),
        id: this.nextEventId,
        createdAt: Date.now(),
      });
      const events = [...this.events, stored];
      const outbox: GatewayControlEventOutbox = {
        version: GATEWAY_EVENT_OUTBOX_VERSION,
        streamId: this.eventStreamId,
        acknowledgedEventId: this.events.at(0)?.id ? this.events[0]!.id - 1 : stored.id - 1,
        nextEventId: stored.id + 1,
        events,
      };
      // Persist before making the event observable. Once publish() resolves, a
      // process restart can recover the same stream/id and retry the notification.
      await this.writeEventOutbox(outbox);
      this.restoreEventOutbox(outbox);
      this.wakeEventWaiters();
      return stored;
    });
  }

  /** Stable identity required by delivery checkpoints for this durable event stream. */
  eventContext(): GatewayControlEventContext | undefined {
    return this.eventOutboxReady && this.eventStreamId
      ? { streamId: this.eventStreamId }
      : undefined;
  }

  /**
   * Confirm one fully delivered one-shot event without skipping an older event
   * that still belongs to the live watcher. Direct delivery is serialized, so
   * accepting only the current head preserves the same contiguous-ack rule as
   * the HTTP cursor.
   */
  acknowledgeDirectDelivery(eventId: number): Promise<boolean> {
    return this.enqueueEventMutation(async () => {
      if (!Number.isSafeInteger(eventId) || eventId < 1 || this.events.at(0)?.id !== eventId) {
        return false;
      }
      await this.persistAcknowledgement(eventId);
      return true;
    });
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
        const resetCursor = after > this.nextEventId - 1;
        if (!resetCursor) await this.acknowledgeEvents(after);
        const events = resetCursor ? [] : await this.eventsAfter(after, waitMs);
        sendJson(res, 200, {
          streamId: this.eventStreamId,
          events,
          cursor: events.at(-1)?.id ?? after,
          ...(resetCursor ? { resetCursor: true } : {}),
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
    const dirInfo = lstatSync(dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error(`IM gateway control descriptor parent is not a regular directory: ${dir}`);
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows does not implement POSIX modes; the bearer token still gates RPC.
    }

    try {
      const temporary = `${this.opts.descriptorPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
          encoding: "utf-8",
          mode: 0o600,
          flag: "wx",
        });
        renameSync(temporary, this.opts.descriptorPath);
        try {
          chmodSync(this.opts.descriptorPath, 0o600);
        } catch {
          // Best-effort on platforms without POSIX modes.
        }
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    } catch (error) {
      throw new Error("Failed to atomically publish the IM gateway control descriptor", {
        cause: error,
      });
    }
  }

  private eventOutboxPath(): string {
    return `${this.opts.descriptorPath}.events`;
  }

  private readEventOutbox(): GatewayControlEventOutbox | undefined {
    const path = this.eventOutboxPath();
    let handle: number | undefined;
    try {
      const pathInfo = lstatSync(path);
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
        throw new Error(`Gateway event outbox is not a regular file: ${path}`);
      }
      if (process.platform !== "win32" && (pathInfo.mode & 0o077) !== 0) {
        throw new Error(`Gateway event outbox permissions must be 0600: ${path}`);
      }
      if (pathInfo.size > MAX_GATEWAY_EVENT_OUTBOX_BYTES) {
        throw new Error(`Gateway event outbox is too large: ${path}`);
      }
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      handle = openSync(path, constants.O_RDONLY | noFollow);
      const openedInfo = fstatSync(handle);
      if (!openedInfo.isFile() || openedInfo.size > MAX_GATEWAY_EVENT_OUTBOX_BYTES) {
        throw new Error(`Gateway event outbox is not a bounded regular file: ${path}`);
      }
      const raw = readFileSync(handle, "utf-8");
      if (Buffer.byteLength(raw, "utf-8") > MAX_GATEWAY_EVENT_OUTBOX_BYTES) {
        throw new Error(`Gateway event outbox is too large: ${path}`);
      }
      return parseGatewayControlEventOutbox(raw, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }

  /**
   * Move an unreadable event outbox aside so start() can proceed with a fresh
   * one. The rename keeps the bytes beside the original for diagnosis; a
   * genuine I/O failure of the rename itself still propagates.
   */
  private quarantineEventOutbox(cause: unknown): void {
    const path = this.eventOutboxPath();
    const quarantinePath = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(path, quarantinePath);
    } catch (error) {
      // Already gone (racing cleanup); a fresh outbox is the right outcome.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    dlog("main", "im_gateway.event_outbox.quarantined", {
      path,
      quarantinePath,
      error: String(cause),
    });
  }

  private async writeEventOutbox(outbox: GatewayControlEventOutbox): Promise<void> {
    const validated = parseGatewayControlEventOutbox(JSON.stringify(outbox), "memory");
    const serialized = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(serialized, "utf-8") > MAX_GATEWAY_EVENT_OUTBOX_BYTES) {
      throw new Error("Gateway event outbox exceeds its size limit");
    }
    const path = this.eventOutboxPath();
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirInfo = await lstat(dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error(`Gateway event outbox parent is not a regular directory: ${dir}`);
    }
    try {
      await chmod(dir, 0o700);
    } catch {
      // Best-effort on platforms without POSIX modes.
    }

    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, serialized, {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
      try {
        await chmod(path, 0o600);
      } catch {
        // Best-effort on platforms without POSIX modes.
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private restoreEventOutbox(outbox: GatewayControlEventOutbox): void {
    this.eventStreamId = outbox.streamId;
    this.nextEventId = outbox.nextEventId;
    this.events.splice(0, this.events.length, ...outbox.events);
  }

  private acknowledgeEvents(after: number): Promise<void> {
    return this.enqueueEventMutation(() => this.persistAcknowledgement(after));
  }

  private async persistAcknowledgement(after: number): Promise<void> {
    const acknowledgedEventId = this.events.at(0)?.id
      ? this.events[0]!.id - 1
      : this.nextEventId - 1;
    const latestPublishedEventId = this.nextEventId - 1;
    // A high cursor can belong to a replaced stream. The response still
    // returns our streamId so the client can reset, but it must not erase this
    // stream's events. Repeated/older acknowledgements are no-ops.
    if (after <= acknowledgedEventId || after > latestPublishedEventId) return;
    const outbox: GatewayControlEventOutbox = {
      version: GATEWAY_EVENT_OUTBOX_VERSION,
      streamId: this.eventStreamId,
      acknowledgedEventId: after,
      nextEventId: this.nextEventId,
      events: this.events.filter((event) => event.id > after),
    };
    await this.writeEventOutbox(outbox);
    this.restoreEventOutbox(outbox);
  }

  private enqueueEventMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.eventMutationTail.catch(() => undefined).then(operation);
    this.eventMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

function parseGatewayControlEventOutbox(raw: string, source: string): GatewayControlEventOutbox {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Gateway event outbox JSON: ${source}`, { cause: error });
  }
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid Gateway event outbox: ${source}`);
  }
  const legacy = value.version === 1;
  const allowedKeys = legacy
    ? ["version", "streamId", "nextEventId", "events"]
    : ["version", "streamId", "acknowledgedEventId", "nextEventId", "events"];
  if (
    !hasOnlyKeys(value, allowedKeys) ||
    (!legacy && value.version !== GATEWAY_EVENT_OUTBOX_VERSION) ||
    typeof value.streamId !== "string" ||
    !GATEWAY_EVENT_STREAM_ID_RE.test(value.streamId) ||
    !Number.isSafeInteger(value.nextEventId) ||
    Number(value.nextEventId) < 1 ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_GATEWAY_EVENTS
  ) {
    throw new Error(`Invalid Gateway event outbox: ${source}`);
  }
  const events = value.events.map(parseGatewayControlEvent);
  const acknowledgedEventId = legacy
    ? (events.at(0)?.id ?? 1) - 1
    : Number(value.acknowledgedEventId);
  if (
    !Number.isSafeInteger(acknowledgedEventId) ||
    acknowledgedEventId < 0 ||
    acknowledgedEventId >= Number(value.nextEventId)
  ) {
    throw new Error(`Gateway event outbox acknowledgement is invalid: ${source}`);
  }
  for (let index = 1; index < events.length; index++) {
    if (events[index]!.id !== events[index - 1]!.id + 1) {
      throw new Error(`Gateway event outbox ids are not contiguous: ${source}`);
    }
  }
  if (events.at(0)?.id !== undefined && events[0]!.id !== acknowledgedEventId + 1) {
    throw new Error(`Gateway event outbox first id is invalid: ${source}`);
  }
  const expectedNextEventId = events.length > 0 ? events.at(-1)!.id + 1 : acknowledgedEventId + 1;
  if (value.nextEventId !== expectedNextEventId || !Number.isSafeInteger(expectedNextEventId)) {
    throw new Error(`Gateway event outbox cursor is invalid: ${source}`);
  }
  return {
    version: GATEWAY_EVENT_OUTBOX_VERSION,
    streamId: value.streamId,
    acknowledgedEventId,
    nextEventId: value.nextEventId as number,
    events,
  };
}

function parseGatewayControlEvent(value: unknown): GatewayControlEvent {
  if (!isPlainRecord(value)) throw new Error("Invalid Gateway control event");
  const rawAttachments = value.attachments ?? [];
  if (
    !hasOnlyKeys(value, [
      "id",
      "createdAt",
      "deliveryKey",
      "type",
      "text",
      "title",
      "button",
      "attachments",
      "target",
    ]) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 0 ||
    typeof value.type !== "string" ||
    !GATEWAY_EVENT_TYPES.has(value.type as GatewayControlEventInput["type"]) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > MAX_GATEWAY_EVENT_TEXT_LENGTH ||
    GATEWAY_EVENT_CONTROL_CHARACTER_RE.test(value.text) ||
    (value.deliveryKey !== undefined &&
      (typeof value.deliveryKey !== "string" ||
        !GATEWAY_EVENT_DELIVERY_KEY_RE.test(value.deliveryKey))) ||
    (value.title !== undefined && !isValidGatewayEventLabel(value.title)) ||
    (value.button !== undefined && !isValidGatewayEventButton(value.button)) ||
    (value.target !== undefined && !isValidGatewayEventTarget(value.target)) ||
    !Array.isArray(rawAttachments) ||
    rawAttachments.length > 4
  ) {
    throw new Error("Invalid Gateway control event");
  }
  const attachments = rawAttachments.map(parseGatewayControlEventAttachment);
  return {
    id: value.id as number,
    createdAt: value.createdAt as number,
    type: value.type as GatewayControlEventInput["type"],
    text: value.text,
    ...(value.deliveryKey === undefined ? {} : { deliveryKey: value.deliveryKey as string }),
    ...(value.title === undefined ? {} : { title: value.title as string }),
    ...(value.button === undefined
      ? {}
      : { button: { ...(value.button as { text: string; url: string }) } }),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(value.target === undefined
      ? {}
      : { target: { ...(value.target as { channel: string; target: string }) } }),
  };
}

function parseGatewayControlEventAttachment(value: unknown): GatewayControlEventAttachment {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["kind", "name", "mimeType", "size", "path"]) ||
    typeof value.kind !== "string" ||
    !["image", "file", "audio", "video"].includes(value.kind) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/u.test(value.name) ||
    typeof value.mimeType !== "string" ||
    !value.mimeType.trim() ||
    value.mimeType.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value.mimeType) ||
    (value.kind === "image" && !value.mimeType.startsWith("image/")) ||
    (value.kind === "audio" && !value.mimeType.startsWith("audio/")) ||
    (value.kind === "video" && !value.mimeType.startsWith("video/")) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 1 ||
    Number(value.size) > MAX_GATEWAY_EVENT_ATTACHMENT_BYTES ||
    typeof value.path !== "string" ||
    value.path.length > 32_768 ||
    value.path.includes("\0") ||
    !isAbsolute(value.path)
  ) {
    throw new Error("Invalid Gateway control event attachment");
  }
  return {
    kind: value.kind as PetChatControlAttachmentKind,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size as number,
    path: value.path,
  };
}

function isValidGatewayEventLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= 256 &&
    !GATEWAY_EVENT_CONTROL_CHARACTER_RE.test(value)
  );
}

function isValidGatewayEventButton(value: unknown): value is { text: string; url: string } {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["text", "url"]) ||
    !isValidGatewayEventLabel(value.text) ||
    typeof value.url !== "string" ||
    value.url.length > 2_048
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isValidGatewayEventTarget(value: unknown): value is { channel: string; target: string } {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["channel", "target"]) &&
    typeof value.channel === "string" &&
    /^[a-z0-9_-]{1,64}$/u.test(value.channel) &&
    typeof value.target === "string" &&
    Boolean(value.target.trim()) &&
    value.target.length <= 4_096 &&
    !GATEWAY_EVENT_CONTROL_CHARACTER_RE.test(value.target)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
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
    Object.keys(record).some(
      (key) =>
        key !== "channel" &&
        key !== "target" &&
        key !== "senderId" &&
        key !== "messageId" &&
        key !== "capabilities" &&
        key !== "channels",
    ) ||
    typeof record.channel !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(record.channel) ||
    typeof record.target !== "string" ||
    typeof record.senderId !== "string" ||
    (record.messageId !== undefined && typeof record.messageId !== "string") ||
    (record.channels !== undefined && !Array.isArray(record.channels)) ||
    record.capabilities === undefined
  ) {
    throw new GatewayControlRequestError("invalid message origin");
  }
  const capabilities = parseChannelCapabilities(record.capabilities);
  const channels = parseGatewayChannels(record.channels, record.channel, capabilities);
  return {
    channel: record.channel,
    target: record.target,
    senderId: record.senderId,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    capabilities,
    ...(channels ? { channels } : {}),
  };
}

function parseGatewayChannels(
  value: unknown,
  currentChannel: string,
  currentCapabilities: PetChatControlChannelCapabilities,
): PetChatControlGatewayChannel[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new GatewayControlRequestError("invalid Gateway channel catalog");
  }
  const seen = new Set<string>();
  const channels = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new GatewayControlRequestError("invalid Gateway channel catalog");
    }
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "channel" && key !== "capabilities") ||
      typeof record.channel !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(record.channel) ||
      record.capabilities === undefined ||
      seen.has(record.channel)
    ) {
      throw new GatewayControlRequestError("invalid Gateway channel catalog");
    }
    seen.add(record.channel);
    const capabilities = parseChannelCapabilities(record.capabilities);
    if (
      record.channel === currentChannel &&
      !sameChannelCapabilities(capabilities, currentCapabilities)
    ) {
      throw new GatewayControlRequestError(
        "Gateway channel catalog contradicts the current route capability",
      );
    }
    return {
      channel: record.channel,
      capabilities: record.channel === currentChannel ? currentCapabilities : capabilities,
    };
  });
  if (!seen.has(currentChannel)) {
    throw new GatewayControlRequestError("Gateway channel catalog omits the current route");
  }
  return channels;
}

function sameChannelCapabilities(
  left: PetChatControlChannelCapabilities,
  right: PetChatControlChannelCapabilities,
): boolean {
  return (
    left.inbound.attachments.join("\0") === right.inbound.attachments.join("\0") &&
    left.outbound.proactive === right.outbound.proactive &&
    left.outbound.direct === right.outbound.direct &&
    left.outbound.maxTextLength === right.outbound.maxTextLength &&
    left.outbound.button === right.outbound.button &&
    left.outbound.attachments.join("\0") === right.outbound.attachments.join("\0") &&
    left.outbound.maxAttachments === right.outbound.maxAttachments &&
    left.outbound.maxAttachmentBytes === right.outbound.maxAttachmentBytes
  );
}

function parseChannelCapabilities(value: unknown): PetChatControlChannelCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayControlRequestError("invalid channel capabilities");
  }
  const record = value as Record<string, unknown>;
  const inbound = parseCapabilityDirection(record.inbound, false);
  const outbound = parseCapabilityDirection(record.outbound, true);
  return {
    inbound: { text: true, attachments: inbound.attachments },
    outbound: {
      text: true,
      ...(outbound.proactive === undefined ? {} : { proactive: outbound.proactive }),
      ...(outbound.direct === undefined ? {} : { direct: outbound.direct }),
      ...(outbound.maxTextLength === undefined ? {} : { maxTextLength: outbound.maxTextLength }),
      button: outbound.button!,
      attachments: outbound.attachments,
      ...(outbound.maxAttachments === undefined ? {} : { maxAttachments: outbound.maxAttachments }),
      ...(outbound.maxAttachmentBytes === undefined
        ? {}
        : { maxAttachmentBytes: outbound.maxAttachmentBytes }),
    },
  };
}

function parseCapabilityDirection(
  value: unknown,
  outbound: boolean,
): {
  attachments: PetChatControlAttachmentKind[];
  button?: "native" | "link";
  proactive?: boolean;
  direct?: boolean;
  maxTextLength?: number;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayControlRequestError("invalid channel capabilities");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = outbound
    ? new Set([
        "text",
        "attachments",
        "button",
        "proactive",
        "direct",
        "maxTextLength",
        "maxAttachments",
        "maxAttachmentBytes",
      ])
    : new Set(["text", "attachments"]);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    record.text !== true ||
    !Array.isArray(record.attachments) ||
    record.attachments.length > 4 ||
    !record.attachments.every((kind) =>
      ["image", "file", "audio", "video"].includes(String(kind)),
    ) ||
    new Set(record.attachments).size !== record.attachments.length ||
    (outbound && record.button !== "native" && record.button !== "link") ||
    (!outbound && record.button !== undefined) ||
    (record.proactive !== undefined && (!outbound || typeof record.proactive !== "boolean")) ||
    (record.direct !== undefined && (!outbound || typeof record.direct !== "boolean")) ||
    (record.maxTextLength !== undefined &&
      (!outbound ||
        !Number.isSafeInteger(record.maxTextLength) ||
        Number(record.maxTextLength) < 1 ||
        Number(record.maxTextLength) > 8_000)) ||
    (record.maxAttachments !== undefined &&
      (!outbound ||
        !Number.isSafeInteger(record.maxAttachments) ||
        Number(record.maxAttachments) < 1 ||
        Number(record.maxAttachments) > 4)) ||
    (record.maxAttachmentBytes !== undefined &&
      (!outbound ||
        !Number.isSafeInteger(record.maxAttachmentBytes) ||
        Number(record.maxAttachmentBytes) < 1 ||
        Number(record.maxAttachmentBytes) > 10 * 1024 * 1024))
  ) {
    throw new GatewayControlRequestError("invalid channel capabilities");
  }
  return {
    attachments: record.attachments as PetChatControlAttachmentKind[],
    ...(outbound ? { button: record.button as "native" | "link" } : {}),
    ...(typeof record.proactive === "boolean" ? { proactive: record.proactive } : {}),
    ...(typeof record.direct === "boolean" ? { direct: record.direct } : {}),
    ...(typeof record.maxTextLength === "number" ? { maxTextLength: record.maxTextLength } : {}),
    ...(typeof record.maxAttachments === "number" ? { maxAttachments: record.maxAttachments } : {}),
    ...(typeof record.maxAttachmentBytes === "number"
      ? { maxAttachmentBytes: record.maxAttachmentBytes }
      : {}),
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
