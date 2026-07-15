import type { SessionKind, StreamCallback, TokenUsage } from "../types.js";
import type { InputAttachmentMeta } from "../types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { GoalConfig } from "../goal/lifecycle.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { LiveChildState } from "../tool-system/builtin/agent-registry.js";
import type { LegacyPetWorkspaceOption } from "../types.js";

/**
 * Open string id naming a registered {@link RunBehaviorProfile}. The literal
 * "quickChatRestricted" (and, transitionally, "pet") remain valid values —
 * the type is a string so hosts can register their own profiles.
 */
export type RunBehaviorMode = string;

/**
 * A named, domain-agnostic per-run behavior profile. Engine resolves at most
 * one active profile per run (by behaviorMode or session kind) and applies
 * its constraints generically — core carries no knowledge of what the
 * profile is for. Product domains (e.g. the desktop Pet manager) define
 * profile instances and register them via EngineConfig.behaviorProfiles or
 * ExtensionModule.behaviorProfiles.
 */
export interface RunBehaviorProfile {
  id: string;
  /** Appended to the system prompt after config.appendSystemPrompt. */
  systemPromptAppend?: string;
  /** Hard tool allowlist for the run (model visibility + execution gate). */
  allowedToolNames?: ReadonlySet<string>;
  /** When set, the run's permission mode is locked to this value. */
  forcePermissionMode?: NonNullable<EngineConfig["permissionMode"]>;
  /** When true, per-run planMode requests are ignored. */
  disablePlanMode?: boolean;
  /** When true, MCP servers are neither connected nor exposed for the run. */
  disableMcp?: boolean;
  /**
   * Wrapper tag for host-provided runtime context injected at the system
   * prompt tail (e.g. "pet-world"). Injection happens only when both this tag
   * and profileParams.runtimeContext (a string) are present.
   */
  runtimeContextTag?: string;
  /** Heading line above the runtime-context block. */
  runtimeContextHeading?: string;
  /**
   * Per-run services injected into ToolContext.runScopedServices for tools
   * that share the profile's domain conventions. reportResult(key, value)
   * surfaces structured run output under EngineResult.extensions[profile.id].
   */
  createRunServices?: (opts: {
    profileParams: Readonly<Record<string, unknown>>;
    reportResult: (key: string, value: unknown) => void;
  }) => Record<string, unknown>;
  /**
   * Per-run metadata exposed to builtin availability guards / definition
   * rewriters via ToolVisibilityContext.profileMeta.
   */
  buildVisibilityMeta?: (
    profileParams: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown> | undefined;
  /** Auto-activate this profile for these persisted session kinds. */
  activateForSessionKinds?: readonly string[];
}

export const QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT = `# Side Conversation Boundary

This is a side conversation, not the main-thread task execution environment.
- Treat all content before this boundary as reference history only. Do not proactively continue any earlier plan, task, or modification.
- Default to answering the user's question directly. Use lightweight read-only exploration only when needed.
- Do not modify files, git state, configuration, or permissions unless the user explicitly asks after this boundary (for example, "Allow you to modify files, please help me..." or "Please directly edit..."). When explicitly requested, use the normally available tools subject to the current permission and approval mode.
- Sub-agents are disabled for this side conversation. Do not create or invoke sub-agents.`;

/** The side-conversation restriction expressed as a generic behavior profile. */
export const QUICK_CHAT_RESTRICTED_PROFILE: RunBehaviorProfile = {
  id: "quickChatRestricted",
  systemPromptAppend: QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT,
};

export interface EngineRunOptions {
  cwd?: string;
  onStream?: StreamCallback;
  signal?: AbortSignal;
  sessionId?: string;
  permissionMode?: NonNullable<EngineConfig["permissionMode"]>;
  planMode?: boolean;
  approvalRouter?: ApprovalRouter;
  goal?: string | GoalConfig;
  injected?: boolean;
  clientMessageId?: string;
  attachments?: InputAttachmentMeta[];
  /** Named per-run behavior profile supplied by interactive product surfaces. */
  behaviorMode?: RunBehaviorMode;
  /**
   * Generic per-run parameters consumed by the active behavior profile
   * (createRunServices / buildVisibilityMeta / runtime-context injection).
   * Never persisted; never part of `task`.
   */
  profileParams?: Record<string, unknown>;
  /** Digital human bound to this Work Session; persisted on first use. */
  workspaceProfile?: string;
  /**
   * @deprecated Compat alias for `profileParams.runtimeContext` — bounded host
   * Pet world JSON; model-visible for this run, never persisted.
   */
  petRuntimeContext?: string;
  /**
   * @deprecated Compat alias for `profileParams.workspaces` — closed Workspace
   * choices available to DelegateWork for this Pet turn.
   */
  petWorkspaces?: readonly LegacyPetWorkspaceOption[];
  /** Durable classification requested only when creating a new session. */
  kind?: SessionKind;
  /** Trusted metadata for an interrupt redrive initiated by agent direction. */
  agentDirection?: {
    envelopeIds: string[];
    correlationIds: string[];
  };
  /** Trusted child writer generation used to fence mailbox drains. */
  runtimeGeneration?: number;
  /** Trusted runtime-only progress events; never model/tool input. */
  onAgentProgress?: (event: AgentRuntimeProgressEvent) => void;
}

export type AgentRuntimeProgressEvent =
  | {
      type: "phase";
      phase: "starting" | "model" | "tool" | "waiting-permission" | "compacting" | "finalizing";
      toolName?: string;
    }
  | { type: "usage"; usage: TokenUsage };

export interface ChildEngineRuntime {
  run(task: string, options?: EngineRunOptions): Promise<EngineResult>;
  setAgentControlStateListener(listener: ((state: LiveChildState) => void) | undefined): void;
  setAgentDirectionsDeliveredListener?(
    listener: ((envelopeIds: string[]) => void) | undefined,
  ): void;
}

export interface ChildEngineRunner {
  createChild?(config: EngineConfig): ChildEngineRuntime;
  runChild(
    config: EngineConfig,
    task: string,
    options: Pick<EngineRunOptions, "signal" | "onStream" | "sessionId">,
  ): Promise<Pick<EngineResult, "text" | "sessionId" | "usage">>;
}

export interface RunScopedDisposer {
  dispose(): void | Promise<void>;
}
