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

import {
  buildHttpHeaders,
  CredentialStore,
  isCredentialSecretAvailable,
  localCredentialAccess,
} from "@cjhyy/code-shell-core";
import { probeMcp, mcpProbeTransport } from "@cjhyy/code-shell-host";
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

/** Exported for unit testing (error classification). */
export function humanizeError(raw: string, command?: string): string {
  if (/ENOENT/.test(raw)) return "找不到命令（请确认已安装或路径正确）";
  if (/EACCES/.test(raw)) return "命令没有可执行权限";
  if (/ECONNREFUSED/.test(raw)) return "无法连接到服务（拒绝连接）";
  if (/ETIMEDOUT|timed out/i.test(raw)) {
    // npx/uvx-style runners download the package on FIRST run, which easily
    // blows the probe timeout; the cache makes the next run instant. Say so,
    // instead of leaving the user staring at a bare "连接超时".
    if (command && /\b(npx|uvx|bunx|pipx)\b/.test(command)) {
      return "连接超时 — npx/uvx 首次运行需下载包，常超过探测超时；稍后重试通常即可";
    }
    return "连接超时";
  }
  if (/ENOTFOUND/.test(raw)) return "域名解析失败";
  // Auth errors, most-specific first:
  // 1. A referenced env var is missing — core's readRequiredEnv error names
  //    the var and the config field; surface both so the fix is obvious.
  const envMiss = /env var "([^"]+)" \(from ([^)]+)\) is not set/.exec(raw);
  if (envMiss) {
    return `鉴权配置错误：环境变量 ${envMiss[1]}（${envMiss[2]}）未设置或为空 — 该字段填的是环境变量名，值在连接时从系统环境读取，请先在启动环境里设置它`;
  }
  if (/oauth credential "([^"]+)" access token expired/i.test(raw)) {
    return "OAuth 登录已过期 — 请在 MCP 认证设置里刷新或重新登录该 OAuth 凭证";
  }
  // 2. Credentials reached the server but were rejected (401) vs accepted
  //    but lacking permission (403).
  if (/unauthorized|\b401\b|-32001/i.test(raw)) {
    return "鉴权失败（HTTP 401）— 该 server 需要认证：如果是 Bearer/JWT，请配置 Bearer 凭证或 Bearer Token 环境变量；如果是 OAuth，请登录或刷新 OAuth 凭证；如果是 API key，请配置服务要求的自定义认证 Header（如 x-api-key）";
  }
  if (/forbidden|\b403\b/i.test(raw)) {
    return "无权限（HTTP 403）— 凭证有效但权限不足，请检查该 token / key 的权限范围";
  }
  if (/Invalid URL/i.test(raw)) return "URL 格式无效";
  // Trim to first line to keep the card readable.
  return raw.split("\n")[0].slice(0, 200);
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
  });
  if (result.status === "ok")
    return {
      ...base,
      status: "ok",
      toolCount: result.toolCount,
      tools: result.tools?.map(({ name, description }) => ({ name, description })),
    };
  const detail = result.error?.message ?? "连接测试失败";
  dlog("mcp-probe", "failed", {
    server: cfg.name,
    transport: base.transport,
    code: result.error?.code,
  });
  return { ...base, status: "error", errorMessage: detail, errorDetail: detail };
}

export function buildProbeHttpHeaders(cfg: McpServerConfig): Record<string, string> {
  const credStore = new CredentialStore(undefined);
  return buildHttpHeaders(cfg.name, cfg, (id) => {
    const cred = credStore.resolve(id);
    return cred && isCredentialSecretAvailable(cred.secret)
      ? { secret: cred.secret, type: cred.type, label: cred.label }
      : undefined;
  });
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
