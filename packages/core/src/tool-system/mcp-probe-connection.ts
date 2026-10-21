import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  ListRootsRequestSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { buildStdioEnv } from "./mcp-manager.js";
import type { MCPServerConfig } from "../types.js";
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export class McpProbeConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A short-lived probe owns its process group, so a failed launcher cannot leave children behind. */
class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private pending = Buffer.alloc(0);
  private totalBytes = 0;
  private closed = false;
  private closePromise?: Promise<void>;
  private closeNotified = false;

  constructor(
    private readonly config: MCPServerConfig,
    private readonly cwd: string,
    private readonly stdioPolicy: "strict" | "skip-banner",
  ) {}

  async start(): Promise<void> {
    if (this.closed || this.child) throw new McpProbeConnectionError("cancelled", "测试已取消。");
    const child = spawn(this.config.command!, this.config.args ?? [], {
      cwd: this.cwd,
      env: { ...getDefaultEnvironment(), ...buildStdioEnv(this.config.name, this.config) },
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // Server stderr can contain access tokens. Drain it without logging or retaining it.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stdout.on("error", (error) => this.onerror?.(error));
    child.stdin.on("error", (error) => this.onerror?.(error));
    child.once("close", () => this.notifyClose());
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
    });
  }

  private read(chunk: Buffer): void {
    if (this.closed) return;
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > MAX_TOTAL_BYTES || this.pending.length + chunk.length > MAX_FRAME_BYTES) {
      this.onerror?.(
        new McpProbeConnectionError("response_too_large", "服务返回的数据过大，测试已停止。"),
      );
      void this.close();
      return;
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    for (let index = this.pending.indexOf(10); index !== -1; index = this.pending.indexOf(10)) {
      const line = this.pending.subarray(0, index).toString("utf8").trim();
      this.pending = this.pending.subarray(index + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Desktop and the long-lived runtime tolerate launcher banners. They
        // still count toward the same frame and total byte limits.
        if (this.stdioPolicy === "skip-banner") continue;
      }
      const message = JSONRPCMessageSchema.safeParse(parsed);
      if (!message.success) {
        // The Desktop/runtime compatibility policy also tolerates structured
        // logger output (e.g. pino JSON). Every byte still counts toward limits.
        if (this.stdioPolicy === "skip-banner") continue;
        this.onerror?.(
          new McpProbeConnectionError(
            "invalid_protocol",
            "命令的输出不是有效的 MCP 协议消息，请检查启动方式。",
          ),
        );
        void this.close();
        return;
      }
      this.onmessage?.(message.data);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.child?.stdin.writable)
      throw new McpProbeConnectionError("closed", "服务连接已关闭。");
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.pending = Buffer.alloc(0);
    this.closePromise = (async () => {
      const child = this.child;
      if (child) {
        const exited = child.exitCode !== null || child.signalCode !== null;
        const exit = exited
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once("close", () => resolve()));
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            /* already exited */
          }
        };
        child.stdin.destroy();
        kill("SIGTERM");
        await Promise.race([exit, delay(250)]);
        // The direct process can exit before one of its descendants. The group remains ours.
        kill("SIGKILL");
        await Promise.race([exit, delay(500)]);
        child.stdout.destroy();
        child.stderr.destroy();
      }
      this.notifyClose();
    })();
    return this.closePromise;
  }
}

/** SDK custody only: Host owns timeout, authorization, pagination and result policy. */
export function createMcpProbeConnection(
  config: MCPServerConfig,
  options: { cwd: string; fetch?: typeof fetch; stdioPolicy?: "strict" | "skip-banner" },
) {
  const client = new Client(
    { name: "code-shell-probe", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(options.cwd).href }],
  }));
  const transport: Transport =
    config.transport === "stdio"
      ? new BoundedStdioTransport(config, options.cwd, options.stdioPolicy ?? "strict")
      : new StreamableHTTPClientTransport(new URL(config.url!), {
          fetch: options.fetch as never,
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 100,
            maxReconnectionDelay: 100,
            reconnectionDelayGrowFactor: 1,
          },
        });
  let failure: unknown;
  let rejectFailure!: (error: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // Closing can cause SDK errors after a settled request. Retain a handled promise.
  void failed.catch(() => {});
  client.onerror = (error) => {
    // The SDK reports optional GET/SSE diagnostics here even when POST works.
    // Request rejections still propagate normally; only our bounded transport's
    // explicit fatal errors may poison this connection and its pending request.
    if (!(error instanceof McpProbeConnectionError)) return;
    failure = error;
    rejectFailure(error);
  };
  return {
    connect: async () => {
      await Promise.race([client.connect(transport), failed]);
    },
    listTools: async (cursor?: string) => {
      if (failure) throw failure;
      const result = await Promise.race([client.listTools(cursor ? { cursor } : {}), failed]);
      return {
        tools: result.tools.map(({ name, description }) => ({ name, description })),
        nextCursor: result.nextCursor,
      };
    },
    close: async () => {
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}
