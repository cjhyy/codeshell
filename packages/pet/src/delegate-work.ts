import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import {
  DELEGATE_WORK_TOOL_NAME,
  isPetWorkExecutionBackend,
  PET_WORK_EXECUTION_BACKENDS,
  type PetReusableSessionOption,
  type PetWorkspaceOption,
} from "./delegation.js";
import type { PetRunScopedServices } from "./profile.js";

export const delegateWorkToolDef: ToolDefinition = {
  name: DELEGATE_WORK_TOOL_NAME,
  description:
    "Delegate one execution objective to exactly one host-provided Workspace. " +
    "Use only as Mimi after deciding that the user's request requires execution. " +
    "workspace_id must be copied exactly from the available Workspace list.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: {
        type: "string",
        description: "Exact opaque Workspace id from the host-provided list.",
      },
      objective: {
        type: "string",
        description: "Self-contained objective for the Work Session.",
      },
      executor: {
        type: "string",
        enum: [...PET_WORK_EXECUTION_BACKENDS],
        description:
          "Execution backend. Use 'codex' only when the user explicitly asks for OpenAI Codex/Codex CLI; do not merely write 'Codex' in objective. Omit or use 'codeshell' for a normal Work Session.",
      },
      session_id: {
        type: "string",
        description: "Optional exact id from the reusable Session list.",
      },
    },
    required: ["workspace_id", "objective"],
  },
};

function visibleWorkspaces(ctx: ToolVisibilityContext): readonly PetWorkspaceOption[] {
  const workspaces = ctx.profileMeta?.petWorkspaces;
  return Array.isArray(workspaces) ? (workspaces as readonly PetWorkspaceOption[]) : [];
}

function visibleReusableSessions(ctx: ToolVisibilityContext): readonly PetReusableSessionOption[] {
  const sessions = ctx.profileMeta?.petReusableSessions;
  return Array.isArray(sessions) ? (sessions as readonly PetReusableSessionOption[]) : [];
}

export function delegateWorkAvailability(ctx: ToolVisibilityContext): boolean {
  return ctx.behaviorProfile === "pet" && visibleWorkspaces(ctx).length > 0;
}

function inlineDisplay(value: string, maximum: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

export function rewriteDelegateWorkDef(
  def: ToolDefinition,
  ctx: ToolVisibilityContext,
): ToolDefinition {
  const dynamic = delegateWorkToolDefFor(visibleWorkspaces(ctx), visibleReusableSessions(ctx));
  return { ...def, description: dynamic.description, inputSchema: dynamic.inputSchema };
}

export function delegateWorkToolDefFor(
  workspaces: readonly PetWorkspaceOption[] | undefined,
  reusableSessions: readonly PetReusableSessionOption[] | undefined = [],
): ToolDefinition {
  const available = workspaces ?? [];
  const sessions = reusableSessions ?? [];
  const workspaceListing = available.length
    ? available
        .map(
          (workspace) =>
            `- ${JSON.stringify(workspace.id)}: ${inlineDisplay(workspace.name, 256)}${
              workspace.description ? ` — ${inlineDisplay(workspace.description, 4_096)}` : ""
            }`,
        )
        .join("\n")
    : "- (no Workspace is currently available)";
  const sessionListing = sessions.length
    ? sessions
        .map(
          (session) =>
            `- ${JSON.stringify(session.id)}: ${inlineDisplay(session.name, 256)} (Workspace ${JSON.stringify(session.workspaceId)})${
              session.description ? ` — ${inlineDisplay(session.description, 4_096)}` : ""
            }`,
        )
        .join("\n")
    : "- (no existing Session is currently eligible for reuse; omit session_id)";
  const { session_id: _sessionId, ...baseProperties } = delegateWorkToolDef.inputSchema
    .properties as Record<string, unknown>;
  return {
    ...delegateWorkToolDef,
    description: `${delegateWorkToolDef.description}\n\nAvailable Workspaces:\n${workspaceListing}\n\nReusable Sessions:\n${sessionListing}`,
    inputSchema: {
      ...delegateWorkToolDef.inputSchema,
      properties: {
        ...baseProperties,
        workspace_id: {
          type: "string",
          enum: available.map((workspace) => workspace.id),
          description: "Exact opaque Workspace id from the available list.",
        },
        ...(sessions.length > 0
          ? {
              session_id: {
                type: "string",
                enum: sessions.map((session) => session.id),
                description: "Optional exact id from the reusable Session list.",
              },
            }
          : {}),
      },
    },
  };
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
  const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const objective = typeof args.objective === "string" ? args.objective.trim() : "";
  const executor = args.executor === undefined ? "codeshell" : args.executor;
  const reusableSessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!workspaceId) return "Error: workspace_id is required.";
  if (!objective) return "Error: objective is required.";
  if (objective.length > 8_000) return "Error: objective is too long (maximum 8000 characters).";
  if (!isPetWorkExecutionBackend(executor)) {
    return `Error: unknown executor ${JSON.stringify(executor)}. Use ${PET_WORK_EXECUTION_BACKENDS.map(
      (backend) => JSON.stringify(backend),
    ).join(" or ")}.`;
  }

  const workspace = workspaces.find((candidate) => candidate?.id === workspaceId);
  if (!workspace) {
    return `Error: unknown workspace_id ${JSON.stringify(workspaceId)}. Copy one exact id from the available Workspace list.`;
  }
  const reusableSession = reusableSessionId
    ? reusableSessions.find((candidate) => candidate?.id === reusableSessionId)
    : undefined;
  if (reusableSessionId && !reusableSession) {
    return `Error: unknown session_id ${JSON.stringify(reusableSessionId)}. Copy one exact id from the reusable Session list or omit session_id.`;
  }
  if (reusableSession && reusableSession.workspaceId !== workspaceId) {
    return "Error: session_id does not belong to workspace_id.";
  }
  const decision = services.requestPetWorkDelegation({
    workspaceId,
    objective,
    ...(executor === "codex" ? { executionBackend: "codex" as const } : {}),
    ...(reusableSession ? { reusableSessionId: reusableSession.id } : {}),
  });
  if (!decision.ok) return `Error: ${decision.error ?? "work delegation was rejected"}`;
  const backend = executor === "codex" ? " using external Codex" : "";
  return reusableSession
    ? `Delegation accepted for existing Session ${reusableSession.name} in Workspace ${workspace.name}${backend}.`
    : `Delegation accepted for a new Session in Workspace ${workspace.name}${backend}.`;
}
