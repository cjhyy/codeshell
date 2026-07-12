import type { StreamCallback } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { GoalConfig } from "./goal.js";
import type { EngineConfig, EngineResult } from "./types.js";

export type RunBehaviorMode = "quickChatRestricted";

/**
 * Quick chat is intentionally narrower than plan mode: it is for answering a
 * side question with lightweight reads, not planning or delegating work.
 * Engine visibility and ToolExecutor execution gating consume this same set.
 */
export const QUICK_CHAT_RESTRICTED_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
]);

export const QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT = `# Quick Chat Restricted Mode

This is a side conversation. Treat inherited parent history as reference context, not as an active task to continue.
- Default to answering the user's question directly. Use only lightweight read-only exploration when it is needed.
- Do not modify files, git state, configuration, permissions, credentials, or other external state.
- Do not use sub-agents or delegate work.
- If the user explicitly asks for work that needs broader access, ask them to change this quick chat's access badge. Do not attempt the action until the badge reflects the elevated mode.`;

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
