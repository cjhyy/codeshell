export const DELEGATE_WORK_TOOL_NAME = "DelegateWork";

/** Host-provided closed set visible to Mimi for one manager turn. */
export interface PetWorkspaceOption {
  id: string;
  name: string;
  description?: string;
}

/** Structured decision produced only by a successful DelegateWork tool call. */
export interface PetWorkDelegation {
  workspaceId: string;
  objective: string;
}

export interface PetWorkDelegationDecision {
  ok: boolean;
  error?: string;
}
