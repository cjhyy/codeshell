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
  /** Mimi's explicit continuity judgment, grounded in the selected host candidate. */
  continuationEvidence?: PetSessionContinuationEvidence;
}

export interface PetSessionContinuationEvidence {
  /** Exact displayed name of the prior concrete work thread. */
  priorThread: string;
  /** Why this objective continues that thread and needs its existing context or state. */
  reason: string;
}

export interface PetWorkSessionDecision {
  mode: "new" | "reuse";
  reason:
    | "new_work"
    | "grounded_continuation"
    | "missing_continuation_evidence"
    | "invalid_continuation_evidence"
    | "unmatched_prior_thread";
  requestedSessionId?: string;
  reusableSessionId?: string;
}

export interface PetWorkDelegationDecision {
  ok: boolean;
  error?: string;
  sessionDecision?: PetWorkSessionDecision;
}

export type PetWorkDelegationNormalization =
  | { ok: true; delegation: PetWorkDelegation; sessionDecision: PetWorkSessionDecision }
  | { ok: false; error: string };

/** Keep evidence grounding identical to the bounded candidate labels shown to Mimi. */
export function petDelegationDisplay(value: string, maximum: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/**
 * Reuse is an affirmative, grounded model judgment, never an inference from a
 * valid selector. This gate verifies the evidence contract, not topic similarity;
 * independent tool, profile, and host callers must all use the same decision.
 */
export function normalizePetWorkDelegation(
  request: PetWorkDelegation,
  reusableSessions: readonly PetReusableSessionOption[],
): PetWorkDelegationNormalization {
  const { reusableSessionId, continuationEvidence, ...newDelegation } = request;
  const newSession = (
    reason: PetWorkSessionDecision["reason"],
  ): PetWorkDelegationNormalization => ({
    ok: true,
    delegation: newDelegation,
    sessionDecision: {
      mode: "new",
      reason,
      ...(reusableSessionId ? { requestedSessionId: reusableSessionId } : {}),
    },
  });
  if (reusableSessionId === undefined) return newSession("new_work");
  if (
    typeof reusableSessionId !== "string" ||
    !reusableSessionId ||
    reusableSessionId !== reusableSessionId.trim()
  ) {
    return { ok: false, error: "session_id must be one exact non-blank reusable Session id." };
  }
  const candidate = reusableSessions.find((session) => session.id === reusableSessionId);
  if (!candidate) {
    return {
      ok: false,
      error: `unknown session_id ${JSON.stringify(reusableSessionId)}. Copy one exact id from the reusable Session list.`,
    };
  }
  if (candidate.workspaceId !== request.workspaceId) {
    return {
      ok: false,
      error:
        `session_id ${JSON.stringify(reusableSessionId)} belongs to Workspace ` +
        `${JSON.stringify(candidate.workspaceId)}, not ${JSON.stringify(request.workspaceId)}. ` +
        "Do not send this pair again. Omit session_id for new work or use the Session's Workspace.",
    };
  }
  if (continuationEvidence === undefined) return newSession("missing_continuation_evidence");
  if (
    !continuationEvidence ||
    typeof continuationEvidence !== "object" ||
    Array.isArray(continuationEvidence) ||
    Object.keys(continuationEvidence).some((key) => key !== "priorThread" && key !== "reason") ||
    typeof continuationEvidence.priorThread !== "string" ||
    !continuationEvidence.priorThread.trim() ||
    continuationEvidence.priorThread.length > 4_096 ||
    typeof continuationEvidence.reason !== "string" ||
    !continuationEvidence.reason.trim() ||
    continuationEvidence.reason.length > 2_000
  ) {
    return newSession("invalid_continuation_evidence");
  }
  const priorThread = petDelegationDisplay(continuationEvidence.priorThread, 4_096);
  if (petDelegationDisplay(candidate.name, 256) !== priorThread) {
    return newSession("unmatched_prior_thread");
  }
  return {
    ok: true,
    delegation: {
      ...newDelegation,
      reusableSessionId,
      continuationEvidence: { priorThread, reason: continuationEvidence.reason.trim() },
    },
    sessionDecision: {
      mode: "reuse",
      reason: "grounded_continuation",
      requestedSessionId: reusableSessionId,
      reusableSessionId,
    },
  };
}
