import { probeMcp, type McpProbeResult } from "@cjhyy/code-shell-host";

export type HubMcpProbeResult = McpProbeResult;
/** HTTP authority and cancellation stay in mcp-configuration; only server-facing wording lives here. */
export async function probeHubMcp(
  ...args: Parameters<typeof probeMcp>
): Promise<HubMcpProbeResult> {
  const result = await probeMcp(...args);
  if (!result.error) return result;
  const messages: Record<string, string> = {
    command_missing: "服务器上找不到这个命令，请确认已安装并填写正确路径。",
    permission_denied: "服务器没有执行这个命令的权限。",
    dns: "无法解析服务域名，请检查地址和服务器的网络。",
    environment_missing: "配置引用的服务器环境变量未设置，请检查环境变量名称和服务启动环境。",
    credential_missing: "引用的凭据不存在或不可用，请检查服务器上的凭据配置。",
    credential_expired: "认证凭据已过期或需要重新授权，请在服务器上更新凭据。",
    tls: "服务的 HTTPS 证书验证失败，请检查证书和服务器信任配置。",
    connection_failed: "连接测试失败。请确认服务支持 MCP、命令可以启动，并检查服务器上的服务日志。",
  };
  return {
    ...result,
    error: { ...result.error, message: messages[result.error.code] ?? result.error.message },
  };
}
