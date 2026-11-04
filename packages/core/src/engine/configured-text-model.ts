import { createHash } from "node:crypto";
import { SettingsManager } from "../settings/manager.js";
import { getMergedCatalog } from "../model-catalog/index.js";
import { resolveInstance } from "../model-catalog/resolve.js";
import { resolveActiveWorkspaceProfileSelection } from "../profile/resolve.js";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import { ModelPool, type ModelEntry } from "../llm/model-pool.js";
import { ConfigError } from "../exceptions.js";

/** Register catalog-backed text connections without selecting a shared pool entry. */
export function registerConfiguredTextModels(
  pool: ModelPool,
  settings: ReturnType<SettingsManager["get"]>,
): boolean {
  // Unified model catalog (统一模型接入方案 §6): register text
  // connections from settings.modelConnections[] into the pool — the
  // catalog-driven instance store is the sole source of model selection.
  // A connection's instance id becomes its pool key. See
  // docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md.
  const connections = (settings as { modelConnections?: unknown[] }).modelConnections;
  if (Array.isArray(connections) && connections.length) {
    const catalog = getMergedCatalog();
    const credentials = (settings as { credentials?: unknown[] }).credentials;
    for (const entry of modelEntriesFromConnections(
      connections as never[],
      (Array.isArray(credentials) ? credentials : []) as never[],
      catalog,
    )) {
      pool.register(entry);
    }
  }
  return Array.isArray(connections) && connections.length > 0;
}

/** Resolve a selection using this workspace's settings, never a foreign pool's credentials. */
export function resolveWorkspaceModelEntry(
  key: string,
  pool: ModelPool,
  manager: SettingsManager,
): ModelEntry | undefined {
  const pooled = pool.get(key);
  manager.invalidate();
  const settings = manager.get();
  const connections = (settings.modelConnections ?? []).filter((item) => item.id === key);
  if (!pooled?.configuredConnectionId && connections.length === 0) return pooled;
  if (connections.length !== 1 || connections[0].tag !== "text") return undefined;
  const entry = modelEntriesFromConnections(
    connections,
    settings.credentials ?? [],
    getMergedCatalog(),
  )[0];
  if (!entry || (entry.needsKey !== false && !entry.apiKey?.trim()))
    throw new ConfigError(`Selected model connection "${key}" is incomplete`);
  if (entry.needsKey === false && !entry.apiKey?.trim()) entry.apiKey = "codeshell-keyless";
  return entry;
}

/** Internal host-to-engine consistency proof; never substitutes for workspace authorization. */
export interface ConfiguredTextModelIntent {
  id: string;
  expectedFingerprint: string;
}
export function isConfiguredTextModelIntent(value: unknown): value is ConfiguredTextModelIntent {
  if (!value || typeof value !== "object") return false;
  const v = value as ConfiguredTextModelIntent;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    v.id.length <= 512 &&
    !/[\r\n\0]/.test(v.id) &&
    typeof v.expectedFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(v.expectedFingerprint)
  );
}
export function readConfiguredTextModelSource(cwd: string, sessionProfile?: string) {
  const manager = new SettingsManager(cwd, "full");
  return {
    settings: manager.get(),
    sessionProfile,
    profile: resolveActiveWorkspaceProfileSelection({ cwd, sessionProfile, settings: manager }),
    catalog: getMergedCatalog(),
  };
}
/** Same catalog/connection conversion as Desktop's pool, with no shared-pool mutation. */
export function configuredTextModelSnapshot(
  id: string,
  source: ReturnType<typeof readConfiguredTextModelSource>,
) {
  const { settings, profile, catalog } = source;
  if (profile.name && !profile.profile) throw new Error("Selected session profile is unavailable");
  const connections = (settings.modelConnections ?? []).filter((item) => item.id === id);
  const connection = connections[0];
  if (connections.length !== 1 || connection?.tag !== "text" || !connection.model.trim())
    throw new Error("Selected text connection is unavailable");
  const resolved = resolveInstance(connection, settings.credentials ?? [], catalog);
  const model = modelEntriesFromConnections([connection], settings.credentials ?? [], catalog)[0];
  if (
    !resolved ||
    !model ||
    resolved.entry.tag !== "text" ||
    (resolved.needsKey && !resolved.apiKey?.trim())
  )
    throw new Error("Selected text connection is incomplete");
  // Keyless catalog connections must neither inherit a process credential nor fail SDK validation.
  if (!resolved.needsKey && !model.apiKey?.trim()) model.apiKey = "codeshell-keyless";
  const llm = new ModelPool([model]).toLLMConfig(model);
  // A child inheriting this snapshot must not reinterpret this id in a different shared pool.
  delete llm.modelKey;
  return {
    llm,
    workspaceProfile: profile.name,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([connection, resolved, model, profile, settings.profile]))
      .digest("hex"),
  };
}
export function resolveConfiguredTextModel(cwd: string, id: string, sessionProfile?: string) {
  return configuredTextModelSnapshot(id, readConfiguredTextModelSource(cwd, sessionProfile));
}

