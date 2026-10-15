import { isAbsolute } from "node:path";
import {
  createMcpAuthenticatedFetch,
  localCredentialAccess,
  type MCPServerConfig,
} from "@cjhyy/code-shell-core";
import {
  createMcpProbeConnection,
  McpProbeConnectionError as ProbeFailure,
} from "@cjhyy/code-shell-core/internal";
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_TOOLS = 100;
const MAX_TOOL_PAGES = 8;

export function mcpProbeTransport(config: {
  transport?: "stdio" | "streamable-http" | "sse";
  url?: string;
}): "stdio" | "streamable-http" | "sse";
export function mcpProbeTransport(
  config: Pick<MCPServerConfig, "transport" | "url">,
): NonNullable<MCPServerConfig["transport"]>;
export function mcpProbeTransport(
  config: Pick<MCPServerConfig, "transport" | "url">,
): NonNullable<MCPServerConfig["transport"]> {
  return config.transport ?? (config.url ? "streamable-http" : "stdio");
}
export interface McpProbeResult {
  name: string;
  status: "ok" | "error" | "cancelled";
  checkedAt: string;
  durationMs: number;
  toolCount?: number;
  truncated?: boolean;
  tools?: { name: string; description?: string; allowed: boolean }[];
  error?: {
    code: string;
    message: string;
    detail: string;
    environment?: { name: string; field: string };
  };
}

function rememberSecret(secrets: Set<string>, value: string | undefined): void {
  if (!value) return;
  secrets.add(value);
  if (/^(Bearer|Basic|Token)\s+/i.test(value))
    secrets.add(value.replace(/^(Bearer|Basic|Token)\s+/i, ""));
  const match = /(?:token|secret|password|credentials?|api[-_]?key)=([^\s]+)/i.exec(value);
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
      message: "找不到这个命令，请确认已安装并填写正确路径。",
    };
  if (/EACCES/.test(raw)) return { code: "permission_denied", message: "没有执行这个命令的权限。" };
  if (/ECONNREFUSED/.test(raw))
    return {
      code: "connection_refused",
      message: "目标服务拒绝连接，请检查地址、端口和服务状态。",
    };
  if (/ENOTFOUND|EAI_AGAIN/.test(raw))
    return { code: "dns", message: "无法解析服务域名，请检查地址和当前网络。" };
  if (/env var .* is not set/.test(raw))
    return {
      code: "environment_missing",
      message: "配置引用的环境变量未设置，请检查环境变量名称和服务启动环境。",
    };
  if (/credential .*not found|credential .*empty|metadata is unavailable/.test(raw))
    return {
      code: "credential_missing",
      message: "引用的凭据不存在或不可用，请检查凭据配置。",
    };
  if (/expired|oauth.*requires/i.test(raw))
    return {
      code: "credential_expired",
      message: "认证凭据已过期或需要重新授权，请更新凭据。",
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
    return { code: "tls", message: "服务的 HTTPS 证书验证失败，请检查证书和信任配置。" };
  return {
    code: "connection_failed",
    message: "连接测试失败。请确认服务支持 MCP、命令可以启动，并检查服务日志。",
  };
}

