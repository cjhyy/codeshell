import { api, browserId } from "./auth.js";
import { apiUrl } from "./api-context.js";

export interface HubConnection {
  id: string;
  revision?: string;
  catalogId: string;
  tag: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  needsKey: boolean;
}

export interface HubCatalogEntry {
  id: string;
  displayName: string;
  adapterKind: string;
  defaultBaseUrl: string;
  needsKey: boolean;
}

export interface HubSkill {
  name: string;
  description: string;
  source: "project" | "user" | "plugin" | "panel-app";
  enabled: boolean;
  disabledReason?: string;
}

export interface HubConfiguration {
  workspace: { path: string; settingsScope: "local"; skillDirectories: string[] };
  defaults: { text?: string; auxText?: string };
  connections: HubConnection[];
  catalog: HubCatalogEntry[];
  skills: HubSkill[];
  mcpServers: { name: string; transport: string; enabled: boolean }[];
  restartRequired: boolean;
}

export interface ConnectionDraft {
  expectedRevision?: string | null;
  id: string;
  catalogId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** A blank key means keep the server's credential; secrets are never loaded into a draft. */
export function connectionDraft(connection?: HubConnection): ConnectionDraft {
  return {
    expectedRevision: connection ? connection.revision : null,
    id: connection?.id ?? "",
    catalogId: connection?.catalogId ?? "",
    model: connection?.model ?? "",
    baseUrl: connection?.baseUrl ?? "",
    apiKey: "",
  };
}

export function connectionPayload(draft: ConnectionDraft): Record<string, string | null> {
  const payload: Record<string, string | null> = {
    id: draft.id.trim(),
    catalogId: draft.catalogId,
    model: draft.model.trim(),
    baseUrl: draft.baseUrl.trim(),
  };
  if (draft.expectedRevision !== undefined) payload.expectedRevision = draft.expectedRevision;
  if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
  return payload;
}

function checkConfiguration(value: HubConfiguration): HubConfiguration {
  if (
    !value ||
    typeof value.workspace?.path !== "string" ||
    !value.defaults ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.catalog) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.mcpServers) ||
    !Array.isArray(value.workspace.skillDirectories)
  ) {
    throw new Error("服务端返回了无效的设置，请刷新后重试。");
  }
  return value;
}

export async function readConfiguration(signal?: AbortSignal): Promise<HubConfiguration> {
  return checkConfiguration(await api("/api/v1/configuration", { signal }));
}

async function updateConfiguration(
  resource: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<HubConfiguration> {
  return checkConfiguration(
    await api(`/api/v1/configuration/${resource}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  );
}

export function saveConnection(draft: ConnectionDraft, signal?: AbortSignal) {
  return updateConfiguration("connections", connectionPayload(draft), signal);
}

export function saveDefaults(
  defaults: { text: string; auxText?: string | null },
  signal?: AbortSignal,
) {
  return updateConfiguration("defaults", defaults, signal);
}

export function setSkillEnabled(name: string, enabled: boolean, signal?: AbortSignal) {
  return updateConfiguration("skills", { name, enabled }, signal);
}

export async function readSkill(name: string, signal?: AbortSignal): Promise<string> {
  const result = await api<{ name: string; content: string }>(
    `/api/v1/configuration/skill?name=${encodeURIComponent(name)}`,
    { signal },
  );
  if (result.name !== name || typeof result.content !== "string") {
    throw new Error("服务端返回了无效的 Skill 内容，请重试。");
  }
  return result.content;
}

export function filterSkills(skills: HubSkill[], query: string): HubSkill[] {
  const needle = query.trim().toLocaleLowerCase();
  return skills.filter(
    (skill) =>
      !needle ||
      skill.name.toLocaleLowerCase().includes(needle) ||
      skill.description.toLocaleLowerCase().includes(needle),
  );
}

export function configurationErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "设置更新失败，请重试。";
  const translated: Record<string, string> = {
    "provide an API key when changing the endpoint origin":
      "更换服务地址时，请同时填写该服务使用的 API Key。现有密钥不会自动发送到新的服务地址。",
    "baseUrl must be an HTTP(S) URL without credentials, query or fragment":
      "请填写 HTTP 或 HTTPS 服务地址，不要在地址中包含账号、密码、查询参数或片段。",
    "enable the owning plugin on the server first": "请先在服务器上启用这个 Skill 所属的插件。",
    "select an existing text connection": "这个模型连接已不可用，请刷新后重新选择。",
    "configuration request failed": "配置操作未完成，请刷新设置确认当前状态后重试。",
    "too many model connections": "模型连接数量已达上限，请先删除不用的连接。",
    "skill not found": "这个 Skill 已不在服务器上，请刷新列表。",
    "unknown text provider": "这个模型服务商不可用，请刷新设置后重新选择。",
    "existing connection provider cannot be changed":
      "已有连接的服务商不能直接更换，请创建新连接。",
  };
  if (translated[message]) return translated[message];
  const invalid = /^(id|catalogId|model|text|auxText|apiKey) is invalid$/.exec(message);
  if (invalid) return "配置字段无效，请检查名称、模型与密钥后重试。";
  return message;
}

export interface ModelProbeResult {
  ok: boolean;
  connectionId: string;
  model: string;
  latencyMs: number;
  checkedAt: string;
  code: string;
  message: string;
  status?: number;
}

export async function deleteConnection(
  id: string,
  replacementText?: string,
  signal?: AbortSignal,
  expectedRevision?: string,
) {
  return checkConfiguration(
    await api("/api/v1/configuration/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        ...(replacementText ? { replacementText } : {}),
        ...(expectedRevision ? { expectedRevision } : {}),
      }),
      signal,
    }),
  );
}

export async function probeConnection(id: string, signal?: AbortSignal): Promise<ModelProbeResult> {
  const requestId = browserId();
  const probeUrl = apiUrl("/api/v1/configuration/connections/probe");
  const cancelUrl = apiUrl("/api/v1/configuration/connections/probe/cancel");
  let result: ModelProbeResult;
  try {
    result = await api<ModelProbeResult>(probeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, requestId }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      // Explicit cancellation also works through proxies/runtimes that keep HTTP sockets alive.
      await api(cancelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
    }
    throw error;
  }
  if (
    !result ||
    result.connectionId !== id ||
    typeof result.ok !== "boolean" ||
    typeof result.message !== "string" ||
    typeof result.code !== "string" ||
    !Number.isFinite(result.latencyMs)
  )
    throw new Error("服务端返回了无效的测试结果，请重试。");
  return result;
}
