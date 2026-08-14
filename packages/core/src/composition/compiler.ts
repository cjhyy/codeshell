import { CompositionError } from "../exceptions.js";
import { DEFAULT_AGENT_PRESET } from "../preset/index.js";
import { CORE_AGENT_MODULE } from "./core-module.js";
import { computeCompositionDigest, toCompositionSnapshot } from "./snapshot.js";
import type {
  AgentModule,
  CompileCompositionOptions,
  CompositionDiagnostic,
  ResolvedComposition,
  ResolvedContribution,
  ResolvedEngineComposition,
  ResolvedEngineHook,
  ResolvedModule,
  ResolvedProtocolComposition,
  ResolvedToolContribution,
} from "./types.js";

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

interface RegisteredModule {
  readonly module: AgentModule;
  readonly resolved: ResolvedModule;
}

function registerModules(options: CompileCompositionOptions): RegisteredModule[] {
  const core = options.core ?? CORE_AGENT_MODULE;
  const registered: RegisteredModule[] = [];
  const seen = new Set<string>();
  const push = (module: AgentModule, source: "core" | "host"): void => {
    if (!MODULE_ID_PATTERN.test(module.id)) {
      throw new CompositionError(`Invalid module id: "${module.id}"`, {
        code: "invalid_module_id",
        key: module.id,
      });
    }
    if (seen.has(module.id)) {
      throw new CompositionError(`Duplicate module id: "${module.id}"`, {
        code: "duplicate_module",
        key: module.id,
      });
    }
    seen.add(module.id);
    registered.push({
      module,
      resolved: { id: module.id, order: registered.length, source },
    });
  };
  push(core, "core");
  for (const module of options.modules ?? []) push(module, "host");
  for (const id of options.expectedModules ?? []) {
    if (!seen.has(id)) {
      throw new CompositionError(`Expected module "${id}" is missing`, {
        code: "missing_expected_module",
        key: id,
      });
    }
  }
  return registered;
}

function moduleDiagnostics(registered: RegisteredModule[]): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = [];
  for (const { module, resolved } of registered) {
    if (resolved.source === "core") continue;
    const hasEngine = module.engine !== undefined;
    const hasProtocol = module.protocol !== undefined;
    if (!hasEngine && !hasProtocol) {
      diagnostics.push({
        code: "empty_module",
        moduleId: module.id,
        message: `Module "${module.id}" declares no contributions`,
      });
    } else if (!hasProtocol) {
      diagnostics.push({
        code: "engine_only_module",
        moduleId: module.id,
        message: `Module "${module.id}" contributes engine surface only`,
      });
    } else if (!hasEngine) {
      diagnostics.push({
        code: "protocol_only_module",
        moduleId: module.id,
        message: `Module "${module.id}" contributes protocol surface only`,
      });
    }
  }
  return diagnostics;
}

function duplicate(
  kind: string,
  key: string,
  firstModuleId: string,
  secondModuleId: string,
): CompositionError {
  return new CompositionError(
    `Duplicate ${kind} "${key}" contributed by "${firstModuleId}" and "${secondModuleId}"`,
    { code: `duplicate_${kind.replaceAll(" ", "_")}`, key, firstModuleId, secondModuleId },
  );
}

/** Collect keyed contributions across modules, failing loud on duplicates. */
function collectKeyed<T>(
  registered: RegisteredModule[],
  kind: string,
  pick: (module: AgentModule) => ReadonlyArray<readonly [string, T]>,
): ResolvedContribution<T>[] {
  const owners = new Map<string, string>();
  const collected: ResolvedContribution<T>[] = [];
  for (const { module } of registered) {
    for (const [key, value] of pick(module)) {
      const owner = owners.get(key);
      if (owner !== undefined) throw duplicate(kind, key, owner, module.id);
      owners.set(key, module.id);
      collected.push({ key, moduleId: module.id, value });
    }
  }
  return collected;
}

/** One optional contribution per module (e.g. instructionBoundary). */
function collectSingle<T>(
  registered: RegisteredModule[],
  pick: (module: AgentModule) => T | undefined,
): ResolvedContribution<T>[] {
  return registered.flatMap(({ module }) => {
    const value = pick(module);
    return value === undefined ? [] : [{ key: module.id, moduleId: module.id, value }];
  });
}

/** Ordered, non-keyed contributions (providers, detectors, file-history). */
function collectMany<T>(
  registered: RegisteredModule[],
  pick: (module: AgentModule) => readonly T[] | undefined,
): ResolvedContribution<T>[] {
  return registered.flatMap(({ module }) =>
    (pick(module) ?? []).map((value, index) => ({
      key: `${module.id}:${index}`,
      moduleId: module.id,
      value,
    })),
  );
}

