import type { IncomingMessage, ServerResponse } from "node:http";
import { SettingsManager, mergePluginMcpServers } from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import { probeHubMcp, type HubMcpProbeResult } from "./mcp-probe.js";

const ROOT = "/api/v1/mcp";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SERVERS = 256;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
type ObjectMap = Record<string, unknown>;
type Scope = "local" | "project" | "user" | "managed";

export class HubMcpConfigurationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HubMcpConfigurationOptions {
  cwd: string;
  isAuthorized?: (request: IncomingMessage) => Promise<boolean>;
  ownerId?: (request: IncomingMessage) => Promise<string | undefined>;
  withMutation?: <T>(write: () => Promise<T>) => Promise<T>;
  probeTimeoutMs?: number;
}

export interface HubMcpServerView {
  name: string;
  source: "settings" | "plugin";
  scope: Scope | "plugin";
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

export interface HubMcpSnapshot {
  workspacePath: string;
  servers: HubMcpServerView[];
  removed: { name: string; scope: Scope }[];
}

function object(value: unknown): ObjectMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectMap) : {};
}

function knownFields(value: ObjectMap, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => FORBIDDEN.has(key) || !allowed.includes(key))) {
    throw new HubMcpConfigurationError(400, "请求包含不支持的配置字段。");
  }
}

function text(value: unknown, field: string, maximum = 4096, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value.trim()) ||
    value.includes("\0")
  ) {
    throw new HubMcpConfigurationError(400, `${field} 格式无效或内容过长。`);
  }
  return value;
}

function serverName(value: unknown): string {
  const name = text(value, "服务名称", 128).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name) || FORBIDDEN.has(name)) {
    throw new HubMcpConfigurationError(
      400,
      "服务名称只能使用字母、数字、点、下划线、短横线和冒号。",
    );
  }
  return name;
}

function stringList(value: unknown, field: string, maximum = 128): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new HubMcpConfigurationError(400, `${field} 必须是数量有限的文本列表。`);
  return value.map((entry) => text(entry, field, 4096, true));
}

function keyName(value: string, kind: "env" | "headers" | "envHeaders"): string {
  const pattern = kind === "env" ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  if (FORBIDDEN.has(value) || value.length > 128 || !pattern.test(value)) {
    throw new HubMcpConfigurationError(
      400,
      kind === "env" ? "环境变量名称无效。" : "请求头名称无效。",
    );
  }
  return value;
}

function secretPatch(
  value: unknown,
  kind: "env" | "headers" | "envHeaders",
): Record<string, string | null> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 128
  ) {
    throw new HubMcpConfigurationError(400, "环境变量或请求头必须是数量有限的键值配置。");
  }
  const result: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = keyName(rawKey, kind);
    const canonical = kind === "env" ? key : key.toLowerCase();
    if (seen.has(canonical))
      throw new HubMcpConfigurationError(400, "请求头名称不能重复（不区分大小写）。");
    seen.add(canonical);
    if (rawValue === null) result[key] = null;
    else {
      const item = text(rawValue, "配置值", 16_384, true);
      if (kind !== "env" && /[\r\n]/.test(item))
        throw new HubMcpConfigurationError(400, "请求头不能包含换行。");
      if (kind === "envHeaders" && item) keyName(item, "env");
      result[key] = item;
    }
  }
  return result;
}

function safeUrl(raw: string | undefined): { url?: string; urlHasHiddenParts?: boolean } {
  if (!raw) return {};
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return {};
    const hidden = !!(url.username || url.password || url.search || url.hash);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return { url: url.toString(), ...(hidden ? { urlHasHiddenParts: true } : {}) };
  } catch {
    return {};
  }
}

function inputUrl(value: unknown): string {
  const raw = text(value, "服务地址");
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error();
    return raw;
  } catch {
    throw new HubMcpConfigurationError(
      400,
      "请填写 HTTP 或 HTTPS 地址，不要在地址中包含账号、密码或片段。",
    );
  }
}

function origin(value: string | undefined): string {
  try {
    return value ? new URL(value).origin : "";
  } catch {
    return "";
  }
}

