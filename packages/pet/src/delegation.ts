export const DELEGATE_WORK_TOOL_NAME = "DelegateWork";

/** Execution backend selected explicitly by Mimi from the user's request. */
export type PetWorkExecutionBackend = "codeshell" | "codex";

/** Host-provided closed set visible to Mimi for one manager turn. */
export interface PetWorkspaceOption {
  id: string;
  name: string;
  description?: string;
}

/** Host-provided closed set of existing Work Sessions Mimi may continue. */
export interface PetReusableSessionOption {
  /** Opaque turn-scoped selector; never an unvalidated model-authored Session id. */
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
}

/** Structured decision produced only by a successful DelegateWork tool call. */
export interface PetWorkDelegation {
  workspaceId: string;
  objective: string;
  /** Omitted/CodeShell keeps the normal Work Session executor. */
  executionBackend?: PetWorkExecutionBackend;
  /** Opaque id from the host-provided reusable Session set; absent means create. */
  reusableSessionId?: string;
}

export interface PetWorkDelegationDecision {
  ok: boolean;
  error?: string;
}
