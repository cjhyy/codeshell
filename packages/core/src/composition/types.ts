/**
 * AgentModule — the single trusted product-module interface that unifies
 * CapabilityModule and ExtensionModule (design:
 * docs/todo/agent-module-resolved-composition-design.md). Hosts and Engines
 * consume frozen declarations and own activated resources through lifetime scopes.
 */
import type {
  CapabilityArtifactDetector,
  CapabilityDynamicContextProvider,
  CapabilityEngineHookContribution,
  CapabilityFileHistoryContribution,
  CapabilityInstructionBoundaryFinder,
  CapabilityToolSelectionContext,
  CapabilityToolServiceHost,
  SessionWorkspaceCapability,
} from "../capabilities/index.js";
import type { AgentPreset } from "../preset/index.js";
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type {
  ExtensionQueryHandler,
  ExtensionTool,
  ProtocolObserver,
  ProtocolObserverHost,
} from "../tool-system/capability-module.js";
import type { RunBehaviorProfile } from "../engine/run-types.js";
import type { HookEventName } from "../hooks/events.js";
import type { DisposableLike, LifetimeScope } from "./lifetime.js";

export type MaybeDisposable = DisposableLike | Promise<DisposableLike>;
export interface ModuleActivationContext<THost> {
  readonly moduleId: string;
  readonly scope: LifetimeScope;
  readonly resolved: ResolvedModule;
  readonly host: THost;
  own(resource: DisposableLike): void;
}
/** No registry or Engine escapes this boundary: activators cannot add declarations. */
export type HostModuleActivationContext = ModuleActivationContext<
  Readonly<Omit<ProtocolObserverHost, "registerQuery">>
>;
export type EngineModuleActivationContext = ModuleActivationContext<
  Readonly<CapabilityToolServiceHost>
>;
export interface ModuleServiceHost extends CapabilityToolServiceHost {
  readonly sessionId?: string;
}
export interface AgentModulePrivateServiceContribution {
  readonly scope: "engine" | "session";
  create(host: ModuleServiceHost): unknown | Promise<unknown>;
  dispose?(value: unknown): void | Promise<void>;
}

/**
 * One tool contribution with explicit exposure:
 * - "preset-tags": full BuiltinTool metadata; joins the composed catalog.
 * - "always": plain ExtensionTool; registered directly, always visible.
 */
export type AgentModuleToolContribution =
  | { readonly kind: "preset-tags"; readonly tool: BuiltinTool }
  | { readonly kind: "always"; readonly tool: ExtensionTool };

export interface AgentEngineContributions {
  readonly tools?: readonly AgentModuleToolContribution[];
  readonly presets?: readonly AgentPreset[];
  /** Preset used when the host does not choose one. At most one module may declare it. */
  readonly defaultPreset?: string;
  readonly promptSections?: Readonly<Record<string, string>>;
  readonly dynamicContextProviders?: readonly CapabilityDynamicContextProvider[];
  readonly instructionBoundary?: CapabilityInstructionBoundaryFinder;
  readonly artifactDetectors?: readonly CapabilityArtifactDetector[];
  readonly fileHistory?: readonly CapabilityFileHistoryContribution[];
  readonly sessionWorkspace?: SessionWorkspaceCapability;
  readonly hooks?: readonly CapabilityEngineHookContribution[];
  readonly behaviorProfiles?: readonly RunBehaviorProfile[];
  readonly adjustToolSelection?: (
    names: Set<string>,
    context: CapabilityToolSelectionContext,
  ) => void;
  readonly privateService?: AgentModulePrivateServiceContribution;
}

export interface AgentProtocolContributions {
  readonly queries?: Readonly<Record<string, ExtensionQueryHandler>>;
  /** Existing name createProtocolObserver; renamed here by design. */
  readonly createObserver?: (host: ProtocolObserverHost) => ProtocolObserver;
  readonly validateRunParams?: (params: Record<string, unknown>) => string | null;
  readonly hiddenSessionKinds?: readonly string[];
}

export interface AgentModule {
  readonly id: string;
  readonly engine?: AgentEngineContributions;
  readonly protocol?: AgentProtocolContributions;
  activateHost?(context: HostModuleActivationContext): MaybeDisposable;
  activateEngine?(context: EngineModuleActivationContext): MaybeDisposable;
}

// ─── Resolved composition ────────────────────────────────────────

export interface ResolvedModule {
  readonly id: string;
  readonly order: number;
  readonly source: "core" | "host";
}

export interface ResolvedContribution<T> {
  readonly key: string;
  readonly moduleId: string;
  readonly value: T;
}