/** Per-Engine selection. Queued runs carry their own immutable proof instead of a mutable slot. */
export class ConfiguredTextModelBinding {
  id?: string;
  private restored = false;
  private pendingAtStart: unknown;
  supersedesPending(value: unknown) {
    return value === this.pendingAtStart;
  }
  snapshot(pending?: unknown) {
    this.pendingAtStart = pending;
    return { id: this.id, restored: this.restored };
  }
  restore(value: ReturnType<ConfiguredTextModelBinding["snapshot"]>) {
    this.id = value.id;
    this.restored = value.restored;
  }
  clear() {
    this.id = undefined;
    this.restored = true;
  }
  restorePersisted(
    state: import("../types.js").SessionState,
    cwd: string,
    pool: ModelPool,
    current: import("../types.js").LLMConfig,
  ) {
    if (state.modelConnectionId) {
      const fresh = resolveConfiguredTextModel(
        cwd,
        state.modelConnectionId,
        state.workspaceProfile,
      );
      this.id = state.modelConnectionId;
      this.restored = true;
      return fresh.llm;
    }
    this.clear();
    if (current.model === state.model && current.provider === state.provider) return current;
    const entry =
      pool.list().find((item) => item.model === state.model && item.provider === state.provider) ??
      pool.list().find((item) => item.model === state.model);
    if (!entry) throw new Error(`Persisted source model is no longer configured: ${state.model}`);
    return pool.toLLMConfig(entry);
  }
  prepare(
    options: import("./run-types.js").EngineRunOptions,
    cwd: string,
    sessionProfile: string | undefined,
    manager: import("../session/session-manager.js").SessionManager,
  ): {
    replayed?: import("./types.js").EngineResult;
    llm?: import("../types.js").LLMConfig;
    assertCurrent?: () => void;
  } {
    const configured = options.configuredModel;
    if (configured && !isConfiguredTextModelIntent(configured))
      throw new Error("Invalid configured text intent");
    // Existing accepted input takes precedence over configuration changes, with no model side effect.
    if (
      configured &&
      options.sessionId &&
      options.clientMessageId &&
      manager.exists(options.sessionId)
    ) {
      const accepted = manager.resume(options.sessionId);
      if (accepted.transcript.hasClientMessageId(options.clientMessageId))
        return {
          replayed: accepted.transcript.findRunResultByClientMessageId(options.clientMessageId) ?? {
            reason: "replay_incomplete",
            text: "This input was already accepted; reload its saved result before sending again.",
            sessionId: options.sessionId,
            turnCount: accepted.state.turnCount ?? 0,
            usage: accepted.state.tokenUsage,
          },
        };
    }
    const persistedId =
      !this.restored && options.sessionId
        ? manager.readSessionState(options.sessionId)?.modelConnectionId
        : undefined;
    const id = configured?.id ?? this.id ?? persistedId;
    if (!id) {
      this.restored = true;
      return {};
    }
    const profileAtPreparation = options.sessionId
      ? manager.readSessionState(options.sessionId)?.workspaceProfile
      : undefined;
    const fresh = resolveConfiguredTextModel(cwd, id, sessionProfile);
    if (configured && fresh.fingerprint !== configured.expectedFingerprint)
      throw new Error("Configured text connection changed before execution");
    this.id = id;
    this.restored = true;
    return {
      llm: fresh.llm,
      assertCurrent: () => {
        const persistedProfile = options.sessionId
          ? manager.readSessionState(options.sessionId)?.workspaceProfile
          : undefined;
        if (
          persistedProfile !== profileAtPreparation ||
          resolveConfiguredTextModel(cwd, id, sessionProfile).fingerprint !== fresh.fingerprint
        )
          throw new Error("Configured text connection changed before execution");
      },
    };
  }
}
