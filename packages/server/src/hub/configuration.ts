import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  SettingsManager,
  invalidateSkillCache,
  mergePluginMcpServers,
  scanSkills,
  userHome,
} from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists, getMergedCatalog } from "@cjhyy/code-shell-core/internal";

import { probeConfiguredModel } from "./model-probe.js";

const ROOT = "/api/v1/configuration";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 512;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type Settings = ReturnType<SettingsManager["get"]>;
type JsonObject = Record<string, unknown>;

export class HubConfigurationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HubConfigurationError";
  }
}

export interface HubConfigurationOptions {
  cwd: string;
  /** Host serializes changes against active/staged runs and refreshes its idle worker. */
  withMutation?: <T>(write: () => Promise<T>) => Promise<T>;
  /** Recheck the device after reading its request body, before writing settings. */
  isAuthorized?: (request: IncomingMessage) => Promise<boolean>;
  ownerId?: (request: IncomingMessage) => Promise<string | undefined>;
  /** Test seam; production always uses the shared Core client. */
  probe?: typeof probeConfiguredModel;
}

/** The caller must authenticate and check Origin before dispatching any request here. */
export function createHubConfiguration(options: HubConfigurationOptions) {
  const settingsManager = () => new SettingsManager(options.cwd, "full");
  let closed = false;
  const probes = new Set<AbortController>();
  const probeOwners = new Map<AbortController, string>();
  const namedProbes = new Map<string, AbortController>();
  const cancelledProbes = new Map<string, number>();
  function pruneCancelled() {
    for (const [id, expires] of cancelledProbes)
      if (expires <= Date.now()) cancelledProbes.delete(id);
    while (cancelledProbes.size > 256) cancelledProbes.delete(cancelledProbes.keys().next().value!);
  }
  const connectionRevisions = new Map<string, { signature: string; revision: string }>();

  async function authorize(req: IncomingMessage): Promise<void> {
    if (closed) throw new HubConfigurationError(503, "服务正在关闭。");
    if (options.isAuthorized && !(await options.isAuthorized(req)))
      throw new HubConfigurationError(401, "login required");
    if (closed) throw new HubConfigurationError(503, "服务正在关闭。");
  }

  async function ownerFor(req: IncomingMessage): Promise<string> {
    const owner = options.ownerId ? await options.ownerId(req) : "administrator";
    if (!owner) throw new HubConfigurationError(401, "login required");
    if (closed) throw new HubConfigurationError(503, "服务正在关闭。");
    return owner;
  }

  function abortProbe(controller: AbortController): void {
    controller.abort();
    probes.delete(controller);
    probeOwners.delete(controller);
    for (const [id, probe] of namedProbes) if (probe === controller) namedProbes.delete(id);
  }

  function revisionFor(
    connection: Settings["modelConnections"][number],
    settings: Settings,
  ): string {
    const template = getMergedCatalog().find((entry) => entry.id === connection.catalogId);
    const credential = settings.credentials.find((entry) => entry.id === connection.credentialId);
    // Only an opaque random revision leaves the server; credential hashes stay private.
    const signature = createHash("sha256")
      .update(
        JSON.stringify({
          connection,
          credential,
          template: {
            protocol: template?.protocol,
            adapterKind: template?.adapterKind,
            defaultBaseUrl: template?.defaultBaseUrl,
          },
        }),
      )
      .digest("hex");
    let revision = connectionRevisions.get(connection.id);
    if (revision?.signature !== signature) {
      revision = { signature, revision: randomUUID() };
      connectionRevisions.set(connection.id, revision);
    }
    return revision.revision;
  }

  function checkConnectionRevision(input: JsonObject, id: string, settings: Settings): void {
    if (input.expectedRevision === undefined) return;
    const existing = settings.modelConnections.find((entry) => entry.id === id);
    if (input.expectedRevision === null) {
      if (existing)
        throw new HubConfigurationError(409, "连接名称已存在，请更换名称或编辑现有连接。");
      return;
    }
    const expected = boundedString(input.expectedRevision, "expectedRevision", 64);
    if (!existing || revisionFor(existing, settings) !== expected)
      throw new HubConfigurationError(
        409,
        "这个连接已被其他设备修改或删除。请保留草稿，载入最新设置后再保存。",
      );
  }

  function snapshot() {
    const manager = settingsManager();
    const settings = manager.get();
    const connectionIds = new Set(settings.modelConnections.map((item) => item.id));
    for (const id of connectionRevisions.keys())
      if (!connectionIds.has(id)) connectionRevisions.delete(id);
    const catalog = getMergedCatalog();
    const disabled = computeEffectiveDisabledLists(manager, options.cwd);
    invalidateSkillCache();
    const allSkills = scanSkills(options.cwd);
    const enabledSkills = new Set(scanSkills(options.cwd, disabled).map((skill) => skill.name));
    const mcpServers = mergePluginMcpServers(
      settings.mcpServers,
      disabled.disabledPlugins,
      settings.mcpServerOverrides,
    );
    return {
      workspace: {
        path: options.cwd,
        settingsScope: "local" as const,
        skillDirectories: [
          join(options.cwd, ".code-shell", "skills"),
          join(options.cwd, ".agents", "skills"),
          join(userHome(), ".code-shell", "skills"),
        ],
      },
      defaults: {
        ...(settings.defaults.text ? { text: settings.defaults.text } : {}),
        ...(settings.defaults.auxText ? { auxText: settings.defaults.auxText } : {}),
      },
      connections: settings.modelConnections.map((connection) => {
        const template = catalog.find((entry) => entry.id === connection.catalogId);
        const credential = settings.credentials.find(
          (entry) => entry.id === connection.credentialId,
        );
        return {
          id: connection.id,
          revision: revisionFor(connection, settings),
          catalogId: connection.catalogId,
          tag: connection.tag,
          model: connection.model,
          baseUrl: displayUrl(
            connection.baseUrl ?? credential?.baseUrl ?? template?.defaultBaseUrl,
          ),
          hasApiKey: Boolean(credential?.apiKey),
          needsKey: template?.needsKey !== false,
        };
      }),
      catalog: catalog
        .filter((entry) => entry.tag === "text")
        .map((entry) => ({
          id: entry.id,
          displayName: entry.displayName,
          adapterKind: entry.adapterKind,
          defaultBaseUrl: displayUrl(entry.defaultBaseUrl),
          needsKey: entry.needsKey !== false,
        })),
      skills: allSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        enabled: enabledSkills.has(skill.name),
        ...(skill.source === "plugin" &&
        disabled.disabledPlugins.includes(skill.name.split(":", 1)[0]!)
          ? { disabledReason: "所属插件已停用，请先在服务端启用插件。" }
          : {}),
      })),
      mcpServers: Object.entries(mcpServers).map(([name, server]) => ({
        name,
        transport: String(server.transport ?? (server.url ? "streamable-http" : "stdio")),
        enabled: server.enabled !== false,
      })),
      restartRequired: false,
    };
  }

  function readSkill(name: unknown) {
    const selectedName = boundedString(name, "name", 256);
    invalidateSkillCache();
    // Resolve only from the same catalog the engine uses. A client never supplies a path.
    const skill = scanSkills(options.cwd).find((entry) => entry.name === selectedName);
    if (!skill) throw new HubConfigurationError(404, "skill not found");
    if (Buffer.byteLength(skill.content) > MAX_SKILL_BYTES) {
      throw new HubConfigurationError(413, "skill is too large to display");
    }
    return { name: skill.name, content: skill.content };
  }

  function updateDefaults(input: JsonObject): void {
    knownFields(input, ["text", "auxText"]);
    const text = boundedString(input.text, "text", 128);
    const auxText =
      input.auxText === undefined || input.auxText === null
        ? input.auxText
        : boundedString(input.auxText, "auxText", 128);
    const manager = settingsManager();
    manager.mutateSettingsForScope("local", options.cwd, (current) => {
      const effective = settingsManager().get();
      requireTextConnection(effective, text);
      if (auxText) requireTextConnection(effective, auxText);
      current.defaults = {
        ...objectOrEmpty(current.defaults),
        text,
        // Empty means the core background-model resolver follows the main model.
        ...(auxText !== undefined ? { auxText: auxText ?? "" } : {}),
      };
    });
  }

  function updateConnection(input: JsonObject): void {
    knownFields(input, ["id", "catalogId", "model", "baseUrl", "apiKey", "expectedRevision"]);
    const id = boundedString(input.id, "id", 128);
    const catalogId = boundedString(input.catalogId, "catalogId", 128);
    const model = boundedString(input.model, "model", 256);
    const baseUrl =
      input.baseUrl === undefined ? undefined : input.baseUrl === "" ? "" : inputUrl(input.baseUrl);
    const apiKey =
      input.apiKey === undefined ? undefined : boundedString(input.apiKey, "apiKey", 16_384);
    const template = getMergedCatalog().find(
      (entry) => entry.id === catalogId && entry.tag === "text",
    );
    if (!template) throw new HubConfigurationError(400, "unknown text provider");
    settingsManager().mutateSettingsForScope("local", options.cwd, (current) => {
      const effective = settingsManager().get();
      checkConnectionRevision(input, id, effective);
      const existing = effective.modelConnections.find((entry) => entry.id === id);
      if (existing && (existing.tag !== "text" || existing.catalogId !== catalogId)) {
        throw new HubConfigurationError(400, "existing connection provider cannot be changed");
      }
      if (!existing && effective.modelConnections.length >= MAX_CONNECTIONS) {
        throw new HubConfigurationError(400, "too many model connections");
      }
      const credentials = [...effective.credentials];
      let credentialId = existing?.credentialId;
      const existingCredential = credentials.find((entry) => entry.id === credentialId);
      const previousUrl =
        existing?.baseUrl ?? existingCredential?.baseUrl ?? template.defaultBaseUrl;
      const nextUrl = baseUrl === undefined ? previousUrl : baseUrl || template.defaultBaseUrl;
      // Editing a URL must never forward a stored key to a different endpoint implicitly.
      if (existingCredential?.apiKey && originOf(previousUrl) !== originOf(nextUrl) && !apiKey) {
        throw new HubConfigurationError(
          400,
          "provide an API key when changing the endpoint origin",
        );
      }
      if (apiKey !== undefined) {
        if (credentials.length >= 1_024) {
          throw new HubConfigurationError(400, "too many stored credentials");
        }
        // A private credential per update prevents changing keys on other connections
        // that intentionally share the previous user-level credential.
        credentialId = `hub-${randomUUID()}`;
        credentials.push({ id: credentialId, catalogId, apiKey });
        current.credentials = credentials;
      }
      const connection = {
        ...existing,
        id,
        catalogId,
        tag: "text" as const,
        model,
        ...(credentialId ? { credentialId } : {}),
        ...(baseUrl !== undefined ? { baseUrl: baseUrl || template.defaultBaseUrl } : {}),
      };
      current.modelConnections = [
        ...effective.modelConnections.filter((entry) => entry.id !== id),
        connection,
      ];
    });
  }

  function deleteConnection(input: JsonObject): void {
    knownFields(input, ["id", "replacementText", "expectedRevision"]);
    const id = boundedString(input.id, "id", 128);
    const replacement =
      input.replacementText === undefined
        ? undefined
        : boundedString(input.replacementText, "replacementText", 128);
    settingsManager().mutateSettingsForScope("local", options.cwd, (current) => {
      const effective = settingsManager().get();
      checkConnectionRevision(input, id, effective);
      requireTextConnection(effective, id);
      const remaining = effective.modelConnections.filter((item) => item.id !== id);
      const replacingDefault = effective.defaults.text === id;
      if (
        replacement &&
        (!replacingDefault ||
          replacement === id ||
          !remaining.some((item) => item.id === replacement && item.tag === "text"))
      )
        throw new HubConfigurationError(400, "请选择其他可用连接作为默认模型。");
      if (replacingDefault && remaining.some((item) => item.tag === "text") && !replacement)
        throw new HubConfigurationError(409, "请先为当前默认模型选择替代连接。");
      current.modelConnections = remaining;
      const defaults = { ...objectOrEmpty(current.defaults) };
      if (replacingDefault) defaults.text = replacement ?? "";
      if (effective.defaults.auxText === id) defaults.auxText = "";
      if (!remaining.some((item) => item.tag === "text")) {
        defaults.text = "";
        defaults.auxText = "";
      }
      current.defaults = defaults;
      // Delete only unused private keys created by this Hub, preserving shared credentials.
      const removed = effective.modelConnections.find((item) => item.id === id)!;
      if (
        removed.credentialId?.startsWith("hub-") &&
        !remaining.some((item) => item.credentialId === removed.credentialId) &&
        Array.isArray(current.credentials)
      )
        current.credentials = current.credentials.filter(
          (item: any) => item.id !== removed.credentialId,
        );
    });
  }

  function updateSkill(input: JsonObject): void {
    knownFields(input, ["name", "enabled"]);
    const name = boundedString(input.name, "name", 256);
    if (typeof input.enabled !== "boolean")
      throw new HubConfigurationError(400, "enabled must be boolean");
    const enabled = input.enabled;
    settingsManager().mutateSettingsForScope("local", options.cwd, (current) => {
      invalidateSkillCache();
      const skill = scanSkills(options.cwd).find((entry) => entry.name === name);
      if (!skill) throw new HubConfigurationError(404, "skill not found");
      const disabled = computeEffectiveDisabledLists(settingsManager(), options.cwd);
      if (
        enabled &&
        skill.source === "plugin" &&
        disabled.disabledPlugins.includes(name.split(":", 1)[0]!)
      ) {
        throw new HubConfigurationError(400, "enable the owning plugin on the server first");
      }
      const overrides = objectOrEmpty(current.capabilityOverrides);
      current.capabilityOverrides = {
        ...overrides,
        skills: { ...objectOrEmpty(overrides.skills), [name]: enabled ? "on" : "off" },
      };
    });
    invalidateSkillCache();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    try {
      if (closed) throw new HubConfigurationError(503, "服务正在关闭。");
      if (req.method === "GET" && url.pathname === ROOT) {
        json(res, 200, snapshot());
      } else if (req.method === "GET" && url.pathname === `${ROOT}/skill`) {
        json(res, 200, readSkill(url.searchParams.get("name")));
      } else if (url.pathname === `${ROOT}/connections/probe/cancel`) {
        if (req.method !== "POST") throw new HubConfigurationError(405, "method not allowed");
        const input = await readJson(req);
        knownFields(input, ["requestId"]);
        const requestId = probeRequestId(input.requestId);
        await authorize(req);
        const owner = await ownerFor(req);
        await authorize(req);
        const key = `${owner}:${requestId}`;
        cancelledProbes.set(key, Date.now() + 30_000);
        pruneCancelled();
        const probe = namedProbes.get(key);
        if (probe) abortProbe(probe);
        json(res, 200, { ok: true });
      } else if (url.pathname === `${ROOT}/connections/probe`) {
        if (req.method !== "POST") throw new HubConfigurationError(405, "method not allowed");
        const input = await readJson(req);
        knownFields(input, ["id", "requestId"]);
        const id = boundedString(input.id, "id", 128);
        const requestId =
          input.requestId === undefined ? undefined : probeRequestId(input.requestId);
        pruneCancelled();
        await authorize(req);
        const owner = await ownerFor(req);
        await authorize(req);
        const probeKey = requestId ? `${owner}:${requestId}` : undefined;
        const settings = settingsManager().get();
        requireTextConnection(settings, id);
        if (probeKey && cancelledProbes.has(probeKey)) {
          json(res, 200, {
            ok: false,
            connectionId: id,
            model: settings.modelConnections.find((item) => item.id === id)!.model,
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            code: "cancelled",
            message: "已取消连接测试。",
          });
          return true;
        }
        if (probes.size) throw new HubConfigurationError(429, "已有连接测试正在进行，请稍后重试。");
        const controller = new AbortController();
        probes.add(controller);
        probeOwners.set(controller, owner);
        if (probeKey) namedProbes.set(probeKey, controller);
        const cancel = () => controller.abort();
        res.once("close", cancel);
        req.socket.once("close", cancel);
        try {
          // Register before this final auth await, so a concurrent revoke also aborts this probe.
          await authorize(req);
          const result = await (options.probe ?? probeConfiguredModel)(settings, id, {
            signal: controller.signal,
          });
          await authorize(req);
          json(res, 200, result);
        } finally {
          res.off("close", cancel);
          req.socket.off("close", cancel);
          abortProbe(controller);
        }
      } else {
        const update =
          url.pathname === `${ROOT}/defaults`
            ? updateDefaults
            : url.pathname === `${ROOT}/connections`
              ? req.method === "DELETE"
                ? deleteConnection
                : updateConnection
              : url.pathname === `${ROOT}/skills`
                ? updateSkill
                : undefined;
        if (!update) throw new HubConfigurationError(404, "configuration endpoint not found");
        if (
          req.method !== "PUT" &&
          !(req.method === "DELETE" && url.pathname === `${ROOT}/connections`)
        )
          throw new HubConfigurationError(405, "method not allowed");
        const input = await readJson(req);
        await authorize(req);
        const write = async () => {
          await authorize(req);
          update(input);
          return snapshot();
        };
        const result = options.withMutation ? await options.withMutation(write) : await write();
        await authorize(req);
        json(res, 200, result);
      }
    } catch (error) {
      if (error instanceof HubConfigurationError) json(res, error.status, { error: error.message });
      else json(res, 500, { error: "configuration request failed" });
    }
    return true;
  }

  return {
    handle,
    snapshot,
    cancelOwner: (owner: string) => {
      for (const [probe, id] of probeOwners) if (id === owner) abortProbe(probe);
    },
    close: () => {
      closed = true;
      for (const probe of probes) abortProbe(probe);
      cancelledProbes.clear();
      connectionRevisions.clear();
    },
  };
}

