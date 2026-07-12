import type { StreamCallback } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { GoalConfig } from "./goal.js";
import type { EngineConfig, EngineResult } from "./types.js";

export type RunBehaviorMode = "quickChatRestricted";

export const QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT = `# Side Conversation Boundary

This is a side conversation, not the main-thread task execution environment.
- Treat all content before this boundary as reference history only. Do not proactively continue any earlier plan, task, or modification.
- Default to answering the user's question directly. Use lightweight read-only exploration only when needed.
- Do not modify files, git state, configuration, or permissions unless the user explicitly asks after this boundary (for example, "Allow you to modify files, please help me..." or "Please directly edit..."). When explicitly requested, use the normally available tools subject to the current permission and approval mode.
- Sub-agents are disabled for this side conversation. Do not create or invoke sub-agents.`;

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
}

export interface ChildEngineRunner {
  runChild(
    config: EngineConfig,
    task: string,
    options: Pick<EngineRunOptions, "signal" | "onStream" | "sessionId">,
  ): Promise<Pick<EngineResult, "text" | "sessionId" | "usage">>;
}

export interface RunScopedDisposer {
  dispose(): void | Promise<void>;
}
