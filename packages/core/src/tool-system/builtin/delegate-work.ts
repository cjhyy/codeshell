import type { ToolDefinition } from "../../types.js";
import { DELEGATE_WORK_TOOL_NAME, type PetWorkspaceOption } from "../../pet/delegation.js";
import type { ToolContext } from "../context.js";

export const delegateWorkToolDef: ToolDefinition = {
  name: DELEGATE_WORK_TOOL_NAME,
  description:
    "Delegate one execution objective to exactly one host-provided Workspace. " +
    "Use only as Mimi after deciding that the user's request requires execution. " +
    "workspace_id must be copied exactly from the available Workspace list.",
  inputSchema: {
    type: "object",
    properties: {
      workspace_id: {
        type: "string",
        description: "Exact opaque Workspace id from the host-provided list.",
      },
      objective: {
        type: "string",
        description:
          "Self-contained execution objective for the new Work Session, preserving the user's intent.",
      },
    },
    required: ["workspace_id", "objective"],
  },
};

export function delegateWorkToolDefFor(
  workspaces: readonly PetWorkspaceOption[] | undefined,
): ToolDefinition {
  const available = workspaces ?? [];
  const listing = available.length
    ? available
        .map(
          (workspace) =>
            `- ${workspace.id}: ${workspace.name}${workspace.description ? ` — ${workspace.description}` : ""}`,
        )
        .join("\n")
    : "- (no Workspace is currently available)";
  return {
    ...delegateWorkToolDef,
    description: `${delegateWorkToolDef.description}\n\nAvailable Workspaces:\n${listing}`,
    inputSchema: {
      ...delegateWorkToolDef.inputSchema,
      properties: {
        ...(delegateWorkToolDef.inputSchema.properties as Record<string, unknown>),
        workspace_id: {
          type: "string",
          enum: available.map((workspace) => workspace.id),
          description: "Exact opaque Workspace id from the available list.",
        },
      },
    },
  };
}

export async function delegateWorkTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  if (!ctx?.requestPetWorkDelegation || !ctx.petWorkspaces) {
    return "Error: DelegateWork is available only in a Mimi manager turn.";
  }
  const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const objective = typeof args.objective === "string" ? args.objective.trim() : "";
  if (!workspaceId) return "Error: workspace_id is required.";
  if (!objective) return "Error: objective is required.";
  if (objective.length > 8_000) return "Error: objective is too long (maximum 8000 characters).";

  const workspace = ctx.petWorkspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return `Error: unknown workspace_id ${JSON.stringify(workspaceId)}. Copy one exact id from the available Workspace list.`;
  }
  const decision = ctx.requestPetWorkDelegation({ workspaceId, objective });
  if (!decision.ok) return `Error: ${decision.error ?? "work delegation was rejected"}`;
  return `Delegation accepted for Workspace ${workspace.name}.`;
}