function collectEngine(registered: RegisteredModule[]): ResolvedEngineComposition {
  // Tools: preset-tags join the composed catalog (module order), always tools
  // are appended afterwards — mirroring composeToolCatalog() followed by
  // registerExtensionModules() in the current engine constructor.
  const toolOwners = new Map<string, string>();
  const presetTagTools: ResolvedToolContribution[] = [];
  const alwaysTools: ResolvedToolContribution[] = [];
  for (const { module } of registered) {
    for (const contribution of module.engine?.tools ?? []) {
      const name = contribution.tool.definition.name;
      const owner = toolOwners.get(name);
      if (owner !== undefined) throw duplicate("tool", name, owner, module.id);
      toolOwners.set(name, module.id);
      if (contribution.kind === "preset-tags") {
        presetTagTools.push({ kind: "preset-tags", moduleId: module.id, tool: contribution.tool });
      } else {
        alwaysTools.push({ kind: "always", moduleId: module.id, tool: contribution.tool });
      }
    }
  }
  const tools = [...presetTagTools, ...alwaysTools];

  const presets = collectKeyed(registered, "preset", (m) =>
    (m.engine?.presets ?? []).map((p) => [p.name, p] as const),
  );

  // Default preset: at most one distinct declaration wins; none → core default.
  let defaultPreset: { name: string; moduleId: string } | undefined;
  for (const { module } of registered) {
    const declared = module.engine?.defaultPreset;
    if (!declared) continue;
    if (defaultPreset && defaultPreset.name !== declared) {
      throw new CompositionError(
        `Conflicting default presets: "${defaultPreset.name}" (${defaultPreset.moduleId}) vs "${declared}" (${module.id})`,
        {
          code: "conflicting_default_preset",
          key: declared,
          firstModuleId: defaultPreset.moduleId,
          secondModuleId: module.id,
        },
      );
    }
    defaultPreset ??= { name: declared, moduleId: module.id };
  }
  const defaultPresetName = defaultPreset?.name ?? DEFAULT_AGENT_PRESET;
  if (!presets.some((p) => p.key === defaultPresetName)) {
    throw new CompositionError(`Default preset "${defaultPresetName}" is not contributed`, {
      code: "unknown_default_preset",
      key: defaultPresetName,
      firstModuleId: defaultPreset?.moduleId ?? "core",
    });
  }

  // Preset tool references must resolve to preset-tags tools.
  const presetTagToolNames = new Set(presetTagTools.map((t) => t.tool.definition.name));
  for (const { key, moduleId, value } of presets) {
    for (const toolName of value.builtinTools) {
      if (!presetTagToolNames.has(toolName)) {
        throw new CompositionError(`Preset "${key}" references unknown tool "${toolName}"`, {
          code: "unknown_preset_tool",
          key: toolName,
          firstModuleId: moduleId,
        });
      }
    }
  }

  const promptSections = collectKeyed(registered, "prompt section", (m) =>
    Object.entries(m.engine?.promptSections ?? {}),
  );
  const behaviorProfiles = collectKeyed(registered, "behavior profile", (m) =>
    (m.engine?.behaviorProfiles ?? []).map((p) => [p.id, p] as const),
  );

  const hooks: ResolvedEngineHook[] = registered.flatMap(({ module }) =>
    (module.engine?.hooks ?? []).map((hook, index) => ({
      moduleId: module.id,
      event: hook.event,
      handler: hook.handler,
      priority: hook.priority ?? 20,
      name: `capability:${module.id}:${hook.name ?? `${hook.event}:${index}`}`,
    })),
  );

  return {
    tools,
    presets,
    defaultPreset: defaultPresetName,
    promptSections,
    dynamicContextProviders: collectMany(registered, (m) => m.engine?.dynamicContextProviders),
    instructionBoundaries: collectSingle(registered, (m) => m.engine?.instructionBoundary),
    artifactDetectors: collectMany(registered, (m) => m.engine?.artifactDetectors),
    fileHistory: collectMany(registered, (m) => m.engine?.fileHistory),
    sessionWorkspaces: collectSingle(registered, (m) => m.engine?.sessionWorkspace),
    hooks,
    behaviorProfiles,
    toolSelectionAdjusters: collectSingle(registered, (m) => m.engine?.adjustToolSelection),
    toolServices: collectSingle(registered, (m) => m.engine?.createToolService),
  };
}

function collectProtocol(registered: RegisteredModule[]): ResolvedProtocolComposition {
  const queries = collectKeyed(registered, "query", (m) =>
    Object.entries(m.protocol?.queries ?? {}),
  );
  const hiddenSessionKinds = collectKeyed(registered, "hidden session kind", (m) =>
    (m.protocol?.hiddenSessionKinds ?? []).map((k) => [k, k] as const),
  );
  return {
    queries,
    observerFactories: collectSingle(registered, (m) => m.protocol?.createObserver),
    runValidators: collectSingle(registered, (m) => m.protocol?.validateRunParams),
    hiddenSessionKinds,
  };
}

/**
 * Pure composition compiler (design §7): same input produces the same
 * frozen ResolvedComposition, identical order and digest. Conflicts fail
 * loud with both owning module ids; no I/O, no resource creation.
 */
export function compileComposition(options: CompileCompositionOptions = {}): ResolvedComposition {
  const registered = registerModules(options);
  const diagnostics = moduleDiagnostics(registered);
  const engine = collectEngine(registered);
  const protocol = collectProtocol(registered);
  const draft = {
    version: 1 as const,
    modules: Object.freeze(registered.map((r) => r.resolved)),
    engine,
    protocol,
    diagnostics: Object.freeze(diagnostics),
  };
  const digest = computeCompositionDigest(toCompositionSnapshot(draft));
  return Object.freeze({ ...draft, digest });
}
