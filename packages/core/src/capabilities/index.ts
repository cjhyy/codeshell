import type { AgentPreset } from "../preset/index.js";
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type { SandboxBackend } from "../tool-system/sandbox/index.js";
import type { SessionManager } from "../session/session-manager.js";
import type { ArtifactKind, ArtifactRole } from "../run/types.js";
import type { HookEventName } from "../hooks/events.js";
import type { HookHandler } from "../hooks/registry.js";

/**
 * A host-installable slice of agent behavior.
 *
 * Core owns the lifecycle and execution contracts; product packages contribute
 * tools, presets, and prompt text through this boundary. Modules are plain data
 * so a host can compose them per Engine without mutating process-global state.
 */
export interface CapabilityModule {
  id: string;
  tools?: readonly BuiltinTool[];
  presets?: readonly AgentPreset[];
  /** Preset selected when this capability is installed and the host did not choose one. */
  defaultPreset?: string;
  promptSections?: Readonly<Record<string, string>>;
  /** Volatile, capability-owned context appended after the cacheable prompt prefix. */
  dynamicContextProviders?: readonly CapabilityDynamicContextProvider[];
  /** Optional project boundary for layered instruction discovery. */
  instructionBoundary?: CapabilityInstructionBoundaryFinder;
  /** Runtime services exposed only to this capability's tools. */
  createToolService?(host: CapabilityToolServiceHost): unknown;
  /** Capability-specific run artifact recognition. */
  artifactDetectors?: readonly CapabilityArtifactDetector[];
  /** Pre-mutation snapshot targets for capability-owned compound file tools. */
  fileHistory?: readonly CapabilityFileHistoryContribution[];
  /** Optional validation for persisted product-specific workspace pointers. */
  sessionWorkspace?: SessionWorkspaceCapability;
  /** Trusted in-process handlers joined to this Engine's normal hook chain. */
  engineHooks?: readonly CapabilityEngineHookContribution[];
  adjustToolSelection?(names: Set<string>, context: CapabilityToolSelectionContext): void;
}

export interface CapabilityEngineHookContribution {
  event: HookEventName;
  handler: HookHandler;
  priority?: number;
  name?: string;
}

export interface ResolvedCapabilityEngineHook extends CapabilityEngineHookContribution {
  capabilityId: string;
  priority: number;
  name: string;
}

export interface CapabilityDynamicContext {
  cwd: string;
  preset: AgentPreset;
}

export type CapabilityDynamicContextProvider = (
  context: CapabilityDynamicContext,
) => string | undefined | Promise<string | undefined>;

export type CapabilityInstructionBoundaryFinder = (cwd: string) => string | null;

/** Generic host services from which a capability may build its private tool service. */
export interface CapabilityToolServiceHost {
  readonly isSubAgent: boolean;
  readonly settings: {
    get(): unknown;
    getForScope(scope: "user" | "project", cwd?: string): unknown;
  };
  resolveSandbox(cwd: string): Promise<SandboxBackend>;
  readShellEnv(cwd?: string): Record<string, string> | undefined;
  getSessionManager(): SessionManager;
}

export interface CapabilityArtifact {
  kind: ArtifactKind;
  role: ArtifactRole;
  title: string;
  locator: string;
  metadata?: Record<string, unknown>;
}

export interface CapabilityArtifactDetectionContext {
  toolName: string;
  args: Record<string, unknown>;
  resultText?: string;
}

export type CapabilityArtifactDetector = (
  context: CapabilityArtifactDetectionContext,
) => CapabilityArtifact | readonly CapabilityArtifact[] | undefined;

export interface CapabilityToolSelectionContext {
  preset: string;
  host?: string;
}

export interface SessionWorkspaceCapability {
  validateRoot(root: string): Promise<boolean>;
  branchExists(mainRoot: string, branch: string): Promise<boolean>;
}

export interface CapabilityFileHistoryContribution {
  toolName: string;
  resolveTargets(args: Record<string, unknown>, cwd: string): readonly string[];
}

const installedCapabilities = new Map<string, CapabilityModule>();

/**
 * Install a capability at a process composition root (CLI/desktop worker).
 * Library consumers should prefer EngineConfig.capabilities for isolation.
 */
export function registerCapability(capability: CapabilityModule): void {
  const existing = installedCapabilities.get(capability.id);
  if (existing === capability) return;
  if (existing) throw new Error(`Capability '${capability.id}' is already registered`);
  installedCapabilities.set(capability.id, capability);
}

/** Primarily useful for isolated hosts and tests that own their process. */
export function unregisterCapability(id: string): void {
  installedCapabilities.delete(id);
}

export function listRegisteredCapabilities(): CapabilityModule[] {
  return [...installedCapabilities.values()];
}

/** Merge process-installed and per-Engine modules, rejecting ambiguous IDs. */
export function resolveCapabilities(local: readonly CapabilityModule[] = []): CapabilityModule[] {
  const resolved = new Map(installedCapabilities);
  for (const capability of local) {
    const existing = resolved.get(capability.id);
    if (existing && existing !== capability) {
      throw new Error(`Capability '${capability.id}' was provided more than once`);
    }
    resolved.set(capability.id, capability);
  }
  return [...resolved.values()];
}

export function composeToolCatalog(
  coreTools: readonly BuiltinTool[],
  capabilities: readonly CapabilityModule[],
  extensionModules: readonly { catalogTools?: readonly BuiltinTool[] }[] = [],
): BuiltinTool[] {
  const catalog = new Map<string, BuiltinTool>();
  for (const tool of [
    ...coreTools,
    ...capabilities.flatMap((capability) => [...(capability.tools ?? [])]),
    ...extensionModules.flatMap((module) => [...(module.catalogTools ?? [])]),
  ]) {
    const name = tool.definition.name;
    if (catalog.has(name)) throw new Error(`Tool '${name}' is contributed more than once`);
    catalog.set(name, tool);
  }
  return [...catalog.values()];
}

export function composePromptSections(
  capabilities: readonly CapabilityModule[],
): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const capability of capabilities) {
    for (const [name, content] of Object.entries(capability.promptSections ?? {})) {
      if (name in sections)
        throw new Error(`Prompt section '${name}' is contributed more than once`);
      sections[name] = content;
    }
  }
  return sections;
}

export function composeDynamicContextProviders(
  capabilities: readonly CapabilityModule[],
): CapabilityDynamicContextProvider[] {
  return capabilities.flatMap((capability) => [...(capability.dynamicContextProviders ?? [])]);
}

export function composeArtifactDetectors(
  capabilities: readonly CapabilityModule[],
): CapabilityArtifactDetector[] {
  return capabilities.flatMap((capability) => [...(capability.artifactDetectors ?? [])]);
}

/** Normalize code hooks with deterministic names and a product-module priority. */
export function composeCapabilityEngineHooks(
  capabilities: readonly CapabilityModule[],
): ResolvedCapabilityEngineHook[] {
  return capabilities.flatMap((capability) =>
    (capability.engineHooks ?? []).map((hook, index) => ({
      ...hook,
      capabilityId: capability.id,
      priority: hook.priority ?? 20,
      name: `capability:${capability.id}:${hook.name ?? `${hook.event}:${index}`}`,
    })),
  );
}

export function resolveInstructionBoundary(
  cwd: string,
  capabilities: readonly CapabilityModule[],
): string | null {
  for (const capability of capabilities) {
    const boundary = capability.instructionBoundary?.(cwd);
    if (boundary) return boundary;
  }
  return null;
}
