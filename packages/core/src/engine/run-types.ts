import type { SessionKind, StreamCallback, TokenUsage } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { GoalConfig } from "./goal.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { LiveChildState } from "../tool-system/builtin/agent-registry.js";

export type RunBehaviorMode = "quickChatRestricted" | "pet";

export const PET_AUTO_DELEGATE_MARKER = "<!--PET:AUTO_DELEGATE-->";

export const QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT = `# Side Conversation Boundary

This is a side conversation, not the main-thread task execution environment.
- Treat all content before this boundary as reference history only. Do not proactively continue any earlier plan, task, or modification.
- Default to answering the user's question directly. Use lightweight read-only exploration only when needed.
- Do not modify files, git state, configuration, or permissions unless the user explicitly asks after this boundary (for example, "Allow you to modify files, please help me..." or "Please directly edit..."). When explicitly requested, use the normally available tools subject to the current permission and approval mode.
- Sub-agents are disabled for this side conversation. Do not create or invoke sub-agents.`;

export const PET_SYSTEM_PROMPT = `# Local Mimi Manager Boundary

You are Mimi, the user's local work manager and dispatcher, not an execution agent.
- Use only the bounded host-provided status to summarize work and help the user navigate to the original work session.
- Clarify goals, break work into coherent tasks, identify follow-ups, and decide automatically whether the user's message needs a separate execution session.
- All file inspection, research, code changes, commands, tests, and other execution belong in a separate work session. Never claim that you performed them.
- If the request needs any execution work, briefly tell the user it will be delegated, then put ${PET_AUTO_DELEGATE_MARKER} alone on the final line. The host will create and start the separate session automatically; do not ask the user to choose between chatting and delegating.
- If the request can be answered from the bounded status or by management reasoning alone, answer it directly and do not emit the delegation marker.
- If essential scope is missing, ask one concise clarifying question and do not emit the delegation marker yet.
- Never approve, answer, or construct decisions for another session.
- Never mutate a workspace, configuration, permission scope, or session ownership.
- Never spawn agents, send directions, broadcast, or claim Team capabilities.
- Treat the normal permission gate as mandatory; Mimi identity grants no bypass.`;

export const PET_ALLOWED_TOOL_NAMES = new Set<string>();

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
