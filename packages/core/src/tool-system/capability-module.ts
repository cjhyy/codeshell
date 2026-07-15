import type { RegisteredTool, StreamEvent } from "../types.js";
import type { ToolContext } from "./context.js";
import type { ToolRegistry } from "./registry.js";
import type { BuiltinTool } from "./builtin/index.js";
import type { RunBehaviorProfile } from "../engine/run-types.js";
import type { PendingApprovalMetadata } from "../protocol/types.js";
import { ConfigError } from "../exceptions.js";

export interface ExtensionTool {
  definition: RegisteredTool;
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
}

export type ExtensionQueryHandler = (
  params: Readonly<Record<string, unknown>>,
) => unknown | Promise<unknown>;

/** Read-only live-session state exposed to protocol observers. */
export interface ProtocolLiveSession {
  sessionId: string;
  busy: boolean;
  queueDepth: number;
  lastActivityAt: number;
  kind: string;
}

/**
 * Domain-agnostic protocol lifecycle observer. An extension module can attach
 * one per AgentServer to project protocol activity (runs, stream events,
 * approvals, session/server teardown) into its own state — without the server
 * carrying any domain-specific logic. Observer callbacks must be cheap and
 * must never throw (the server isolates exceptions per observer regardless).
 */
export interface ProtocolObserver {
  /** A session was created/attached by agent/run (before the turn is queued). */
  onSessionAttached?: (sessionId: string, lastActivityAt: number) => void;
  /** Every StreamEvent forwarded to the client for a session's run. */
  onSessionStream?: (sessionId: string, event: StreamEvent) => void;
  /** Run lifecycle boundary: turn accepted (start), finished (end) or threw (error). */
  onRunBoundary?: (sessionId: string, phase: "start" | "end" | "error") => void;
  /**
   * A pending approval was registered. May return replacement metadata (e.g.
   * to override `surfaceable`); returning nothing keeps the input metadata.
   */
  onApprovalCreated?: (metadata: PendingApprovalMetadata) => PendingApprovalMetadata | void;
  /** A pending approval left the pending state (resolved/expired/cancelled/owner-lost). */
  onApprovalTransition?: (metadata: PendingApprovalMetadata, status: string) => void;
  /** A session was explicitly closed (agent/closeSession). */
  onSessionClosed?: (sessionId: string) => void;
  /** The server is shutting down. */
  onServerClose?: () => void;
  /** Resolver-free pending-decision projections for host/debug snapshots. */
  snapshotPendingDecisions?: () => readonly unknown[];
}

/** Capabilities the AgentServer lends to a protocol observer. */
export interface ProtocolObserverHost {
  /** Snapshot of live chat sessions (empty in legacy single-engine mode). */
  getLiveSessionSnapshot: () => readonly ProtocolLiveSession[];
  /** Host lifecycle generation attached to projection snapshots/deltas. */
  projectionGeneration: () => number;
  /** Persisted session kind, when the session is live and its engine knows it. */
  getSessionKind: (sessionId: string) => string | undefined;
  /** True once the server's transport owner disconnected. */
  isTransportDisconnected: () => boolean;
  /** Server → client notification. */
  notify: (method: string, params: Record<string, unknown>) => void;
  /** Register a protocol-method/query alias handled by this extension. */
  registerQuery: (type: string, handler: ExtensionQueryHandler) => void;
}

/**
 * Trusted, in-process product extension. Core owns the registration seam while
 * optional packages own their tools and diagnostic/query surface.
 */
export interface ExtensionModule {
  readonly id: string;
  readonly tools?: readonly ExtensionTool[];
  readonly queries?: Readonly<Record<string, ExtensionQueryHandler>>;
  /** Named per-run behavior profiles contributed by this extension. */
  readonly behaviorProfiles?: readonly RunBehaviorProfile[];
  /** Attach a protocol lifecycle observer to an AgentServer. */
  readonly createProtocolObserver?: (host: ProtocolObserverHost) => ProtocolObserver;
  /** Extra agent/run params validation. Returns an error message or null. */
  readonly validateRunParams?: (params: Record<string, unknown>) => string | null;
  /** Session kinds this extension owns that must stay out of generic session lists. */
  readonly hiddenSessionKinds?: readonly string[];
  /**
   * Full-metadata tool contributions (exposure tags, availability guards,
   * per-turn definition rewrites, default permission rules). These join the
   * engine's composed tool catalog exactly like builtin/capability tools do —
   * use this instead of `tools` when the tool needs visibility metadata.
   */
  readonly catalogTools?: readonly BuiltinTool[];
}

function validateExtensionModules(modules: readonly ExtensionModule[]): void {
  const ids = new Set<string>();
  const queries = new Set<string>();
  const tools = new Set<string>();
  for (const module of modules) {
    if (ids.has(module.id)) {
      throw new ConfigError(`Duplicate capability module id: ${module.id}`, {
        duplicateCapabilityId: module.id,
      });
    }
    ids.add(module.id);
    for (const tool of module.tools ?? []) {
      if (tools.has(tool.definition.name)) {
        throw new ConfigError(`Duplicate capability tool: ${tool.definition.name}`, {
          duplicateCapabilityTool: tool.definition.name,
        });
      }
      tools.add(tool.definition.name);
    }
    for (const query of Object.keys(module.queries ?? {})) {
      if (queries.has(query)) {
        throw new ConfigError(`Duplicate capability query: ${query}`, {
          duplicateCapabilityQuery: query,
        });
      }
      queries.add(query);
    }
  }
}

export function registerExtensionModules(
  registry: ToolRegistry,
  modules: readonly ExtensionModule[],
): void {
  validateExtensionModules(modules);
  for (const module of modules) {
    for (const tool of module.tools ?? []) {
      if (registry.hasTool(tool.definition.name)) {
        throw new ConfigError(
          `Capability tool conflicts with registered tool: ${tool.definition.name}`,
          {
            duplicateCapabilityTool: tool.definition.name,
            capabilityId: module.id,
          },
        );
      }
      registry.registerTool(tool.definition, tool.execute);
    }
  }
}

export async function queryExtensionModules(
  modules: readonly ExtensionModule[],
  type: string,
  params: Readonly<Record<string, unknown>>,
): Promise<{ handled: false } | { handled: true; data: unknown }> {
  validateExtensionModules(modules);
  for (const module of modules) {
    const handler = module.queries?.[type];
    if (handler) return { handled: true, data: await handler(params) };
  }
  return { handled: false };
}
