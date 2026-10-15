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

import { localCredentialAccess } from "@cjhyy/code-shell-core";
import {
  probeMcp,
  mcpProbeTransport,
  type McpProbeResult as HostMcpProbeResult,
} from "@cjhyy/code-shell-host";
import { dlog } from "./desktop-logger.js";
import type { McpOAuthService } from "./mcp-oauth-service.js";

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: "stdio" | "streamable-http" | "sse";
  headers?: Record<string, string>;
  /** (stdio) NAMES of env vars forwarded from the parent process. */
  envVars?: string[];
  /** (HTTP) NAME of an env var sent as `Authorization: Bearer <value>`. */
  bearerTokenEnvVar?: string;
  /** (HTTP) header-name → env-var-NAME map, values read at connect time. */
  envHeaders?: Record<string, string>;
  /** (HTTP) id of a stored token/link/oauth credential used as Bearer auth. */
  credentialRef?: string;
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
  /** Redacted error detail (for "查看详情" expander). */
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
    t: mcpProbeTransport(cfg),
    c: cfg.command,
    a: cfg.args ?? [],
    u: cfg.url,
    e: cfg.env ?? {},
    h: cfg.headers ?? {},
    ev: cfg.envVars ?? [],
    b: cfg.bearerTokenEnvVar ?? "",
    eh: cfg.envHeaders ?? {},
    cr: cfg.credentialRef ?? "",
  });
}

function desktopProbeError(
  error: NonNullable<HostMcpProbeResult["error"]>,
  command?: string,
): string {
  switch (error.code) {
    case "command_missing":
      return "找不到命令（请确认已安装或路径正确）";
    case "permission_denied":
      return "命令没有可执行权限";
    case "connection_refused":
      return "无法连接到服务（拒绝连接）";
    case "dns":
      return "域名解析失败";
    case "timeout":
      return command && /\b(npx|uvx|bunx|pipx)\b/.test(command)
        ? "连接超时 — npx/uvx 首次运行需下载包，常超过探测超时；稍后重试通常即可"
        : "连接超时";
    case "environment_missing":
      return error.environment
        ? `鉴权配置错误：环境变量 ${error.environment.name}（${error.environment.field}）未设置或为空 — 该字段填的是环境变量名，值在连接时从系统环境读取，请先在启动环境里设置它`
        : "鉴权配置错误：引用的环境变量未设置或为空";
    case "credential_expired":
      return "OAuth 登录已过期 — 请在 MCP 认证设置里刷新或重新登录该 OAuth 凭证";
    case "unauthorized":
      return "鉴权失败（HTTP 401）— 该 server 需要认证：如果是 Bearer/JWT，请配置 Bearer 凭证或 Bearer Token 环境变量；如果是 OAuth，请登录或刷新 OAuth 凭证；如果是 API key，请配置服务要求的自定义认证 Header（如 x-api-key）";
    case "forbidden":
      return "无权限（HTTP 403）— 凭证有效但权限不足，请检查该 token / key 的权限范围";
    default:
      return error.message;
  }
}

interface ProbeOptions {
  force?: boolean;
  cwd?: string;
  signal?: AbortSignal;
  oauthService?: Pick<McpOAuthService, "resolveAccessToken">;
}

async function probeOne(cfg: McpServerConfig, options: ProbeOptions): Promise<McpProbeResult> {
  const base = {
    name: cfg.name,
    transport: mcpProbeTransport(cfg),
    lastProbedAt: new Date().toISOString(),
  };
  if (!options.cwd)
    return {
      ...base,
      status: "error",
      errorMessage: "缺少明确的工作区，请重新打开 MCP 设置后重试。",
    };
  const access = options.oauthService
    ? {
        ...localCredentialAccess,
        resolveOAuthAccess: (req: { id: string; scope: "full"; forceRefresh?: boolean }) =>
          options.oauthService!.resolveAccessToken(req.id, { forceRefresh: req.forceRefresh }),
      }
    : localCredentialAccess;
  const result = await probeMcp(cfg, {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    credentialAccess: access,
    stdioPolicy: "skip-banner",
  });
  if (result.status === "ok")
    return {
      ...base,
      status: "ok",
      toolCount: result.toolCount,
      tools: result.tools?.map(({ name, description }) => ({ name, description })),
    };
  const message = result.error ? desktopProbeError(result.error, cfg.command) : "连接测试失败";
  const detail = result.error?.detail ?? message;
  dlog("mcp-probe", "failed", {
    server: cfg.name,
    transport: base.transport,
    code: result.error?.code,
  });
  return { ...base, status: "error", errorMessage: message, errorDetail: detail };
}

/**
 * Probe a single server, honoring cache unless `force` is true.
 */
export async function probeMcpServer(
  cfg: McpServerConfig,
  options: ProbeOptions = {},
): Promise<McpProbeResult> {
  const configHash = hashConfig(cfg);
  const key = JSON.stringify([options.cwd, cfg.name]);
  // Credential and forwarded-env revisions are owned by the adapter. Without
  // a versioned snapshot, do not retain their results across authorization changes.
  const cacheable =
    !!options.cwd &&
    !options.signal &&
    !cfg.credentialRef &&
    !cfg.bearerTokenEnvVar &&
    !cfg.envVars?.length &&
    !Object.keys(cfg.envHeaders ?? {}).length;
  const cached = cacheable ? cache.get(key) : undefined;
  if (
    !options.force &&
    cached &&
    cached.configHash === configHash &&
    cached.expiresAt > Date.now()
  ) {
    return cached.result;
  }

  const result = await probeOne(cfg, options);
  if (cacheable)
    cache.set(key, {
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
  options: ProbeOptions = {},
): Promise<McpProbeResult[]> {
  return Promise.all(configs.map((c) => probeMcpServer(c, options)));
}

export function invalidateMcpProbeCache(name?: string): void {
  if (name) {
    for (const key of cache.keys()) if (JSON.parse(key)[1] === name) cache.delete(key);
  } else cache.clear();
}
