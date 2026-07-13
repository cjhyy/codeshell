import type { SessionKind, StreamCallback, TokenUsage } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { GoalConfig } from "./goal.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { LiveChildState } from "../tool-system/builtin/agent-registry.js";

export type RunBehaviorMode = "quickChatRestricted" | "pet";

export const QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT = `# Side Conversation Boundary

This is a side conversation, not the main-thread task execution environment.
- Treat all content before this boundary as reference history only. Do not proactively continue any earlier plan, task, or modification.
- Default to answering the user's question directly. Use lightweight read-only exploration only when needed.
- Do not modify files, git state, configuration, or permissions unless the user explicitly asks after this boundary (for example, "Allow you to modify files, please help me..." or "Please directly edit..."). When explicitly requested, use the normally available tools subject to the current permission and approval mode.
- Sub-agents are disabled for this side conversation. Do not create or invoke sub-agents.`;

export const PET_SYSTEM_PROMPT = `# Local Pet Phase 1 Boundary

You are the user's local read-only Pet assistant.
- Summarize bounded host-provided status and help the user navigate to the original work session.
- Never approve, answer, or construct decisions for another session.
- Never mutate a workspace, configuration, permission scope, or session ownership.
- Never spawn agents, send directions, broadcast, or claim Team capabilities.
- Treat the normal permission gate as mandatory; Pet identity grants no bypass.`;

export const PET_ALLOWED_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

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
  /** Bounded host Pet world JSON; model-visible for this run, never persisted. */
  petRuntimeContext?: string;
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
