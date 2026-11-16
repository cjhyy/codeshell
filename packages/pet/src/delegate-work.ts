import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import {
  DELEGATE_WORK_TOOL_NAME,
  isPetWorkExecutionBackend,
  normalizePetWorkDelegation,
  type PetSessionContinuationEvidence,
} from "./delegation.js";
import type { PetRunScopedServices } from "./profile.js";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

// Keep the wire/domain type forward-compatible with persisted "codex"
// decisions, but advertise only backends the current host actually launches.
const SUPPORTED_DELEGATE_WORK_BACKENDS = ["codeshell"] as const;

export const delegateWorkToolDef: ToolDefinition = {
  name: DELEGATE_WORK_TOOL_NAME,
  description:
    "Delegate one execution objective to exactly one host-provided Workspace. " +
    "Use only as Mimi after deciding that the user's request requires execution. " +
    "Before calling, decide whether this is the same concrete work thread as one reusable Session. " +
    "Reuse requires session_id and session_continuation identifying that prior work and explaining why this objective continues it. " +
    "An explicit session_id without grounded continuation evidence is rejected; it never creates a replacement Session. " +
    "Titles may describe old work: inspect recent request/result data and use Sessions search/describe before dismissing a possible continuation. " +
    "A shared Workspace, URL, filename, entity, or broad topic alone does not prove continuity. " +
    "If the user asked for a new Session, omit session_id regardless of how continuous the work looks. " +
    "The available Workspaces are the workspaces entries of the trusted runtime context; copy workspace_id exactly from one of them. " +
    "Reusable Session candidates are the reusableSessions entries there, each naming its Workspace; being listed is not a reason to reuse a Session.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: {
        type: "string",
        description: "Exact opaque id of one workspaces entry from the trusted runtime context.",
      },
      objective: {
        type: "string",
        description:
          "Faithful, self-contained objective for the Work Session. Preserve the user's inputs, permissions, and explicit constraints; do not invent new restrictions. For read-only web research, do not forbid saved authenticated access unless the user explicitly did so: prohibit new registration or asking the user to log in again while allowing a matching saved login through normal credential gates.",
      },
      executor: {
        type: "string",
        enum: [...SUPPORTED_DELEGATE_WORK_BACKENDS],
        description:
          "Execution backend. Omit or use 'codeshell' for a normal Work Session. External Codex execution is not supported by this host and must never be substituted silently.",
      },
      session_id: {
        type: "string",
        description:
          "Optional exact id of one reusableSessions entry from the trusted runtime context, in the same Workspace as workspace_id. Pass it only after deciding this objective clearly continues that Session; omit it for new or uncertain work, whenever the user asked to start a new Session, and when no reusable Session is listed. The host never infers an omitted id.",
      },
      session_continuation: {
        type: "object",
        additionalProperties: false,
        properties: {
          prior_thread: {
            type: "string",
            maxLength: 4_096,
            description:
              "Quote the selected candidate's entire displayed name identifying its prior work thread. Do not invent a summary or quote only a shared topic.",
          },
          reason: {
            type: "string",
            maxLength: 2_000,
            description:
              "Explain why the current objective continues, corrects, or retries that specific prior work, including which existing context, state, or artifact is needed. A shared Workspace or topic is insufficient.",
          },
        },
        required: ["prior_thread", "reason"],
        description:
          "Mimi's explicit evidence for reusing session_id. For new or uncertain work omit session_id and session_continuation together. Reusing session_id without grounded evidence is rejected; the host never silently creates a replacement Session.",
      },
    },
    required: ["workspace_id", "objective"],
  },
};

export function delegateWorkAvailability(ctx: ToolVisibilityContext): boolean {
  return ctx.behaviorProfile === "pet";
}

