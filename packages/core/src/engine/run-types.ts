import type { StreamCallback, TokenUsage } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { GoalConfig } from "./goal.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { LiveChildState } from "../tool-system/builtin/agent-registry.js";

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