function mergePatch(
  existing: Record<string, string> | undefined,
  patch: Record<string, string | null> | undefined,
  kind: "env" | "headers" | "envHeaders",
  local: ObjectMap,
): Record<string, string | null> {
  const result = { ...local } as Record<string, string | null>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === "") continue; // Blank fields preserve stored values; null is an explicit removal.
    if (kind !== "env") {
      for (const old of new Set([...Object.keys(existing ?? {}), ...Object.keys(result)])) {
        if (old !== key && old.toLowerCase() === key.toLowerCase()) result[old] = null;
      }
    }
    result[key] = value;
  }
  return result;
}

/** Authenticated administrator surface. The host checks its standard Origin policy before dispatch. */
export function createHubMcpConfiguration(options: HubMcpConfigurationOptions) {
  const manager = () => new SettingsManager(options.cwd, "full");
  let closed = false;
  const probes = new Map<
    string,
    {
      owner: string;
      name: string;
      controller: AbortController;
      promise: Promise<HubMcpProbeResult>;
    }
  >();
  let probeCounter = 0;

  function state() {
    const settings = manager();
    const effective = settings.get();
    const scopes = {
      local: settings.getForScope("local", options.cwd),
      project: settings.getForScope("project", options.cwd),
      user: settings.getForScope("user"),
    };
    const disabled = computeEffectiveDisabledLists(settings, options.cwd);
    const merged = mergePluginMcpServers(effective.mcpServers, [], effective.mcpServerOverrides);
    const sourceScope = (name: string): Scope => {
      for (const scope of ["local", "project", "user"] as const) {
        if (Object.hasOwn(scopes[scope].mcpServers ?? {}, name)) return scope;
      }
      return "managed";
    };
    return { settings, effective, scopes, disabled, merged, sourceScope };
  }

  function snapshot(): HubMcpSnapshot {
    const current = state();
    const rawLocal = current.settings.getRawForScope("local", options.cwd);
    return {
      workspacePath: options.cwd,
      servers: Object.entries(current.merged)
        .slice(0, MAX_SERVERS)
        .map(([name, config]) => {
          const fromSettings = Object.hasOwn(current.effective.mcpServers, name);
          const pluginDisabled =
            !fromSettings && current.disabled.disabledPlugins.includes(name.split(":", 1)[0]!);
          const transport = config.transport ?? (config.url ? "streamable-http" : "stdio");
          return {
            name,
            source: fromSettings ? "settings" : "plugin",
            scope: fromSettings ? current.sourceScope(name) : "plugin",
            editable: fromSettings && transport !== "inprocess",
            deletable: fromSettings,
            hasLocalOverride: Object.hasOwn(
              fromSettings
                ? (current.scopes.local.mcpServers ?? {})
                : (current.scopes.local.mcpServerOverrides ?? {}),
              name,
            ),
            pluginDisabled,
            enabled: config.enabled !== false && !pluginDisabled,
            transport,
            ...(config.command ? { command: config.command.slice(0, 4096) } : {}),
            argsCount: config.args?.length ?? 0,
            ...safeUrl(config.url),
            envKeys: Object.keys(config.env ?? {}),
            headerKeys: Object.keys(config.headers ?? {}),
            envVars: config.envVars ?? [],
            ...(config.bearerTokenEnvVar ? { bearerTokenEnvVar: config.bearerTokenEnvVar } : {}),
            envHeaders: config.envHeaders ?? {},
            ...(config.credentialRef ? { credentialRef: config.credentialRef } : {}),
            ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
            disabledTools: config.disabledTools ?? [],
          };
        }),
      removed: Object.entries(object(rawLocal.mcpServers))
        .filter(([, value]) => value === null)
        .map(([name]) => ({
          name,
          scope: Object.hasOwn(current.scopes.project.mcpServers ?? {}, name)
            ? "project"
            : Object.hasOwn(current.scopes.user.mcpServers ?? {}, name)
              ? "user"
              : "managed",
        })),
    };
  }

  function cancelServer(name: string): void {
    for (const entry of probes.values()) if (entry.name === name) entry.controller.abort();
  }

  function writeServer(name: string, input: ObjectMap, create: boolean): void {
    knownFields(input, [
      "name",
      "transport",
      "command",
      "args",
      "url",
      "env",
      "headers",
      "envVars",
      "envHeaders",
      "bearerTokenEnvVar",
      "credentialRef",
      "enabled",
      "allowedTools",
      "disabledTools",
      "reuseStoredSecrets",
    ]);
    if (input.name !== undefined && serverName(input.name) !== name)
      throw new HubMcpConfigurationError(400, "编辑服务时不能更换名称，请创建新服务。");
    manager().mutateSettingsForScope("local", options.cwd, (layer) => {
      const current = state();
      const existing = current.merged[name];
      if (create && existing)
        throw new HubMcpConfigurationError(409, "这个服务名称已存在，请使用其他名称。");
      if (!create && !existing)
        throw new HubMcpConfigurationError(404, "服务已不存在，请刷新列表。");
      if (existing && !Object.hasOwn(current.effective.mcpServers, name))
        throw new HubMcpConfigurationError(
          400,
          "插件提供的连接由插件管理，不能修改启动命令或地址。",
        );
      if (create && Object.keys(current.merged).length >= MAX_SERVERS)
        throw new HubMcpConfigurationError(400, "MCP 服务数量已达上限。");
      const mode =
        input.transport ?? existing?.transport ?? (existing?.url ? "streamable-http" : "stdio");
      if (mode !== "stdio" && mode !== "streamable-http" && mode !== "sse")
        throw new HubMcpConfigurationError(400, "请选择本地命令或 HTTP 连接。");
      const local = object(object(layer.mcpServers)[name]);
      const config: ObjectMap = { ...local };
      if (create || input.transport !== undefined) config.transport = mode;
      if (input.command !== undefined)
        config.command = text(input.command, "启动命令", 4096).trim();
      if (input.args !== undefined) config.args = stringList(input.args, "命令参数", 64);
      if (input.url !== undefined) config.url = inputUrl(input.url);
      if (mode === "stdio" && !(config.command ?? existing?.command))
        throw new HubMcpConfigurationError(400, "本地命令连接需要填写启动命令。");
      if (mode !== "stdio" && !(config.url ?? existing?.url))
        throw new HubMcpConfigurationError(400, "HTTP 连接需要填写服务地址。");
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== "boolean")
          throw new HubMcpConfigurationError(400, "启用状态必须是布尔值。");
        config.enabled = input.enabled;
      }
      for (const field of ["env", "headers", "envHeaders"] as const) {
        if (input[field] !== undefined)
          config[field] = mergePatch(
            existing?.[field],
            secretPatch(input[field], field),
            field,
            object(local[field]),
          );
      }
      for (const field of ["envVars", "allowedTools", "disabledTools"] as const) {
        if (input[field] !== undefined) {
          config[field] =
            input[field] === null && field === "allowedTools"
              ? null
              : stringList(input[field], field);
          if (field === "envVars")
            for (const name of config[field] as string[]) keyName(name, "env");
        }
      }
      for (const field of ["credentialRef", "bearerTokenEnvVar"] as const) {
        if (input[field] !== undefined) {
          config[field] =
            input[field] === null || input[field] === "" ? null : text(input[field], field, 128);
          if (field === "bearerTokenEnvVar" && config[field])
            keyName(config[field] as string, "env");
        }
      }
      if (existing) {
        const oldMode = existing.transport ?? (existing.url ? "streamable-http" : "stdio");
        const identityChanged =
          mode !== oldMode ||
          (mode === "stdio"
            ? (config.command ?? existing.command) !== existing.command ||
              (input.args !== undefined &&
                JSON.stringify(input.args) !== JSON.stringify(existing.args ?? []))
            : origin((config.url ?? existing.url) as string) !== origin(existing.url));
        const sensitive = !!(
          Object.keys(existing.env ?? {}).length ||
          Object.keys(existing.headers ?? {}).length ||
          existing.envVars?.length ||
          Object.keys(existing.envHeaders ?? {}).length ||
          existing.credentialRef ||
          existing.bearerTokenEnvVar ||
          existing.args?.length
        );
        if (identityChanged && sensitive && input.reuseStoredSecrets !== true) {
          throw new HubMcpConfigurationError(
            400,
            "启动方式或服务域名已改变，请明确确认新连接可以使用已保存的环境变量和认证配置。",
          );
        }
      }
      cancelServer(name);
      layer.mcpServers = { ...object(layer.mcpServers), [name]: config };
    });
  }

  function toggle(name: string, input: ObjectMap): void {
    knownFields(input, ["enabled"]);
    if (typeof input.enabled !== "boolean")
      throw new HubMcpConfigurationError(400, "启用状态必须是布尔值。");
    manager().mutateSettingsForScope("local", options.cwd, (layer) => {
      const current = state();
      if (!current.merged[name])
        throw new HubMcpConfigurationError(404, "服务已不存在，请刷新列表。");
      const plugin = !Object.hasOwn(current.effective.mcpServers, name);
      if (
        plugin &&
        current.disabled.disabledPlugins.includes(name.split(":", 1)[0]!) &&
        input.enabled
      )
        throw new HubMcpConfigurationError(400, "请先启用所属插件，再启用这个工具服务。");
      cancelServer(name);
      const field = plugin ? "mcpServerOverrides" : "mcpServers";
      layer[field] = {
        ...object(layer[field]),
        [name]: { ...object(object(layer[field])[name]), enabled: input.enabled },
      };
    });
  }

  function remove(name: string, inherit: boolean): void {
    manager().mutateSettingsForScope("local", options.cwd, (layer) => {
      const current = state();
      const fromSettings = Object.hasOwn(current.effective.mcpServers, name);
      if (!inherit && !fromSettings)
        throw new HubMcpConfigurationError(
          400,
          "插件提供的服务不能删除，请停用该服务或移除所属插件。",
        );
      cancelServer(name);
      const field = fromSettings || !current.merged[name] ? "mcpServers" : "mcpServerOverrides";
      const entries = { ...object(layer[field]) };
      if (inherit) delete entries[name];
      else if (
        Object.hasOwn(current.scopes.project.mcpServers ?? {}, name) ||
        Object.hasOwn(current.scopes.user.mcpServers ?? {}, name) ||
        current.sourceScope(name) === "managed"
      )
        entries[name] = null;
      else delete entries[name];
      layer[field] = entries;
      // Removing a user-owned collision must not unexpectedly activate the plugin fallback.
      if (!inherit && mergePluginMcpServers({}, [], {})[name]) {
        layer.mcpServerOverrides = {
          ...object(layer.mcpServerOverrides),
          [name]: { ...object(object(layer.mcpServerOverrides)[name]), enabled: false },
        };
      }
    });
  }

  async function authorize(req: IncomingMessage): Promise<void> {
    if (closed) throw new HubMcpConfigurationError(503, "服务正在关闭。");
    if (options.isAuthorized && !(await options.isAuthorized(req)))
      throw new HubMcpConfigurationError(401, "登录已失效，请重新登录。");
    if (closed) throw new HubMcpConfigurationError(503, "服务正在关闭。");
  }

  async function probe(
    name: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<HubMcpProbeResult> {
    const current = state();
    const config = current.merged[name];
    if (!config) throw new HubMcpConfigurationError(404, "服务已不存在，请刷新列表。");
    if (
      !Object.hasOwn(current.effective.mcpServers, name) &&
      current.disabled.disabledPlugins.includes(name.split(":", 1)[0]!)
    )
      throw new HubMcpConfigurationError(400, "所属插件已停用，请先启用插件再测试连接。");
    const owner = options.ownerId
      ? await options.ownerId(req)
      : (req.socket.remoteAddress ?? "administrator");
    if (!owner) throw new HubMcpConfigurationError(401, "登录已失效，请重新登录。");
    if (closed) throw new HubMcpConfigurationError(503, "服务正在关闭。");
    if (probes.size >= 4 || [...probes.values()].some((entry) => entry.owner === owner))
      throw new HubMcpConfigurationError(429, "已有连接测试正在运行，请等待它完成或取消后重试。");
    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", disconnected);
    res.once("close", disconnected);
    req.socket.once("close", disconnected);
    const key = String(++probeCounter);
    const promise = (async () => {
      // Ownership can be revoked while it is being resolved; register before the final check.
      await authorize(req);
      if (controller.signal.aborted) throw new HubMcpConfigurationError(409, "已取消连接测试。");
      return probeHubMcp(
        { ...config, name },
        { cwd: options.cwd, signal: controller.signal, timeoutMs: options.probeTimeoutMs },
      );
    })();
    probes.set(key, { owner, name, controller, promise });
    try {
      return await promise;
    } finally {
      probes.delete(key);
      req.off("aborted", disconnected);
      res.off("close", disconnected);
      req.socket.off("close", disconnected);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    try {
      if (closed) throw new HubMcpConfigurationError(503, "服务正在关闭。");
      if (req.method === "GET" && url.pathname === ROOT) {
        json(res, 200, snapshot());
        return true;
      }
      const match =
        /^\/api\/v1\/mcp\/servers(?:\/([^/]+))?(?:\/(enabled|probe|cancel-probe|inherit))?$/.exec(
          url.pathname,
        );
      if (!match) throw new HubMcpConfigurationError(404, "没有这个 MCP 配置接口。");
      let name: string | undefined;
      try {
        name = match[1] ? serverName(decodeURIComponent(match[1])) : undefined;
      } catch (error) {
        if (error instanceof HubMcpConfigurationError) throw error;
        throw new HubMcpConfigurationError(400, "服务名称无效。");
      }
      const action = match[2];
      const allowed = !name
        ? req.method === "POST"
        : action === "probe" || action === "cancel-probe" || action === "inherit"
          ? req.method === "POST"
          : action === "enabled"
            ? req.method === "PUT"
            : req.method === "PUT" || req.method === "DELETE";
      if (!allowed) throw new HubMcpConfigurationError(405, "这个 MCP 配置接口不支持此请求方式。");
      const input = req.method === "DELETE" ? {} : await readJson(req);
      await authorize(req);
      if (action === "cancel-probe" && name) {
        knownFields(input, []);
        const owner = options.ownerId
          ? await options.ownerId(req)
          : (req.socket.remoteAddress ?? "administrator");
        if (!owner) throw new HubMcpConfigurationError(401, "登录已失效，请重新登录。");
        await authorize(req);
        let cancelled = false;
        for (const entry of probes.values())
          if (entry.name === name && entry.owner === owner) {
            entry.controller.abort();
            cancelled = true;
          }
        json(res, 200, { cancelled });
      } else if (action === "probe" && name) {
        knownFields(input, []);
        const result = await probe(name, req, res);
        await authorize(req);
        json(res, 200, result);
      } else {
        const write = async () => {
          await authorize(req);
          if (!name) writeServer(serverName(input.name), input, true);
          else if (action === "enabled") toggle(name, input);
          else if (action === "inherit") {
            knownFields(input, []);
            remove(name, true);
          } else if (req.method === "DELETE") remove(name, false);
          else writeServer(name, input, false);
          return snapshot();
        };
        const value = options.withMutation ? await options.withMutation(write) : await write();
        await authorize(req);
        json(res, 200, value);
      }
    } catch (cause) {
      const status =
        cause instanceof HubMcpConfigurationError
          ? cause.status
          : typeof (cause as { status?: unknown })?.status === "number"
            ? (cause as { status: number }).status
            : 500;
      const message =
        cause instanceof HubMcpConfigurationError || [401, 409, 503].includes(status)
          ? cause instanceof Error
            ? cause.message
            : "请求失败，请重试。"
          : "无法更新 MCP 配置，请检查服务器上的配置文件后重试。";
      json(res, status, { error: message });
    }
    return true;
  }

  return {
    handle,
    cancelOwner(owner: string): void {
      for (const entry of probes.values()) if (entry.owner === owner) entry.controller.abort();
    },
    async close(): Promise<void> {
      closed = true;
      for (const entry of probes.values()) entry.controller.abort();
      await Promise.allSettled([...probes.values()].map((entry) => entry.promise));
    },
  };
}

async function readJson(req: IncomingMessage): Promise<ObjectMap> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new HubMcpConfigurationError(415, "请求必须使用 JSON 格式。");
  const declared = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES)
    throw new HubMcpConfigurationError(413, "配置内容过大。");
  let bytes = 0;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => req.destroy(), 10_000);
  timer.unref();
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) throw new HubMcpConfigurationError(413, "配置内容过大。");
      chunks.push(buffer);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new HubMcpConfigurationError(400, "配置内容不是有效的 JSON 对象。");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
