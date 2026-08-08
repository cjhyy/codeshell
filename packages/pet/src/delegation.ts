export const DELEGATE_WORK_TOOL_NAME = "DelegateWork";

/** Closed set of execution backends; extend here and every schema/validation follows. */
export const PET_WORK_EXECUTION_BACKENDS = ["codeshell", "codex"] as const;

/** Execution backend selected explicitly by Mimi from the user's request. */
export type PetWorkExecutionBackend = (typeof PET_WORK_EXECUTION_BACKENDS)[number];

export function isPetWorkExecutionBackend(value: unknown): value is PetWorkExecutionBackend {
  return (PET_WORK_EXECUTION_BACKENDS as readonly unknown[]).includes(value);
}

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
  /**
   * Last activity time (epoch ms), when the host knows it. Sessions inactive
   * beyond the staleness threshold are trimmed from the per-turn snapshot;
   * entries without a timestamp are always kept.
   */
  lastActiveAt?: number;
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
