/**
 * LSP client — JSON-RPC over stdio communication with language servers.
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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private contentLength = -1;
  private initialized = false;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly cwd?: string,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => this.handleData(data.toString()));
    this.process.stderr?.on("data", (_data: Buffer) => {
      // LSP servers often log to stderr — ignore
    });
    this.process.on("exit", (code) => {
      this.emit("exit", code);
      this.rejectAll(new Error(`LSP server exited with code ${code}`));
    });

    // Don't keep the event loop alive solely for the LSP child.
    // Call after listeners are wired so event registration doesn't re-ref.
    this.process.unref();
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
    if (!this.process?.stdin) throw new Error("LSP server not started");

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
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.process!.stdin!.write(header + content);
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.process?.stdin) throw new Error("LSP server not started");
    const message = { jsonrpc: "2.0", method, params };
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    this.process.stdin.write(header + content);
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      await this.request("shutdown", {});
      await this.notify("exit", {});
    } catch {
      // Force kill
    }
    this.process.stdout?.removeAllListeners();
    this.process.stderr?.removeAllListeners();
    this.process.removeAllListeners();
    this.process.kill();
    this.process = undefined;
    // Drain pending requests
    for (const { reject } of this.pending.values()) {
      reject(new Error("LSP server shut down"));
    }
    this.pending.clear();
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get isAlive(): boolean {
    return this.process !== undefined && !this.process.killed;
  }

  private handleData(data: string): void {
    this.buffer += data;
    while (true) {
      if (this.contentLength < 0) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) break;

      const content = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

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
