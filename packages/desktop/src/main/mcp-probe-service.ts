/**
 * MCP probe service — main-process driven probing of configured MCP
 * servers, used by the settings UI to surface real runtime status
 * (connection ok / error message / tool count / tool list) without
 * waiting for an engine worker to spawn.
 *
 * The agent worker still owns the long-lived MCP connections for actual
 * tool execution. Probes here open a short-lived sibling connection,
 * list tools, then close. Results are cached in-memory with a small TTL
 * so the UI can be refreshed without re-probing on every tab switch.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dlog } from "./desktop-logger.js";

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: "stdio" | "streamable-http" | "sse";
  headers?: Record<string, string>;
}

export interface McpProbedTool {
  name: string;
  description?: string;
}

export type McpProbeStatus = "ok" | "error" | "probing" | "unknown";

export interface McpProbeResult {
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  status: McpProbeStatus;
  /** ISO timestamp of the most recent probe attempt. */
  lastProbedAt?: string;
  /** Total tool count exposed by the server. */
  toolCount?: number;
  /** First N tools for the "查看 tools" preview. */
  tools?: McpProbedTool[];
  /** Short, user-readable error if status is "error". */
  errorMessage?: string;
  /** Verbatim error stack/output (for "查看详情" expander). */
  errorDetail?: string;
}

const PROBE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  result: McpProbeResult;
  configHash: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function hashConfig(cfg: McpServerConfig): string {
  return JSON.stringify({
    t: cfg.transport ?? (cfg.command ? "stdio" : "streamable-http"),
    c: cfg.command,
    a: cfg.args ?? [],
    u: cfg.url,
    e: cfg.env ?? {},
    h: cfg.headers ?? {},
  });
}

function transportOf(cfg: McpServerConfig): "stdio" | "streamable-http" | "sse" {
  if (cfg.transport) return cfg.transport;
  if (cfg.url) return "streamable-http";
  return "stdio";
}

function humanizeError(raw: string): string {
  if (/ENOENT/.test(raw)) return "找不到命令（请确认已安装或路径正确）";
  if (/EACCES/.test(raw)) return "命令没有可执行权限";
  if (/ECONNREFUSED/.test(raw)) return "无法连接到服务（拒绝连接）";
  if (/ETIMEDOUT|timed out/i.test(raw)) return "连接超时";
  if (/ENOTFOUND/.test(raw)) return "域名解析失败";
  if (/unauthorized|401|403/i.test(raw)) return "鉴权失败（检查 API key / headers）";
  if (/Invalid URL/i.test(raw)) return "URL 格式无效";
  // Trim to first line to keep the card readable.
  return raw.split("\n")[0].slice(0, 200);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function probeOne(cfg: McpServerConfig): Promise<McpProbeResult> {
  const transport = transportOf(cfg);
  const startedAt = new Date().toISOString();
  const base: McpProbeResult = {
    name: cfg.name,
    transport,
    status: "probing",
    lastProbedAt: startedAt,
  };

  let client: Client | undefined;
  let mcpTransport: StdioClientTransport | StreamableHTTPClientTransport | undefined;

  try {
    client = new Client(
      { name: "code-shell-probe", version: "0.1.0" },
      { capabilities: {} },
    );

    if (transport === "stdio") {
      if (!cfg.command) throw new Error("stdio 缺少 command 字段");
      mcpTransport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env
          ? ({ ...process.env, ...cfg.env } as Record<string, string>)
          : undefined,
      });
    } else {
      if (!cfg.url) throw new Error("远程 transport 缺少 url 字段");
      mcpTransport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
    }

    await withTimeout(client.connect(mcpTransport), PROBE_TIMEOUT_MS, "connect");
    const list = await withTimeout(client.listTools(), PROBE_TIMEOUT_MS, "listTools");
    const tools = list.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));

    return {
      ...base,
      status: "ok",
      toolCount: tools.length,
      tools,
      lastProbedAt: new Date().toISOString(),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const detail = err instanceof Error ? err.stack ?? raw : raw;
    dlog("mcp-probe", "failed", { server: cfg.name, transport, error: raw });
    return {
      ...base,
      status: "error",
      errorMessage: humanizeError(raw),
      errorDetail: detail,
      lastProbedAt: new Date().toISOString(),
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        /* best-effort cleanup */
      }
    }
    if (mcpTransport && !client) {
      try {
        await mcpTransport.close?.();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Probe a single server, honoring cache unless `force` is true.
 */
export async function probeMcpServer(
  cfg: McpServerConfig,
  options: { force?: boolean } = {},
): Promise<McpProbeResult> {
  const configHash = hashConfig(cfg);
  const cached = cache.get(cfg.name);
  if (
    !options.force &&
    cached &&
    cached.configHash === configHash &&
    cached.expiresAt > Date.now()
  ) {
    return cached.result;
  }

  const result = await probeOne(cfg);
  cache.set(cfg.name, {
    result,
    configHash,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return result;
}

/**
 * Probe every configured server in parallel. Failures don't block the
 * batch — each server's status is reported independently.
 */
export async function probeMcpServers(
  configs: McpServerConfig[],
  options: { force?: boolean } = {},
): Promise<McpProbeResult[]> {
  return Promise.all(configs.map((c) => probeMcpServer(c, options)));
}

export function invalidateMcpProbeCache(name?: string): void {
  if (name) cache.delete(name);
  else cache.clear();
}
