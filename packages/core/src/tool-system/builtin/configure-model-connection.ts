/**
 * ConfigureModelConnection — safely materialize one catalog model into the
 * unified settings.modelConnections store without exposing or copying API
 * keys. The write is schema-validated, lock-protected, atomic, and updates the
 * selected tag default in the same transaction when requested.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { SettingsManager } from "../../settings/manager.js";
import { getMergedCatalog, type CatalogEntry } from "../../model-catalog/index.js";
import { modelEntriesFromConnections } from "../../engine/model-connections-pool.js";
import { ModelPool } from "../../llm/model-pool.js";
import { createLLMClient } from "../../llm/client-factory.js";
import {
  isCredentialCompatible,
  type Credential,
  type ModelInstance,
} from "../../model-catalog/resolve.js";
import type { ModelPreset, ParamSpec } from "../../model-catalog/types.js";
import { notifySettingsChanged } from "./settings-changed.js";

type ConnectionScope = "user" | "project";

interface ConfigureModelConnectionDeps {
  makeSettingsManager(cwd: string, scope: "full" | "project"): SettingsManager;
  getCatalog(): CatalogEntry[];
  notifySettingsChanged(): void;
  testTextConnection(
    connection: ModelInstance,
    credentials: Credential[],
    catalog: CatalogEntry[],
  ): Promise<ConnectionTestResult>;
}

interface ConnectionTestResult {
  ok: boolean;
  response?: string;
  stopReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

function redactCredentialSecrets(message: string, credentials: Credential[]): string {
  let redacted = message;
  for (const credential of credentials) {
    if (credential.apiKey) redacted = redacted.replaceAll(credential.apiKey, "[REDACTED]");
  }
  return redacted;
}

export async function probeTextModelConnection(
  connection: ModelInstance,
  credentials: Credential[],
  catalog: CatalogEntry[],
  options: {
    fetch?: typeof globalThis.fetch;
    createClient?: typeof createLLMClient;
  } = {},
): Promise<ConnectionTestResult> {
  const entry = modelEntriesFromConnections([connection], credentials, catalog)[0];
  if (!entry) return { ok: false, error: "the saved connection could not be resolved" };
  const pool = new ModelPool([entry]);
  const config = pool.toLLMConfig(entry);
  try {
    const client = await (options.createClient ?? createLLMClient)(config, {
      temperature: 0,
      timeout: 30_000,
      retryMaxAttempts: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const response = await client.createMessage({
      systemPrompt: "You are a connection health check. Follow the user's reply instruction.",
      messages: [{ role: "user", content: "Reply with READY only." }],
      tools: [],
      maxTokens: 32,
      stream: false,
      signal: AbortSignal.timeout(30_000),
      requestVisible: false,
    });
    return {
      ok: true,
      response: response.text.slice(0, 200),
      stopReason: response.stopReason,
      ...(response.usage
        ? {
            usage: {
              promptTokens: response.usage.promptTokens,
              completionTokens: response.usage.completionTokens,
              totalTokens: response.usage.totalTokens,
            },
          }
        : {}),
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const safeError = redactCredentialSecrets(raw, credentials);
    return { ok: false, error: safeError.slice(0, 1000) };
  }
}

const DEFAULT_DEPS: ConfigureModelConnectionDeps = {
  makeSettingsManager: (cwd, scope) => new SettingsManager(cwd, scope),
  getCatalog: getMergedCatalog,
  notifySettingsChanged,
  testTextConnection: probeTextModelConnection,
};

export const configureModelConnectionToolDef: ToolDefinition = {
  name: "ConfigureModelConnection",
  description:
    "Create or update a configured model connection from an existing catalog model. " +
    "Use this after EditModelCatalog when the user wants the model ready to use, not merely " +
    "listed as a template. It validates the catalog model, reuses a compatible existing " +
    "credential by id (never returns or copies its API key), seeds catalog parameter defaults, " +
    "and atomically updates modelConnections plus defaults. User scope requires a full/trusted " +
    "host context. If more than one compatible credential exists, pass credentialId explicitly. " +
    "Set testConnection=true to make one small real request and report whether routing worked.",
  inputSchema: {
    type: "object",
    properties: {
      catalogId: {
        type: "string",
        description: "Existing merged catalog provider id, e.g. 'openrouter'.",
      },
      model: {
        type: "string",
        description: "Exact model preset value in that provider, e.g. 'openai/gpt-5.6-luna'.",
      },
      connectionId: {
        type: "string",
        description:
          "Optional stable instance id. Omit to update an existing connection for the same " +
          "catalog model or generate a collision-free id.",
      },
      credentialId: {
        type: "string",
        description:
          "Existing compatible credential id. Omit to reuse the current connection credential " +
          "or auto-select when exactly one compatible credential exists.",
      },
      paramValues: {
        type: "object",
        description:
          "Optional model parameter overrides keyed by catalog ParamSpec name. Catalog defaults " +
          "are seeded first; unknown names or invalid enum/type/range values are rejected.",
      },
      setDefault: {
        type: "boolean",
        description:
          "Set this connection as the default for its catalog tag. The first configured " +
          "connection for a tag becomes default automatically.",
      },
      testConnection: {
        type: "boolean",
        description:
          "After saving a text connection, send one small real request through it. This may " +
          "incur a tiny provider charge. A failed test is reported without rolling back the " +
          "validated connection.",
      },
      scope: {
        type: "string",
        enum: ["user", "project"],
        description:
          "Settings layer to update. Defaults to user in a full desktop host, otherwise project.",
      },
    },
    required: ["catalogId", "model"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function connectionIdIsSafe(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function slugPart(value: string): string {
  return (
    value
      .toLowerCase()
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "model"
  );
}

function uniqueConnectionId(entry: CatalogEntry, model: string, taken: Set<string>): string {
  const base = !taken.has(entry.id) ? entry.id : `${entry.id}-${slugPart(model)}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function paramDefaults(preset: ModelPreset): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const spec of preset.params ?? []) {
    if (spec.default !== undefined) values[spec.name] = spec.default;
  }
  return values;
}

function validateParamValue(spec: ParamSpec, value: unknown): string | undefined {
  if (spec.control === "enum") {
    if (typeof value !== "string") return "must be a string enum value";
    if (spec.options?.length && !spec.options.includes(value)) {
      return `must be one of [${spec.options.join(", ")}]`;
    }
    return undefined;
  }
  if (spec.control === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "must be a finite number";
    if (spec.min !== undefined && value < spec.min) return `must be >= ${spec.min}`;
    if (spec.max !== undefined && value > spec.max) return `must be <= ${spec.max}`;
    return undefined;
  }
  if (spec.control === "toggle") {
    return typeof value === "boolean" ? undefined : "must be a boolean";
  }
  return typeof value === "string" ? undefined : "must be a string";
}

function validateParamValues(
  values: Record<string, unknown>,
  specs: ParamSpec[],
): string | undefined {
  if (Object.keys(values).length > 64) return "paramValues exceeds 64 entries";
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  for (const [name, value] of Object.entries(values)) {
    const spec = byName.get(name);
    if (!spec) return `unknown parameter "${name}" for this model`;
    const issue = validateParamValue(spec, value);
    if (issue) return `parameter "${name}" ${issue}`;
  }
  return undefined;
}

function connectionsFrom(settings: Record<string, unknown>): ModelInstance[] {
  return Array.isArray(settings.modelConnections)
    ? (settings.modelConnections as ModelInstance[])
    : [];
}

function credentialsFrom(settings: Record<string, unknown>): Credential[] {
  return Array.isArray(settings.credentials) ? (settings.credentials as Credential[]) : [];
}

function findTargetConnection(
  connections: ModelInstance[],
  entry: CatalogEntry,
  model: string,
  explicitId?: string,
): ModelInstance | undefined {
  if (explicitId) return connections.find((connection) => connection.id === explicitId);
  return connections.find(
    (connection) =>
      connection.catalogId === entry.id &&
      connection.tag === entry.tag &&
      connection.model === model,
  );
}

function selectCredential(
  entry: CatalogEntry,
  catalog: CatalogEntry[],
  credentials: Credential[],
  requestedId: string | undefined,
  existingId: string | undefined,
): { credentialId?: string; error?: string } {
  const compatible = credentials.filter(
    (credential) =>
      isCredentialCompatible(entry, credential, catalog) &&
      (entry.needsKey === false || Boolean(credential.apiKey?.trim())),
  );

  const selectedId = requestedId ?? existingId;
  if (selectedId) {
    const selected = credentials.find((credential) => credential.id === selectedId);
    if (!selected) return { error: `credential "${selectedId}" does not exist in this scope` };
    if (!isCredentialCompatible(entry, selected, catalog)) {
      return { error: `credential "${selectedId}" is not compatible with catalog "${entry.id}"` };
    }
    if (entry.needsKey !== false && !selected.apiKey?.trim()) {
      return { error: `credential "${selectedId}" has no usable API key` };
    }
    return { credentialId: selected.id };
  }

  if (entry.needsKey === false) return {};
  if (compatible.length === 1) return { credentialId: compatible[0]!.id };
  if (compatible.length === 0) {
    return { error: `no compatible credential is configured for catalog "${entry.id}"` };
  }
  return {
    error:
      `multiple compatible credentials exist for catalog "${entry.id}": ` +
      `${compatible.map((credential) => credential.id).join(", ")}. Pass credentialId explicitly.`,
  };
}

export async function configureModelConnectionTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
  deps: ConfigureModelConnectionDeps = DEFAULT_DEPS,
): Promise<string> {
  if (!ctx) return "Error: ConfigureModelConnection requires a scoped tool context.";
  if (ctx.settingsScope === "isolated") {
    return "Error: isolated sessions cannot persist model connections.";
  }

  const requestedScope = args.scope;
  const scope: ConnectionScope =
    requestedScope === "user" || requestedScope === "project"
      ? requestedScope
      : ctx.settingsScope === "full"
        ? "user"
        : "project";
  if (scope === "user" && ctx.settingsScope !== "full") {
    return "Error: user-scope model connections require settingsScope=full.";
  }

  const catalogId = typeof args.catalogId === "string" ? args.catalogId.trim() : "";
  const model = typeof args.model === "string" ? args.model.trim() : "";
  const connectionId = typeof args.connectionId === "string" ? args.connectionId.trim() : undefined;
  const credentialId = typeof args.credentialId === "string" ? args.credentialId.trim() : undefined;
  if (!catalogId) return "Error: catalogId is required.";
  if (!model) return "Error: model is required.";
  if (connectionId && !connectionIdIsSafe(connectionId)) {
    return "Error: connectionId must be 1-128 safe id characters (letters, numbers, . _ : -).";
  }
  if (args.paramValues !== undefined && !isRecord(args.paramValues)) {
    return "Error: paramValues must be an object.";
  }
  if (args.setDefault !== undefined && typeof args.setDefault !== "boolean") {
    return "Error: setDefault must be a boolean.";
  }
  if (args.testConnection !== undefined && typeof args.testConnection !== "boolean") {
    return "Error: testConnection must be a boolean.";
  }

  const catalog = deps.getCatalog();
  const entry = catalog.find((candidate) => candidate.id === catalogId);
  if (!entry) return `Error: catalog "${catalogId}" does not exist.`;
  const preset = entry.modelPresets?.find((candidate) => candidate.value === model);
  if (!preset) {
    return `Error: model "${model}" is not declared in catalog "${catalogId}".`;
  }
  if (args.testConnection === true && entry.tag !== "text") {
    return "Error: testConnection currently supports text catalog entries only.";
  }

  const manager = deps.makeSettingsManager(
    ctx.cwd,
    ctx.settingsScope === "full" ? "full" : "project",
  );
  let effectiveSettings: Record<string, unknown>;
  let targetSettings: Record<string, unknown>;
  try {
    effectiveSettings = manager.get() as unknown as Record<string, unknown>;
    targetSettings = manager.getForScope(scope, ctx.cwd) as Record<string, unknown>;
  } catch (error) {
    return `Error: settings validation failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const targetConnections = connectionsFrom(targetSettings);
  const preflightExisting = findTargetConnection(targetConnections, entry, model, connectionId);
  if (
    connectionId &&
    preflightExisting &&
    (preflightExisting.catalogId !== entry.id || preflightExisting.tag !== entry.tag)
  ) {
    return `Error: connectionId "${connectionId}" already belongs to another catalog or tag.`;
  }

  const effectiveCredentials =
    scope === "user" ? credentialsFrom(targetSettings) : credentialsFrom(effectiveSettings);
  const selected = selectCredential(
    entry,
    catalog,
    effectiveCredentials,
    credentialId,
    preflightExisting?.credentialId,
  );
  if (selected.error) return `Error: ${selected.error}`;

  const providedParams = args.paramValues as Record<string, unknown> | undefined;
  let outcome:
    | {
        action: "added" | "updated";
        connection: ModelInstance;
        becameDefault: boolean;
      }
    | undefined;

  try {
    manager.mutateSettingsForScope(scope, ctx.cwd, (current) => {
      const connections = connectionsFrom(current);
      const existing = findTargetConnection(connections, entry, model, connectionId);
      if (
        connectionId &&
        existing &&
        (existing.catalogId !== entry.id || existing.tag !== entry.tag)
      ) {
        throw new Error(`connectionId "${connectionId}" was concurrently claimed`);
      }

      // Revalidate user-scope credential references inside the same locked
      // file transaction so a concurrent credential deletion cannot leave a
      // newly written dangling reference. Project connections may intentionally
      // inherit a user credential from the effective settings layer.
      if (scope === "user" && selected.credentialId) {
        const lockedSelection = selectCredential(
          entry,
          catalog,
          credentialsFrom(current),
          selected.credentialId,
          undefined,
        );
        if (lockedSelection.error) throw new Error(lockedSelection.error);
      }

      const id =
        existing?.id ??
        connectionId ??
        uniqueConnectionId(entry, model, new Set(connections.map((connection) => connection.id)));
      const defaults = paramDefaults(preset);
      const keepExistingParams = existing?.model === model && providedParams === undefined;
      const paramValues = keepExistingParams
        ? (existing?.paramValues ?? defaults)
        : { ...defaults, ...(providedParams ?? {}) };
      const paramIssue = validateParamValues(paramValues, preset.params ?? []);
      if (paramIssue) throw new Error(paramIssue);

      const connection: ModelInstance = {
        ...(existing ?? {}),
        id,
        catalogId: entry.id,
        tag: entry.tag,
        model,
        ...(selected.credentialId ? { credentialId: selected.credentialId } : {}),
        ...(Object.keys(paramValues).length > 0 ? { paramValues } : {}),
      };
      if (!selected.credentialId) delete connection.credentialId;
      if (Object.keys(paramValues).length === 0) delete connection.paramValues;

      const nextConnections = existing
        ? connections.map((candidate) => (candidate.id === existing.id ? connection : candidate))
        : [...connections, connection];
      current.modelConnections = nextConnections;

      const rawDefaults = isRecord(current.defaults) ? current.defaults : {};
      const becameDefault = args.setDefault === true || typeof rawDefaults[entry.tag] !== "string";
      if (becameDefault) current.defaults = { ...rawDefaults, [entry.tag]: id };

      outcome = {
        action: existing ? "updated" : "added",
        connection,
        becameDefault,
      };
    });
  } catch (error) {
    return `Error: could not configure model connection: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  if (!outcome) return "Error: model connection write produced no result.";
  deps.notifySettingsChanged();
  let verification: ConnectionTestResult | undefined;
  if (args.testConnection === true) {
    try {
      // Reload credential metadata after the settings transaction. This avoids
      // probing with a stale key if another settings writer rotated it between
      // preflight and persistence.
      const refreshed = scope === "user" ? manager.getForScope("user", ctx.cwd) : manager.get();
      verification = await deps.testTextConnection(
        outcome.connection,
        credentialsFrom(refreshed as unknown as Record<string, unknown>),
        catalog,
      );
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      verification = {
        ok: false,
        error: `could not start connection test: ${redactCredentialSecrets(
          raw,
          effectiveCredentials,
        )}`.slice(0, 1000),
      };
    }
  }
  return JSON.stringify(
    {
      ok: true,
      action: outcome.action,
      scope,
      connection: outcome.connection,
      defaultForTag: outcome.becameDefault ? entry.tag : undefined,
      hotReloadRequested: true,
      ...(verification ? { verification } : {}),
    },
    null,
    2,
  );
}
