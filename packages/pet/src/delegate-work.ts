import type { ToolDefinition } from "@cjhyy/code-shell-core/extension";
import {
  DELEGATE_WORK_TOOL_NAME,
  type PetDigitalHumanOption,
  type PetReusableSessionOption,
  type PetWorkspaceOption,
} from "./delegation.js";
import type { PetRunScopedServices } from "./profile.js";
import type { ToolContext, ToolVisibilityContext } from "@cjhyy/code-shell-core/extension";

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
        description:
          "Self-contained execution objective for the new Work Session, preserving the user's intent.",
      },
      session_id: {
        type: "string",
        description:
          "Optional exact opaque id from the reusable Session list. Omit to create a new Session.",
      },
      digital_human_id: {
        type: "string",
        description: "Exact digital-human id from the selected individual or team member list.",
      },
    },
    required: ["workspace_id", "objective"],
  },
};

/** Workspaces published for this run by the pet profile's buildVisibilityMeta. */
function visibleWorkspaces(ctx: ToolVisibilityContext): readonly PetWorkspaceOption[] {
  const workspaces = ctx.profileMeta?.petWorkspaces;
  return Array.isArray(workspaces) ? (workspaces as readonly PetWorkspaceOption[]) : [];
}

function visibleReusableSessions(ctx: ToolVisibilityContext): readonly PetReusableSessionOption[] {
  const sessions = ctx.profileMeta?.petReusableSessions;
  return Array.isArray(sessions) ? (sessions as readonly PetReusableSessionOption[]) : [];
}

function visibleDigitalHumans(ctx: ToolVisibilityContext): readonly PetDigitalHumanOption[] {
  const digitalHumans = ctx.profileMeta?.petDigitalHumans;
  return Array.isArray(digitalHumans) ? (digitalHumans as readonly PetDigitalHumanOption[]) : [];
}

/** Available only when the active run profile published at least one Workspace. */
export function delegateWorkAvailability(ctx: ToolVisibilityContext): boolean {
  return ctx.behaviorProfile === "pet" && visibleWorkspaces(ctx).length > 0;
}

function inlineDisplay(value: string, maximum: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/** Rewrite the static def with the run's closed workspace_id enum + listing. */
export function rewriteDelegateWorkDef(
  def: ToolDefinition,
  ctx: ToolVisibilityContext,
): ToolDefinition {
  const dynamic = delegateWorkToolDefFor(
    visibleWorkspaces(ctx),
    visibleReusableSessions(ctx),
    visibleDigitalHumans(ctx),
  );
  return { ...def, description: dynamic.description, inputSchema: dynamic.inputSchema };
}

export function delegateWorkToolDefFor(
  workspaces: readonly PetWorkspaceOption[] | undefined,
  reusableSessions: readonly PetReusableSessionOption[] | undefined = [],
  digitalHumans: readonly PetDigitalHumanOption[] | undefined = [],
): ToolDefinition {
  const available = workspaces ?? [];
  const sessions = reusableSessions ?? [];
  const humans = digitalHumans ?? [];
  const listing = available.length
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
  const humanListing = humans.length
    ? humans
        .map(
          (human) =>
            `- ${JSON.stringify(human.id)}: ${inlineDisplay(human.name, 256)}${
              human.description ? ` — ${inlineDisplay(human.description, 4_096)}` : ""
            }`,
        )
        .join("\n")
    : "- (no digital human was selected; omit digital_human_id)";
  const {
    session_id: _unboundedSessionId,
    digital_human_id: _unboundedDigitalHumanId,
    ...baseProperties
  } = delegateWorkToolDef.inputSchema.properties as Record<string, unknown>;
  return {
    ...delegateWorkToolDef,
    description: `${delegateWorkToolDef.description}\n\nAvailable Workspaces:\n${listing}\n\nSelected digital humans:\n${humanListing}\n\nReusable Sessions:\n${sessionListing}`,
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
                description:
                  "Optional exact opaque id from the reusable Session list. It must belong to workspace_id. Omit to create a new Session.",
              },
            }
          : {}),
        ...(humans.length > 0
          ? {
              digital_human_id: {
                type: "string",
                enum: humans.map((human) => human.id),
                description: "Required exact id from the selected digital-human/team member list.",
              },
            }
          : {}),
      },
      required: [
        ...((delegateWorkToolDef.inputSchema.required as string[] | undefined) ?? []),
        ...(humans.length > 0 ? ["digital_human_id"] : []),
      ],
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
  const digitalHumans = Array.isArray(services?.petDigitalHumans)
    ? services.petDigitalHumans
    : undefined;
  if (!services?.requestPetWorkDelegation || !workspaces || !reusableSessions || !digitalHumans) {
    return "Error: DelegateWork is available only in a Mimi manager turn.";
  }
  const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const objective = typeof args.objective === "string" ? args.objective.trim() : "";
  const reusableSessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  const digitalHumanId =
    typeof args.digital_human_id === "string" ? args.digital_human_id.trim() : "";
  if (!workspaceId) return "Error: workspace_id is required.";
  if (!objective) return "Error: objective is required.";
  if (objective.length > 8_000) return "Error: objective is too long (maximum 8000 characters).";

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
  const digitalHuman = digitalHumanId
    ? digitalHumans.find((candidate) => candidate?.id === digitalHumanId)
    : undefined;
  if (digitalHumans.length > 0 && !digitalHumanId) {
    return "Error: digital_human_id is required for the selected digital human or team.";
  }
  if (digitalHumanId && !digitalHuman) {
    return `Error: unknown digital_human_id ${JSON.stringify(digitalHumanId)}. Copy one exact id from the selected digital-human list.`;
  }
  const decision = services.requestPetWorkDelegation({
    workspaceId,
    objective,
    ...(digitalHuman ? { digitalHumanId: digitalHuman.id } : {}),
    ...(reusableSession ? { reusableSessionId: reusableSession.id } : {}),
  });
  if (!decision.ok) return `Error: ${decision.error ?? "work delegation was rejected"}`;
  const assignee = digitalHuman ? ` with digital human ${digitalHuman.name}` : "";
  return reusableSession
    ? `Delegation accepted for existing Session ${reusableSession.name} in Workspace ${workspace.name}${assignee}.`
    : `Delegation accepted for a new Session in Workspace ${workspace.name}${assignee}.`;
}
