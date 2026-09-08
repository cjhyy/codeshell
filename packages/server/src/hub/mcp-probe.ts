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
import {
  buildStdioEnv,
  createMcpAuthenticatedFetch,
  localCredentialAccess,
  type MCPServerConfig,
} from "@cjhyy/code-shell-core";

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_TOOLS = 100;
const MAX_TOOL_PAGES = 8;

export interface HubMcpProbeResult {
  name: string;
  status: "ok" | "error" | "cancelled";
  checkedAt: string;
  durationMs: number;
  toolCount?: number;
  truncated?: boolean;
  tools?: { name: string; description?: string; allowed: boolean }[];
  error?: { code: string; message: string };
}

class ProbeFailure extends Error {
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
  ) {}

  async start(): Promise<void> {
    if (this.closed || this.child) throw new ProbeFailure("cancelled", "测试已取消。");
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
      this.onerror?.(new ProbeFailure("response_too_large", "服务返回的数据过大，测试已停止。"));
      void this.close();
      return;
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    for (let index = this.pending.indexOf(10); index !== -1; index = this.pending.indexOf(10)) {
      const line = this.pending.subarray(0, index).toString("utf8").trim();
      this.pending = this.pending.subarray(index + 1);
      if (!line) continue;
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
      } catch {
        this.onerror?.(
          new ProbeFailure(
            "invalid_protocol",
            "命令的输出不是有效的 MCP 协议消息，请检查启动方式。",
          ),
        );
        void this.close();
        return;
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.child?.stdin.writable)
      throw new ProbeFailure("closed", "服务连接已关闭。");
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

function rememberSecret(secrets: Set<string>, value: string | undefined): void {
  if (!value) return;
  secrets.add(value);
  if (/^Bearer\s+/i.test(value)) secrets.add(value.replace(/^Bearer\s+/i, ""));
  const match = /(?:token|secret|password|api[-_]?key)=([^\s]+)/i.exec(value);
  if (match?.[1]) secrets.add(match[1]);
}

function redact(text: string, secrets: ReadonlySet<string>, maximum: number): string {
  let safe = text;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    safe = safe.split(secret).join("[已隐藏]");
  }
  return safe.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, maximum);
}

function classify(error: unknown): { code: string; message: string } {
  if (error instanceof ProbeFailure) return { code: error.code, message: error.message };
  const status = (error as { code?: unknown })?.code;
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    messages.push(current instanceof Error ? current.message : String(current));
    const item = current as { code?: unknown; cause?: unknown };
    if (typeof item.code === "string") messages.push(item.code);
    current = item.cause;
  }
  const raw = messages.join(" ");
  if (/ENOENT/.test(raw))
    return {
      code: "command_missing",
      message: "服务器上找不到这个命令，请确认已安装并填写正确路径。",
    };
  if (/EACCES/.test(raw))
    return { code: "permission_denied", message: "服务器没有执行这个命令的权限。" };
  if (/ECONNREFUSED/.test(raw))
    return {
      code: "connection_refused",
      message: "目标服务拒绝连接，请检查地址、端口和服务状态。",
    };
  if (/ENOTFOUND|EAI_AGAIN/.test(raw))
    return { code: "dns", message: "无法解析服务域名，请检查地址和服务器的网络。" };
  if (/env var .* is not set/.test(raw))
    return {
      code: "environment_missing",
      message: "配置引用的服务器环境变量未设置，请检查环境变量名称和服务启动环境。",
    };
  if (/credential .*not found|credential .*empty|metadata is unavailable/.test(raw))
    return {
      code: "credential_missing",
      message: "引用的凭据不存在或不可用，请检查服务器上的凭据配置。",
    };
  if (/expired|oauth.*requires/i.test(raw))
    return {
      code: "credential_expired",
      message: "认证凭据已过期或需要重新授权，请在服务器上更新凭据。",
    };
  if (
    status === 401 ||
    /\b401\b|unauthori[sz]ed|-32001|no auth provider/i.test(raw) ||
    (error instanceof Error && error.name === "UnauthorizedError")
  )
    return { code: "unauthorized", message: "服务拒绝了认证信息，请检查 API Key、请求头或凭据。" };
  if (status === 403 || /\b403\b|forbidden/i.test(raw))
    return { code: "forbidden", message: "当前凭据没有使用此服务的权限。" };
  if (status === 404 || /\b404\b/.test(raw))
    return { code: "not_found", message: "这个地址没有提供 MCP 服务，请确认完整的 MCP 接口地址。" };
  if (status === 405 || /\b405\b|Unexpected content type|protocol|JSON/i.test(raw))
    return { code: "protocol", message: "服务没有返回预期的 MCP 协议，请检查连接类型与接口地址。" };
  if (/timed out|timeout|ETIMEDOUT/i.test(raw))
    return {
      code: "timeout",
      message: "连接测试超时。首次运行包管理器可能需要下载依赖，可以稍后重试。",
    };
  if (/certificate|TLS|SSL/i.test(raw))
    return { code: "tls", message: "服务的 HTTPS 证书验证失败，请检查证书和服务器信任配置。" };
  return {
    code: "connection_failed",
    message: "连接测试失败。请确认服务支持 MCP、命令可以启动，并检查服务器上的服务日志。",
  };
}