export async function delegateWorkTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const services = ctx?.runScopedServices as Partial<PetRunScopedServices> | undefined;
  const workspaces = Array.isArray(services?.petWorkspaces) ? services.petWorkspaces : undefined;
  const reusableSessions = Array.isArray(services?.petReusableSessions)
    ? services.petReusableSessions
    : undefined;
  if (!services?.requestPetWorkDelegation || !workspaces || !reusableSessions) {
    return "Error: DelegateWork is available only in a Mimi manager turn.";
  }
  if (
    !hasOnlyDeclaredToolArguments(args, [
      "workspace_id",
      "objective",
      "executor",
      "session_id",
      "session_continuation",
    ])
  ) {
    return "Error: DelegateWork accepts only workspace_id, objective, executor, session_id, and session_continuation.";
  }
  const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const objective = typeof args.objective === "string" ? args.objective.trim() : "";
  const executor = args.executor === undefined ? "codeshell" : args.executor;
  const reusableSessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!workspaceId) return "Error: workspace_id is required.";
  if (args.workspace_id !== workspaceId) {
    return "Error: workspace_id must be copied exactly from the available Workspace list.";
  }
  if (
    args.session_id !== undefined &&
    (!reusableSessionId || args.session_id !== reusableSessionId)
  ) {
    return (
      "Error: session_id must be one exact non-blank reusable Session id. " +
      "For a continuation, copy the existing Session id; omit session_id only to request new work."
    );
  }
  if (!objective) return "Error: objective is required.";
  if (objective.length > 8_000) return "Error: objective is too long (maximum 8000 characters).";
  if (executor === "codex") {
    return "Error: the external Codex execution backend is not supported yet; do not substitute a CodeShell Work Session.";
  }
  if (!isPetWorkExecutionBackend(executor)) {
    return `Error: unknown executor ${JSON.stringify(executor)}. Use ${SUPPORTED_DELEGATE_WORK_BACKENDS.map(
      (backend) => JSON.stringify(backend),
    ).join(" or ")}.`;
  }

  const workspace = workspaces.find((candidate) => candidate?.id === workspaceId);
  if (!workspace) {
    return `Error: unknown workspace_id ${JSON.stringify(workspaceId)}. Copy one exact id from workspaces: ${
      workspaces.length
        ? workspaces.map((candidate) => JSON.stringify(candidate.id)).join(", ")
        : "(none available this turn)"
    }.`;
  }
  const reusableSession = reusableSessionId
    ? reusableSessions.find((candidate) => candidate?.id === reusableSessionId)
    : undefined;
  if (reusableSessionId && !reusableSession) {
    return (
      `Error: unknown session_id ${JSON.stringify(reusableSessionId)}. ` +
      "Do not send it again. Identify the intended Session and copy its exact eligible id. " +
      "If the user asked to continue existing work, do not silently create a replacement. " +
      "Omit session_id only when the user's request calls for independent new work or explicitly asks for a new Session."
    );
  }
  if (reusableSession && reusableSession.workspaceId !== workspaceId) {
    // A bare "does not belong" is a dead end: the model has no action to take
    // and re-sends the same pair. Name both halves and the two ways out, so
    // the next call is a correction rather than a repeat.
    return (
      `Error: session_id ${JSON.stringify(reusableSessionId)} belongs to Workspace ` +
      `${JSON.stringify(reusableSession.workspaceId)}, not ${JSON.stringify(workspaceId)}. ` +
      "Do not send this pair again. Inspect the intended Session and correct the selector, or set workspace_id to " +
      `${JSON.stringify(reusableSession.workspaceId)} to continue this Session. ` +
      "A rejected continuation does not authorize creating a replacement Session."
    );
  }
  const evidence = args.session_continuation;
  const evidenceRecord =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : undefined;
  const continuationEvidence =
    evidenceRecord &&
    Object.keys(evidenceRecord).every((key) => key === "prior_thread" || key === "reason")
      ? ({
          priorThread: evidenceRecord.prior_thread,
          reason: evidenceRecord.reason,
        } as PetSessionContinuationEvidence)
      : { priorThread: "", reason: "" };
  const normalized = normalizePetWorkDelegation(
    {
      workspaceId,
      objective,
      ...(executor === "codex" ? { executionBackend: "codex" as const } : {}),
      ...(reusableSession ? { reusableSessionId: reusableSession.id } : {}),
      ...(evidence !== undefined ? { continuationEvidence } : {}),
    },
    reusableSessions,
  );
  if (!normalized.ok) return `Error: ${normalized.error}`;
  const decision = services.requestPetWorkDelegation(normalized.delegation);
  if (!decision.ok) return `Error: ${decision.error ?? "work delegation was rejected"}`;
  const sessionDecision =
    decision.sessionDecision && decision.sessionDecision.mode !== normalized.sessionDecision.mode
      ? decision.sessionDecision
      : normalized.sessionDecision;
  return JSON.stringify({
    status: "accepted",
    launchStatus: "pending",
    workspace: { id: workspace.id, name: workspace.name },
    objective,
    session: {
      ...sessionDecision,
      ...(sessionDecision.mode === "reuse" && reusableSession
        ? { name: reusableSession.name }
        : {}),
    },
  });
}
