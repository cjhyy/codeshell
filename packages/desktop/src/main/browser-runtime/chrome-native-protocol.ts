import { createConnection, type Socket } from "node:net";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export const CHROME_NATIVE_HOST_NAME = "com.cjhyy.codeshell.browser_runtime";
export const CODESHELL_CHROME_EXTENSION_ID = "lfibcnkpbhakjhfpjkmknhilbhldgflh";
export const CODESHELL_CHROME_EXTENSION_ORIGIN =
  `chrome-extension://${CODESHELL_CHROME_EXTENSION_ID}/`;
export const MAX_NATIVE_HOST_TO_EXTENSION_BYTES = 1024 * 1024;
export const MAX_EXTENSION_TO_NATIVE_HOST_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_STATE_BYTES = 64 * 1024;

export interface ChromeNativeServerState {
  version: 1;
  port: number;
  token: string;
  pid: number;
}

export function defaultChromeNativeStatePath(): string {
  const override = process.env.CODESHELL_CHROME_NATIVE_STATE_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".code-shell", "browser-runtime", "chrome-native.json");
}

/** Chrome Native Messaging framing: 32-bit native/little-endian byte length + UTF-8 JSON. */
export function encodeChromeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > MAX_NATIVE_HOST_TO_EXTENSION_BYTES) {
    throw new Error(`native message exceeds ${MAX_NATIVE_HOST_TO_EXTENSION_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32LE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export class ChromeNativeMessageDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = this.buffered.length > 0 ? Buffer.concat([this.buffered, chunk]) : chunk;
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > MAX_EXTENSION_TO_NATIVE_HOST_BYTES) {
        throw new Error(`native input message exceeds ${MAX_EXTENSION_TO_NATIVE_HOST_BYTES} bytes`);
      }
      if (this.buffered.length < 4 + length) break;
      const body = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      messages.push(JSON.parse(body.toString("utf8")));
    }
    return messages;
  }
}

export class JsonLineDecoder {
  private buffered = "";

  push(chunk: Buffer | string): unknown[] {
    this.buffered += chunk.toString();
    const messages: unknown[] = [];
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (!line.trim()) continue;
      messages.push(JSON.parse(line));
    }
    return messages;
  }
}

/**
 * Entry used when Chrome launches the CodeShell executable as a native host.
 * It is intentionally a dumb framing relay; the owning desktop process keeps
 * policy, task identity and browser state.
 */
export async function runChromeNativeMessagingHost(
  origin: string,
  statePath = defaultChromeNativeStatePath(),
): Promise<void> {
  if (origin !== CODESHELL_CHROME_EXTENSION_ORIGIN) {
    throw new Error(`native messaging origin is not allowed: ${origin}`);
  }
  const metadata = await lstat(statePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_NATIVE_STATE_BYTES) {
    throw new Error("CodeShell native bridge state is invalid");
  }
  const handle = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let state: ChromeNativeServerState;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_NATIVE_STATE_BYTES) {
      throw new Error("CodeShell native bridge state is invalid");
    }
    state = JSON.parse(await handle.readFile("utf8")) as ChromeNativeServerState;
  } finally {
    await handle.close();
  }
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.port) ||
    state.port <= 0 ||
    state.port > 65_535 ||
    typeof state.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.token) ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0
  ) {
    throw new Error("CodeShell native bridge state is invalid");
  }

  const socket = await connectLoopback(state.port);
  socket.write(`${JSON.stringify({ type: "auth", token: state.token, origin })}\n`);
  const socketDecoder = new JsonLineDecoder();
  const nativeDecoder = new ChromeNativeMessageDecoder();
  let authenticated = false;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
    socket.on("data", (chunk) => {
      try {
        for (const message of socketDecoder.push(chunk)) {
          if (!authenticated) {
            const auth = message as { type?: unknown; ok?: unknown; error?: unknown };
            if (auth.type !== "auth.result" || auth.ok !== true) {
              throw new Error(typeof auth.error === "string" ? auth.error : "native bridge auth failed");
            }
            authenticated = true;
            continue;
          }
          process.stdout.write(encodeChromeNativeMessage(message));
        }
      } catch (error) {
        fail(error);
      }
    });
    socket.once("error", fail);
    socket.once("close", () => resolve());
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        for (const message of nativeDecoder.push(chunk)) {
          socket.write(`${JSON.stringify(message)}\n`);
        }
      } catch (error) {
        fail(error);
      }
    });
    process.stdin.once("end", () => socket.end());
    process.stdin.resume();
  }).finally(() => socket.destroy());
}

function connectLoopback(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function nativeMessagingOriginFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => /^chrome-extension:\/\/[a-p]{32}\/$/.test(arg));
}