/** Explicit, bounded sibling connection; configuration reads never invoke this function. */
export async function probeHubMcp(
  config: MCPServerConfig,
  options: { cwd: string; signal: AbortSignal; timeoutMs?: number },
): Promise<HubMcpProbeResult> {
  const started = Date.now();
  const secrets = new Set<string>();
  for (const value of [
    ...Object.values(config.env ?? {}),
    ...Object.values(config.headers ?? {}),
    ...(config.args ?? []),
  ])
    rememberSecret(secrets, value);
  for (const name of [
    ...(config.envVars ?? []),
    ...Object.values(config.envHeaders ?? {}),
    config.bearerTokenEnvVar,
  ]) {
    if (name) rememberSecret(secrets, process.env[name]);
  }
  if (config.url) {
    try {
      const url = new URL(config.url);
      for (const value of [url.username, url.password, ...url.searchParams.values()]) {
        rememberSecret(secrets, value);
        try {
          rememberSecret(secrets, decodeURIComponent(value));
        } catch {
          /* The raw URL component is already hidden. */
        }
      }
    } catch {
      /* Invalid URLs are classified below without returning the original value. */
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new ProbeFailure(
          "timeout",
          "连接测试超时。首次运行包管理器可能需要下载依赖，可以稍后重试。",
        ),
      ),
    options.timeoutMs ?? 10_000,
  );
  const cancel = () => controller.abort(new ProbeFailure("cancelled", "测试已取消。"));
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const client = new Client(
    { name: "code-shell-hub-probe", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(options.cwd).href }],
  }));
  let transport: Transport | undefined;
  let transportError: Error | undefined;
  client.onerror = (error) => {
    transportError = error;
  };
  let rejectAbort: ((error: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort?.(controller.signal.reason);
    if (transport) void transport.close().catch(() => {});
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const mode = config.transport ?? (config.url ? "streamable-http" : "stdio");
    if (mode === "stdio") {
      if (!config.command) throw new ProbeFailure("invalid_config", "请先填写启动命令。");
      transport = new BoundedStdioTransport(config, options.cwd);
    } else if (mode === "streamable-http" || mode === "sse") {
      if (!config.url) throw new ProbeFailure("invalid_config", "请先填写 MCP 接口地址。");
      const boundedFetch: typeof fetch = (async (input, init) => {
        const request = new Request(input as never, init);
        for (const [, value] of request.headers) rememberSecret(secrets, value);
        const signal = AbortSignal.any([request.signal, controller.signal]);
        const response = await fetch(new Request(request, { signal, redirect: "error" }));
        if (!response.body) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, stream) {
              bytes += chunk.byteLength;
              if (bytes > MAX_TOTAL_BYTES) {
                const error = new ProbeFailure(
                  "response_too_large",
                  "服务返回的数据过大，测试已停止。",
                );
                controller.abort(error);
                stream.error(error);
              } else stream.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }) as typeof fetch;
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: createMcpAuthenticatedFetch(
          config.name,
          config,
          localCredentialAccess,
          boundedFetch,
        ) as never,
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 100,
          maxReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1,
        },
      });
    } else
      throw new ProbeFailure(
        "unsupported_transport",
        "此内置服务由任务进程管理，不能创建独立测试连接。",
      );
    const run = (async () => {
      await client.connect(transport!);
      let cursor: string | undefined;
      let toolCount = 0;
      const tools: NonNullable<HubMcpProbeResult["tools"]> = [];
      const seen = new Set<string>();
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await client.listTools(cursor ? { cursor } : {});
        toolCount += result.tools.length;
        for (const tool of result.tools) {
          if (tools.length >= MAX_PREVIEW_TOOLS) break;
          tools.push({
            name: redact(tool.name, secrets, 160),
            ...(tool.description ? { description: redact(tool.description, secrets, 600) } : {}),
            allowed:
              (config.allowedTools === undefined || config.allowedTools.includes(tool.name)) &&
              !(config.disabledTools ?? []).includes(tool.name),
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (seen.has(cursor))
          throw new ProbeFailure("invalid_protocol", "服务返回了重复的工具分页游标，测试已停止。");
        seen.add(cursor);
      }
      return { toolCount, tools, truncated: !!cursor || tools.length < toolCount };
    })();
    const result = await Promise.race([run, aborted]);
    return {
      name: config.name,
      status: "ok",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...result,
    };
  } catch (cause) {
    const error = classify(
      controller.signal.aborted
        ? controller.signal.reason
        : transportError instanceof ProbeFailure
          ? transportError
          : cause,
    );
    return {
      name: config.name,
      status: error.code === "cancelled" ? "cancelled" : "error",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      error,
    };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    await transport?.close().catch(() => {});
    await client.close().catch(() => {});
  }
}
