/** MCP stdio observer for the embedded driver. The wire stream is never rewritten.
 * Build as a separate Node entry; it owns only the MCP client, never the daemon. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { CuaActivityTracker, type CuaActivityEvent } from "./cua-activity.js";

const ACK_TIMEOUT_MS = 180;
const MAX_ACTIVITY_BYTES = 2_048;
const MAX_INSPECT_BYTES = 16 * 1024 * 1024;
const MAX_ACKS = 256;

export class CuaActivityChannel {
  private socket?: Socket;
  private connecting?: Promise<Socket | undefined>;
  private closed = false;
  private buffer = "";
  private readonly acknowledgements = new Map<string, (ok: boolean) => void>();

  constructor(
    private readonly path: string | undefined,
    private readonly token: string | undefined,
    private readonly timeoutMs = ACK_TIMEOUT_MS,
  ) {}

  async send(event: CuaActivityEvent): Promise<boolean> {
    if (this.closed || !this.path || !this.token || this.token.length > 512) return false;
    const line = `${JSON.stringify({ token: this.token, ...event })}\n`;
    if (Buffer.byteLength(line) > MAX_ACTIVITY_BYTES || this.acknowledgements.size >= MAX_ACKS)
      return false;
    const deadline = Date.now() + Math.min(ACK_TIMEOUT_MS, Math.max(1, this.timeoutMs));
    const socket = await this.connect();
    if (!socket || socket.destroyed || Date.now() >= deadline) return false;
    return new Promise<boolean>((resolve) => {
      const key = `${event.id}:${event.phase}`;
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.acknowledgements.delete(key);
        resolve(ok);
      };
      const timer = setTimeout(
        () => {
          finish(false);
          // Closing is also the host's recovery signal for a capture whose ACK
          // was lost. Do not leave an unseen start holding the overlay hidden.
          socket.destroy();
        },
        Math.max(1, deadline - Date.now()),
      );
      this.acknowledgements.set(key, finish);
      socket.write(line, (error) => {
        if (error) {
          finish(false);
          socket.destroy();
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    for (const finish of this.acknowledgements.values()) finish(false);
    this.acknowledgements.clear();
  }

  private connect(): Promise<Socket | undefined> {
    if (this.closed || !this.path) return Promise.resolve(undefined);
    if (this.socket && !this.socket.destroyed && !this.socket.connecting)
      return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const pending = new Promise<Socket | undefined>((resolve) => {
      const socket = createConnection(this.path!);
      this.socket = socket;
      this.buffer = "";
      let settled = false;
      const finish = (value?: Socket): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(
        () => {
          finish();
          socket.destroy();
        },
        Math.min(ACK_TIMEOUT_MS, Math.max(1, this.timeoutMs)),
      );
      socket.once("connect", () => finish(socket));
      socket.on("error", () => {
        finish();
        socket.destroy();
      });
      socket.on("close", () => {
        finish();
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.buffer = "";
        for (const acknowledge of this.acknowledgements.values()) acknowledge(false);
        this.acknowledgements.clear();
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_ACTIVITY_BYTES * 2) {
          socket.destroy();
          return;
        }
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_ACTIVITY_BYTES) {
            socket.destroy();
            return;
          }
          try {
            const ack = JSON.parse(line);
            if (typeof ack?.id === "string" && (ack.phase === "start" || ack.phase === "end")) {
              this.acknowledgements.get(`${ack.id}:${ack.phase}`)?.(ack.ok === true);
            }
          } catch {
            socket.destroy();
            return;
          }
        }
      });
    });
    this.connecting = pending.finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
}

interface WirePart {
  bytes: Buffer;
  inspect: boolean;
  overflow: boolean;
}

/** Bound inspection memory while preserving arbitrary protocol bytes, including
 * split UTF-8 sequences and messages larger than the observer understands. */
