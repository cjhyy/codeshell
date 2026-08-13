import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  CODESHELL_CHROME_EXTENSION_ORIGIN,
  JsonLineDecoder,
  defaultChromeNativeStatePath,
  type ChromeNativeServerState,
} from "./chrome-native-protocol.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export type ChromeExtensionMessage = Record<string, unknown> & { type: string; id?: string };

export interface ChromeNativeBridgeStatus {
  listening: boolean;
  connected: boolean;
  port?: number;
  statePath: string;
}

export interface ChromeNativeBridgeServerOptions {
  statePath?: string;
  requestTimeoutMs?: number;
  onMessage?: (message: ChromeExtensionMessage) => unknown | Promise<unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Authenticated loopback endpoint consumed only by the native-host relay. */
export class ChromeNativeBridgeServer {
  private readonly statePath: string;
  private readonly requestTimeoutMs: number;
  private readonly onMessage?: ChromeNativeBridgeServerOptions["onMessage"];
  private server?: Server;
  private client?: Socket;
  private token?: string;
  private port?: number;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: ChromeNativeBridgeServerOptions = {}) {
    this.statePath = options.statePath ?? defaultChromeNativeStatePath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.onMessage = options.onMessage;
  }

  async start(): Promise<ChromeNativeBridgeStatus> {
    if (this.server) return this.status();
    this.token = randomBytes(32).toString("hex");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("native bridge has no TCP port");
      }
      this.port = address.port;
      const state: ChromeNativeServerState = {
        version: 1,
        port: address.port,
        token: this.token,
        pid: process.pid,
      };
      await writeNativeStateAtomic(this.statePath, state);
      return this.status();
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      this.server = undefined;
      this.port = undefined;
      this.token = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.client?.destroy();
    this.client = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Chrome extension bridge stopped"));
    }
    this.pending.clear();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.token = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.statePath, { force: true }).catch(() => undefined);
  }

  status(): ChromeNativeBridgeStatus {
    return {
      listening: Boolean(this.server),
      connected: Boolean(this.client && !this.client.destroyed),
      port: this.port,
      statePath: this.statePath,
    };
  }

  request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const client = this.client;
    if (!client || client.destroyed) {
      return Promise.reject(new Error("CodeShell Chrome extension is not connected"));
    }
    const id = `desktop-${Date.now()}-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome extension request timed out: ${type}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(client, { id, type, ...payload });
    });
  }

  private accept(socket: Socket): void {
    const decoder = new JsonLineDecoder();
    let authenticated = false;
    let bytesWithoutNewline = 0;
    socket.on("data", (chunk) => {
      try {
        bytesWithoutNewline += chunk.byteLength;
        if (bytesWithoutNewline > MAX_LINE_BYTES && !chunk.includes(10)) {
          throw new Error("native bridge line exceeds maximum size");
        }
        if (chunk.includes(10)) bytesWithoutNewline = 0;
        for (const raw of decoder.push(chunk)) {
          const message = raw as Record<string, unknown>;
          if (!authenticated) {
            if (
              message.type !== "auth" ||
              message.token !== this.token ||
              message.origin !== CODESHELL_CHROME_EXTENSION_ORIGIN
            ) {
              this.send(socket, { type: "auth.result", ok: false, error: "unauthorized" });
              socket.destroy();
              return;
            }
            authenticated = true;
            this.client?.destroy();
            this.client = socket;
            this.send(socket, { type: "auth.result", ok: true });
            continue;
          }
          void this.handle(message as ChromeExtensionMessage, socket);
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("close", () => {
      if (this.client === socket) {
        this.client = undefined;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error("CodeShell Chrome extension disconnected"));
        }
        this.pending.clear();
      }
    });
    socket.on("error", () => undefined);
  }

  private async handle(message: ChromeExtensionMessage, socket: Socket): Promise<void> {
    if (typeof message.replyTo === "string") {
      const request = this.pending.get(message.replyTo);
      if (!request) return;
      this.pending.delete(message.replyTo);
      clearTimeout(request.timer);
      if (message.ok === false) {
        request.reject(new Error(typeof message.error === "string" ? message.error : "Chrome request failed"));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (!this.onMessage) return;
    try {
      const result = await this.onMessage(message);
      if (typeof message.id === "string") {
        this.send(socket, { replyTo: message.id, ok: true, result });
      }
    } catch (error) {
      if (typeof message.id === "string") {
        this.send(socket, {
          replyTo: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private send(socket: Socket, message: unknown): void {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

async function writeNativeStateAtomic(
  statePath: string,
  state: ChromeNativeServerState,
): Promise<void> {
  const parent = path.dirname(statePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("native bridge state parent must be a real directory");
  }
  try {
    const target = await lstat(statePath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error("native bridge state target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, statePath);
    if (process.platform !== "win32") await chmod(statePath, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
