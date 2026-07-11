import type { StreamCallback } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { GoalConfig } from "./goal.js";
import type { EngineConfig, EngineResult } from "./types.js";

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