export async function* cuaWireParts(
  source: Readable,
  limit = MAX_INSPECT_BYTES,
): AsyncGenerator<WirePart> {
  let chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf(10, from);
      const end = newline >= 0 ? newline + 1 : chunk.length;
      const part = chunk.subarray(from, end);
      if (overflow) {
        yield { bytes: part, inspect: false, overflow: false };
      } else if (size + part.length > limit) {
        yield { bytes: Buffer.concat([...chunks, part]), inspect: false, overflow: true };
        chunks = [];
        size = 0;
        overflow = true;
      } else {
        chunks.push(part);
        size += part.length;
        if (newline >= 0) {
          yield { bytes: Buffer.concat(chunks, size), inspect: true, overflow: false };
          chunks = [];
          size = 0;
        }
      }
      if (newline >= 0) overflow = false;
      from = end;
    }
  }
  if (size) yield { bytes: Buffer.concat(chunks, size), inspect: true, overflow: false };
}

function parsed(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

function write(destination: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) =>
    destination.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
}

export function parseCuaActivityProxyArgs(args: readonly string[]): {
  driver: string;
  socket: string;
} {
  if (
    args.length !== 4 ||
    args[0] !== "--driver" ||
    args[2] !== "--socket" ||
    !args[1] ||
    !args[3]
  ) {
    throw new Error("Expected --driver <executable> --socket <private socket>");
  }
  return { driver: args[1], socket: args[3] };
}

export async function runCuaActivityProxy(args = process.argv.slice(2)): Promise<number> {
  const { driver, socket } = parseCuaActivityProxyArgs(args);
  const tracker = new CuaActivityTracker(randomUUID());
  const channel = new CuaActivityChannel(
    process.env.CODE_SHELL_CUA_ACTIVITY_SOCKET,
    process.env.CODE_SHELL_CUA_ACTIVITY_TOKEN,
  );
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CUA_DRIVER_EMBEDDED: "1" };
  delete childEnv.CODE_SHELL_CUA_ACTIVITY_SOCKET;
  delete childEnv.CODE_SHELL_CUA_ACTIVITY_TOKEN;
  const child = spawn(driver, ["mcp", "--embedded", "--socket", socket], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const delivered = new Set<string>();
  let observing = true;
  const disableObserver = (): void => {
    observing = false;
    tracker.clear();
    delivered.clear();
    channel.close();
  };
  const stop = (): void => {
    disableObserver();
    child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  child.stderr.pipe(process.stderr, { end: false });
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  const incoming = (async () => {
    for await (const part of cuaWireParts(process.stdin)) {
      if (part.overflow) disableObserver();
      if (observing && part.inspect) {
        const event = tracker.begin(parsed(part.bytes));
        if (event && (await channel.send(event))) delivered.add(event.id);
      }
      await write(child.stdin, part.bytes);
    }
    child.stdin.end();
  })();
  const outgoing = (async () => {
    for await (const part of cuaWireParts(child.stdout)) {
      if (part.overflow) disableObserver();
      if (observing && part.inspect) {
        const event = tracker.finish(parsed(part.bytes));
        if (event && delivered.delete(event.id)) await channel.send(event);
      }
      await write(process.stdout, part.bytes);
    }
  })();
  // A broken pipe must not leave a proxy client and capture activity alive.
  void incoming.catch(stop);
  void outgoing.catch(stop);
  const exitCode = await exited;
  process.stdin.destroy();
  await Promise.allSettled([incoming, outgoing]);
  disableObserver();
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  return exitCode;
}

// Works for the source Bun entry and the packaged CJS bundle without relying
// on import.meta in a CommonJS build. Importing it from tests has no effects.
if (/(?:^|[/\\])cua-activity-proxy\.(?:[cm]?js|ts)$/.test(process.argv[1] ?? "")) {
  void runCuaActivityProxy().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("CUA activity proxy failed to start.\n");
      process.exitCode = 1;
    },
  );
}