export type ResolvedToolContribution =
  | { readonly kind: "preset-tags"; readonly moduleId: string; readonly tool: BuiltinTool }
  | { readonly kind: "always"; readonly moduleId: string; readonly tool: ExtensionTool };

export interface ResolvedEngineHook {
  readonly moduleId: string;
  readonly event: HookEventName;
  readonly handler: CapabilityEngineHookContribution["handler"];
  readonly priority: number;
  readonly name: string;
}

export interface ResolvedEngineComposition {
  /**
   * Effective registry order: every preset-tags tool (module order) first,
   * then every always tool (module order) — mirrors the current engine's
   * composeToolCatalog() + registerExtensionModules() sequence.
   */
  readonly tools: readonly ResolvedToolContribution[];
  readonly presets: readonly ResolvedContribution<AgentPreset>[];
  readonly defaultPreset: string;
  readonly promptSections: readonly ResolvedContribution<string>[];
  readonly dynamicContextProviders: readonly ResolvedContribution<CapabilityDynamicContextProvider>[];
  readonly instructionBoundaries: readonly ResolvedContribution<CapabilityInstructionBoundaryFinder>[];
  readonly artifactDetectors: readonly ResolvedContribution<CapabilityArtifactDetector>[];
  readonly fileHistory: readonly ResolvedContribution<CapabilityFileHistoryContribution>[];
  readonly sessionWorkspaces: readonly ResolvedContribution<SessionWorkspaceCapability>[];
  readonly hooks: readonly ResolvedEngineHook[];
  readonly behaviorProfiles: readonly ResolvedContribution<RunBehaviorProfile>[];
  readonly toolSelectionAdjusters: readonly ResolvedContribution<
    NonNullable<AgentEngineContributions["adjustToolSelection"]>
  >[];
  readonly toolServices: readonly ResolvedContribution<AgentModulePrivateServiceContribution>[];
}

export interface ResolvedProtocolComposition {
  readonly queries: readonly ResolvedContribution<ExtensionQueryHandler>[];
  readonly observerFactories: readonly ResolvedContribution<
    (host: ProtocolObserverHost) => ProtocolObserver
  >[];
  readonly runValidators: readonly ResolvedContribution<
    (params: Record<string, unknown>) => string | null
  >[];
  readonly hiddenSessionKinds: readonly ResolvedContribution<string>[];
}

export interface CompositionDiagnostic {
  readonly code:
    | "empty_module"
    | "engine_only_module"
    | "protocol_only_module"
    | "core_preset_shadowed";
  readonly moduleId: string;
  readonly message: string;
}

export interface ResolvedComposition {
  readonly version: 1;
  readonly digest: string;
  readonly modules: readonly ResolvedModule[];
  readonly engine: ResolvedEngineComposition;
  readonly protocol: ResolvedProtocolComposition;
  readonly diagnostics: readonly CompositionDiagnostic[];
  readonly hostActivators: readonly ResolvedContribution<
    NonNullable<AgentModule["activateHost"]>
  >[];
  readonly engineActivators: readonly ResolvedContribution<
    NonNullable<AgentModule["activateEngine"]>
  >[];
}

export interface CompileCompositionOptions {
  /** Defaults to CORE_AGENT_MODULE. Overridable only for unit tests. */
  readonly core?: AgentModule;
  readonly modules?: readonly AgentModule[];
  /** Module ids the host requires; missing ids are a compile error. */
  readonly expectedModules?: readonly string[];
}

// ─── Serializable snapshot ───────────────────────────────────────

/** Pure-data projection; never contains functions, prompt bodies or paths. */
export interface CompositionSnapshot {
  version: 1;
  modules: Array<{ id: string; order: number; source: string }>;
  tools: Array<{
    name: string;
    moduleId: string;
    exposure: "preset-tags" | "always";
    presetTags: string[];
  }>;
  presets: Array<{ name: string; moduleId: string; isDefault: boolean }>;
  promptSections: Array<{ name: string; moduleId: string }>;
  hooks: Array<{ event: string; name: string; priority: number; moduleId: string }>;
  behaviorProfiles: Array<{ id: string; moduleId: string }>;
  queries: Array<{ type: string; moduleId: string }>;
  observers: string[];
  runValidators: string[];
  hiddenSessionKinds: Array<{ kind: string; moduleId: string }>;
  lifetimes?: {
    host: string[];
    engine: string[];
    services: Array<{ moduleId: string; scope: "engine" | "session" }>;
  };
}