export type HubConfigurationSnapshot = ReturnType<
  ReturnType<typeof createHubConfiguration>["snapshot"]
>;

function probeRequestId(value: unknown): string {
  const id = boundedString(value, "requestId", 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))
    throw new HubConfigurationError(400, "invalid probe request ID");
  return id;
}

function requireTextConnection(settings: Settings, id: string): void {
  if (
    !settings.modelConnections.some(
      (connection) => connection.id === id && connection.tag === "text",
    )
  ) {
    throw new HubConfigurationError(400, "select an existing text connection");
  }
}

function objectOrEmpty(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function boundedString(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value) ||
    FORBIDDEN_KEYS.has(value)
  ) {
    throw new HubConfigurationError(400, `${label} is invalid`);
  }
  return value;
}

function knownFields(input: JsonObject, fields: string[]): void {
  if (Object.keys(input).some((key) => !fields.includes(key))) {
    throw new HubConfigurationError(400, "unsupported configuration field");
  }
}

function inputUrl(value: unknown): string {
  const raw = boundedString(value, "baseUrl", 4_096);
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return raw;
  } catch {
    throw new HubConfigurationError(
      400,
      "baseUrl must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
}

function displayUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HubConfigurationError(415, "application/json required");
  }
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES)
    throw new HubConfigurationError(413, "request body is too large");
  let bytes = 0;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => req.destroy(), 10_000);
  timer.unref();
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) throw new HubConfigurationError(413, "request body is too large");
      chunks.push(buffer);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as JsonObject;
  } catch {
    throw new HubConfigurationError(400, "JSON object required");
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