/** Explicit, bounded sibling connection; configuration reads never invoke this function. */
export async function probeMcp(
  config: MCPServerConfig,
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    credentialAccess?: Parameters<typeof createMcpAuthenticatedFetch>[2];
    stdioPolicy?: "strict" | "skip-banner";
  },
): Promise<McpProbeResult> {
  if (!isAbsolute(options.cwd)) throw new Error("MCP probe requires an absolute workspace");
  config = structuredClone(config);
  const started = Date.now();
  const secrets = new Set<string>();
  for (const value of Object.values(config.env ?? {})) rememberSecret(secrets, value);
  const secretHeader = (name: string) =>
    /authorization|cookie|(?:^|[-_])(?:token|secret|password|credentials?|key|auth)(?:$|[-_])/i.test(
      name,
    ) || Object.hasOwn(config.envHeaders ?? {}, name);
  for (const [name, value] of Object.entries(config.headers ?? {}))
    if (secretHeader(name)) rememberSecret(secrets, value);
  // Launcher verbs, paths and protocol/content-type values are not credentials.
  // Recognize explicit token-style flags instead of treating every argv as a secret.
  const args = config.args ?? [];
  for (let index = 0; index < args.length; index++) {
    const match =
      /^--?(?:[\w]+[-_])*(?:token|secret|password|credentials?|api[-_]?key|authorization|auth)(?:=(.*))?$/i.exec(
        args[index]!,
      );
    if (match) rememberSecret(secrets, match[1] ?? args[index + 1]);
    const bearer = /\bBearer\s+(.+)/i.exec(args[index]!);
    if (bearer) rememberSecret(secrets, bearer[1]);
  }
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
      const privateQueryValues = [...url.searchParams]
        .filter(([name]) =>
          /token|secret|password|credential|key|auth|^(access|code|sig|signature)$/i.test(name),
        )
        .map(([, value]) => value);
      for (const value of [url.username, url.password, ...privateQueryValues]) {
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
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let connection: ReturnType<typeof createMcpProbeConnection> | undefined;
  let rejectAbort: ((error: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort?.(controller.signal.reason);
    if (connection) void connection.close().catch(() => {});
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const mode = mcpProbeTransport(config);
    if (!["stdio", "streamable-http", "sse"].includes(mode))
      throw new ProbeFailure(
        "unsupported_transport",
        "此内置服务由任务进程管理，不能创建独立测试连接。",
      );
    if (mode === "stdio" && !config.command)
      throw new ProbeFailure("invalid_config", "请先填写启动命令。");
    if (mode !== "stdio" && !config.url)
      throw new ProbeFailure("invalid_config", "请先填写 MCP 接口地址。");
    let totalBytes = 0;
    const boundedFetch: typeof fetch = (async (input, init) => {
      const request = new Request(input as never, init);
      for (const [name, value] of request.headers)
        if (secretHeader(name)) rememberSecret(secrets, value);
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const response = await fetch(new Request(request, { signal, redirect: "error" }));
      if (!response.body) return response;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, stream) {
            totalBytes += chunk.byteLength;
            if (totalBytes > MAX_TOTAL_BYTES) {
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
    connection = createMcpProbeConnection(
      { ...config, transport: mode },
      {
        cwd: options.cwd,
        stdioPolicy: options.stdioPolicy,
        fetch: createMcpAuthenticatedFetch(
          config.name,
          config,
          options.credentialAccess ?? localCredentialAccess,
          boundedFetch,
        ),
      },
    );
    const run = (async () => {
      await connection!.connect();
      let cursor: string | undefined;
      let toolCount = 0;
      const tools: NonNullable<McpProbeResult["tools"]> = [];
      const seen = new Set<string>();
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await connection!.listTools(cursor);
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
    const failure = controller.signal.aborted ? controller.signal.reason : cause;
    const classified = classify(failure);
    const raw = failure instanceof Error ? failure.message : "";
    const missing =
      /env var "([A-Za-z_][A-Za-z0-9_]{0,127})" \(from (envVars|envHeaders|bearerTokenEnvVar)\) is not set/.exec(
        raw,
      );
    const referenced =
      missing &&
      (missing[2] === "envVars"
        ? config.envVars?.includes(missing[1]!)
        : missing[2] === "envHeaders"
          ? Object.values(config.envHeaders ?? {}).includes(missing[1]!)
          : config.bearerTokenEnvVar === missing[1]);
    const environment =
      referenced && missing ? { name: missing[1]!, field: missing[2]! } : undefined;
    // SDK/provider error bodies can contain unrelated secrets. Never return raw
    // stacks/bodies; expose bounded technical context and validated config names.
    const error = {
      ...classified,
      detail: redact(
        `MCP probe: code=${classified.code}; transport=${mcpProbeTransport(config)}${environment ? `; env var "${environment.name}" (from ${environment.field}) is not set` : ""}`,
        secrets,
        1200,
      ),
      ...(environment ? { environment } : {}),
    };
    return {
      name: config.name,
      status: error.code === "cancelled" ? "cancelled" : "error",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      error,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    await connection?.close().catch(() => {});
  }
}
