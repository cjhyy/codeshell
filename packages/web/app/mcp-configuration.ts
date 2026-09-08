import { api } from "./auth.js";
import { apiUrl } from "./api-context.js";

export interface HubMcpServer {
  name: string;
  source: "settings" | "plugin";
  scope: "local" | "project" | "user" | "managed" | "plugin";
  editable: boolean;
  deletable: boolean;
  hasLocalOverride: boolean;
  pluginDisabled: boolean;
  enabled: boolean;
  transport: string;
  command?: string;
  argsCount: number;
  url?: string;
  urlHasHiddenParts?: boolean;
  envKeys: string[];
  headerKeys: string[];
  envVars: string[];
  bearerTokenEnvVar?: string;
  envHeaders: Record<string, string>;
  credentialRef?: string;
  allowedTools?: string[];
  disabledTools: string[];
}

export interface HubMcpConfiguration {
  workspacePath: string;
  servers: HubMcpServer[];
  removed: { name: string; scope: string }[];
}

export interface McpProbeResult {
  name: string;
  status: "ok" | "error" | "cancelled";
  checkedAt: string;
  durationMs: number;
  toolCount?: number;
  truncated?: boolean;
  tools?: { name: string; description?: string; allowed: boolean }[];
  error?: { code: string; message: string };
}

export interface McpKeyRow {
  id: string;
  name: string;
  value: string;
  stored: boolean;
  removed: boolean;
  initialValue?: string;
}

export interface McpDraft {
  name: string;
  transport: string;
  command: string;
  args: string;
  clearArgs: boolean;
  url: string;
  env: McpKeyRow[];
  headers: McpKeyRow[];
  envHeaders: McpKeyRow[];
  envVars: string;
  bearerTokenEnvVar: string;
  credentialRef: string;
  enabled: boolean;
  restrictTools: boolean;
  allowedTools: string;
  disabledTools: string;
  reuseStoredSecrets: boolean;
}

export function makeMcpDraft(server?: HubMcpServer): McpDraft {
  const storedRows = (keys: string[]) =>
    keys.map((name, index) => ({
      id: `stored-${index}`,
      name,
      value: "",
      stored: true,
      removed: false,
    }));
  return {
    name: server?.name ?? "",
    transport: server?.transport ?? "stdio",
    command: server?.command ?? "",
    args: "",
    clearArgs: false,
    url: server?.url ?? "",
    env: storedRows(server?.envKeys ?? []),
    headers: storedRows(server?.headerKeys ?? []),
    envHeaders: Object.entries(server?.envHeaders ?? {}).map(([name, value], index) => ({
      id: `stored-${index}`,
      name,
      value,
      initialValue: value,
      stored: true,
      removed: false,
    })),
    envVars: (server?.envVars ?? []).join("\n"),
    bearerTokenEnvVar: server?.bearerTokenEnvVar ?? "",
    credentialRef: server?.credentialRef ?? "",
    enabled: server?.enabled ?? true,
    restrictTools: server?.allowedTools !== undefined,
    allowedTools: (server?.allowedTools ?? []).join("\n"),
    disabledTools: (server?.disabledTools ?? []).join("\n"),
    reuseStoredSecrets: false,
  };
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function mcpRowsPayload(rows: McpKeyRow[], label: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.stored && row.removed) continue;
    const name = row.name.trim();
    if (["__proto__", "prototype", "constructor"].includes(name))
      throw new Error(`${label}名称无效。`);
    if (!name && !row.value && !row.stored) continue;
    if (!name || (!row.stored && !row.value))
      throw new Error(`请完整填写${label}的名称和值，或移除空行。`);
    const key = label === "环境变量" ? name : name.toLowerCase();
    if (seen.has(key)) throw new Error(`${label}名称不能重复。`);
    seen.add(key);
    if (row.removed) result[name] = null;
    else if (row.value && row.value !== row.initialValue) result[name] = row.value;
  }
  return result;
}

function endpointOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function needsMcpSecretReuse(draft: McpDraft, server?: HubMcpServer): boolean {
  if (!server) return false;
  const sensitive =
    server.envKeys.length ||
    server.headerKeys.length ||
    server.envVars.length ||
    Object.keys(server.envHeaders).length ||
    server.credentialRef ||
    server.bearerTokenEnvVar ||
    server.argsCount;
  const changed =
    draft.transport !== server.transport ||
    (draft.transport === "stdio"
      ? draft.command.trim() !== server.command || !!draft.args.trim() || draft.clearArgs
      : endpointOrigin(draft.url) !== endpointOrigin(server.url ?? ""));
  return !!sensitive && changed;
}

