/**
 * LSP client — JSON-RPC over stdio communication with coding language servers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface LSPRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface LSPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LSPNotification {
  method: string;
  params?: Record<string, unknown>;
}

export class LSPClient extends EventEmitter {
  private process: ChildProcess | undefined;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  // The LSP framing uses byte-counted Content-Length, so we buffer bytes,
  // not characters. Joining chunks as strings (`data.toString()` + string
  // concat) can split a multibyte UTF-8 codepoint across chunks and de-
  // synchronize against Content-Length. Stay in Buffer-land until we've
  // sliced out exactly the right body length.
  private buffer = Buffer.alloc(0);
  private contentLength = -1;
  private initialized = false;
  private failure: Error | undefined;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly cwd?: string,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isAlive) return;
    this.failure = undefined;
    this.initialized = false;
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const fail = (error: Error) => {
      if (this.process !== child) return;
      this.fail(error);
    };
    child.stdout?.on("data", (data: Buffer) => {
      if (this.process === child && !this.failure) this.handleData(data);
    });
    child.stderr?.on("data", (_data: Buffer) => {
      // LSP servers often log to stderr — ignore
    });
    // Pipe errors are emitted on the streams, not on ChildProcess. Keep these
    // listeners through teardown so late EPIPE events cannot escape the host.
    child.stdin?.on("error", fail);
    child.stdout?.on("error", fail);
    child.stderr?.on("error", fail);
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.fail(
        new Error(`LSP server exited with ${signal ? `signal ${signal}` : `code ${code}`}`),
      );
      this.emit("exit", code);
    });

    // Don't keep the event loop alive solely for the LSP child.
    // Call after listeners are wired so event registration doesn't re-ref.
    child.unref();
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async initialize(rootUri: string): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          documentSymbol: { dynamicRegistration: false },
          completion: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
        },
      },
    });
    await this.notify("initialized", {});
    this.initialized = true;
    return result;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.assertWritable();

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request "${method}" timed out`));
        }
      }, 30000);
      // Don't let the timer keep the event loop alive by itself
      timer.unref?.();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.process!.stdin!.write(header + content);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.assertWritable();
    const message = { jsonrpc: "2.0", method, params };
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    try {
      this.process!.stdin!.write(header + content);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    const child = this.process;
    if (!child) return;
    try {
      if (this.isAlive && this.initialized) {
        await this.request("shutdown", {});
        await this.notify("exit", {});
      }
    } catch {
      // Force kill
    }
    if (this.process !== child) return;
    this.fail(new Error("LSP server shut down"));
    this.process = undefined;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get isAlive(): boolean {
    return (
      !!this.process &&
      !this.failure &&
      !this.process.killed &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    );
  }

  private assertWritable(): void {
    if (!this.isAlive || !this.process?.stdin || this.process.stdin.destroyed)
      throw this.failure ?? new Error("LSP server is not running");
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.initialized = false;
    this.rejectAll(error);
    const child = this.process;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
    this.emit("failure", error);
  }

  private handleData(data: Buffer): void {
    // Append the new chunk as bytes. Buffer.concat avoids the UTF-8
    // boundary corruption that string concatenation produces — a
    // multibyte codepoint split across two TCP/pipe chunks decodes to
    // U+FFFD, mangles the buffer length count, and breaks framing.
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      if (this.contentLength < 0) {
        // Search for the header terminator in bytes, not chars.
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        // Headers are ASCII per spec, so toString("ascii") is safe and
        // avoids paying for a UTF-8 decode on the framing band.
        const header = this.buffer.slice(0, headerEnd).toString("ascii");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      // Content-Length is a BYTE count — compare against the buffer's
      // byte length, not its character length. Pre-fix this compared
      // string lengths; with multibyte responses (e.g. CJK identifiers,
      // emoji in diagnostics) we'd block waiting for bytes that had
      // already arrived.
      if (this.buffer.length < this.contentLength) break;

      const bodyBytes = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      // Decode the full body in one shot — at this point we have the
      // exact byte count, so the UTF-8 boundary issue is fully gone.
      const content = bodyBytes.toString("utf8");

      try {
        const message = JSON.parse(content);
        if ("id" in message && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          if (message.error) {
            reject(new Error(`LSP error: ${message.error.message}`));
          } else {
            resolve(message.result);
          }
        } else if ("method" in message && !("id" in message)) {
          this.emit("notification", message as LSPNotification);
        }
      } catch {
        // Skip malformed messages
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}