/** Only explicit edits leave the browser; a blank secret never replaces a server-held value. */
export function mcpDraftPayload(draft: McpDraft, server?: HubMcpServer): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: draft.name.trim(),
  };
  if (!server || draft.transport !== server.transport) payload.transport = draft.transport;
  if (!server || draft.enabled !== server.enabled) payload.enabled = draft.enabled;
  if (draft.transport === "stdio") {
    if (!server || draft.command.trim() !== server.command) payload.command = draft.command.trim();
    if (draft.clearArgs) payload.args = [];
    else if (draft.args.trim())
      payload.args = draft.args.split(/\r?\n/).filter((line) => line.length > 0);
  } else if (!server || draft.url.trim() !== server.url) payload.url = draft.url.trim();
  for (const [field, label] of [
    ["env", "环境变量"],
    ["headers", "请求头"],
    ["envHeaders", "环境变量请求头"],
  ] as const) {
    const value = mcpRowsPayload(draft[field], label);
    if (Object.keys(value).length) payload[field] = value;
  }
  const envVars = lines(draft.envVars);
  if (!server || JSON.stringify(envVars) !== JSON.stringify(server.envVars))
    payload.envVars = envVars;
  for (const field of ["bearerTokenEnvVar", "credentialRef"] as const) {
    if (!server || draft[field].trim() !== (server[field] ?? ""))
      payload[field] = draft[field].trim() || null;
  }
  const allowedTools = draft.restrictTools ? lines(draft.allowedTools) : undefined;
  if (!server || JSON.stringify(allowedTools) !== JSON.stringify(server.allowedTools))
    payload.allowedTools = allowedTools ?? null;
  const disabledTools = lines(draft.disabledTools);
  if (!server || JSON.stringify(disabledTools) !== JSON.stringify(server.disabledTools))
    payload.disabledTools = disabledTools;
  if (draft.reuseStoredSecrets) payload.reuseStoredSecrets = true;
  return payload;
}

function checkConfiguration(value: HubMcpConfiguration): HubMcpConfiguration {
  if (
    !value ||
    typeof value.workspacePath !== "string" ||
    !Array.isArray(value.servers) ||
    !Array.isArray(value.removed)
  )
    throw new Error("服务端返回了无效的 MCP 配置，请刷新重试。");
  return value;
}

const path = (name: string, suffix = "") =>
  `/api/v1/mcp/servers/${encodeURIComponent(name)}${suffix}`;
export async function readMcpConfiguration(signal?: AbortSignal): Promise<HubMcpConfiguration> {
  return checkConfiguration(await api("/api/v1/mcp", { signal }));
}
async function write(
  path: string,
  method: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<HubMcpConfiguration> {
  return checkConfiguration(
    await api(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    }),
  );
}
export function saveMcpServer(
  draft: McpDraft,
  server?: HubMcpServer,
  signal?: AbortSignal,
): Promise<HubMcpConfiguration> {
  return write(
    server ? path(server.name) : "/api/v1/mcp/servers",
    server ? "PUT" : "POST",
    mcpDraftPayload(draft, server),
    signal,
  );
}
export function enableMcpServer(
  name: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<HubMcpConfiguration> {
  return write(path(name, "/enabled"), "PUT", { enabled }, signal);
}
export function deleteMcpServer(name: string, signal?: AbortSignal): Promise<HubMcpConfiguration> {
  return write(path(name), "DELETE", undefined, signal);
}
export function inheritMcpServer(name: string, signal?: AbortSignal): Promise<HubMcpConfiguration> {
  return write(path(name, "/inherit"), "POST", {}, signal);
}
export async function probeMcpServer(name: string, signal?: AbortSignal): Promise<McpProbeResult> {
  const result = await api<McpProbeResult>(path(name, "/probe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (result.name !== name || !["ok", "error", "cancelled"].includes(result.status))
    throw new Error("服务端返回了无效的连接测试结果。");
  return result;
}
export function cancelMcpProbe(
  name: string,
  workspace?: string,
  projectId?: string | null,
): Promise<{ cancelled: boolean }> {
  return api(apiUrl(path(name, "/cancel-probe"), workspace, projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    keepalive: true,
  });
}
