/**
 * The desktop Pet (Mimi) manager behavior, expressed as a generic
 * RunBehaviorProfile. This is the ONLY place in core that defines pet
 * behavior semantics — engine.ts, run-types.ts, dynamic-tool-defs.ts and the
 * tool-system apply it purely through the profile registry. Core registers
 * this profile by default for now; when the pet domain moves out to
 * packages/pet, hosts will register it via EngineConfig.behaviorProfiles /
 * ExtensionModule.behaviorProfiles instead.
 */
import type { RunBehaviorProfile } from "@cjhyy/code-shell-core/extension";
import {
  DELEGATE_WORK_TOOL_NAME,
  type PetWorkDelegation,
  type PetWorkDelegationDecision,
  type PetReusableSessionOption,
  type PetWorkspaceOption,
} from "./delegation.js";

export const PET_SYSTEM_PROMPT = `# Local Mimi Manager Boundary

You are Mimi, the user's local work manager and dispatcher, not an execution agent.
- Use only the bounded host-provided status to summarize work and help the user navigate to the original work session.
- Clarify goals, break work into coherent tasks, identify follow-ups, and decide automatically whether the user's message needs a separate execution session.
- All file inspection, research, code changes, commands, tests, and other execution belong in a separate work session. Never claim that you performed them.
- If the request needs execution work and the target Workspace is clear, call ${DELEGATE_WORK_TOOL_NAME} exactly once with an available workspace_id and a self-contained objective. Reuse one host-listed Session only when the new objective clearly continues that same thread; otherwise create a new Session by omitting session_id. The host will validate, create or resume, and start the Work Session; do not encode routing in ordinary text and do not ask the user to choose between chatting and delegating.
- After ${DELEGATE_WORK_TOOL_NAME} succeeds, briefly confirm the delegation. Never claim delegation succeeded without a successful tool result.
- If the request can be answered from the bounded status or by management reasoning alone, answer it directly and do not call ${DELEGATE_WORK_TOOL_NAME}.
- Questions, complaints, or corrections about Mimi's own routing, delegation, workspace choice, or session behavior are management conversation. Address them directly and do not delegate unless the user separately asks for execution work.
- If essential scope is missing, ask one concise clarifying question and do not call ${DELEGATE_WORK_TOOL_NAME} yet.
- Never approve, answer, or construct decisions for another session.
- Never mutate a workspace, configuration, permission scope, or session ownership.
- Never spawn agents, send directions, broadcast, or claim Team capabilities.
- Treat the normal permission gate as mandatory; Mimi identity grants no bypass.`;

export const PET_ALLOWED_TOOL_NAMES = new Set<string>([DELEGATE_WORK_TOOL_NAME]);

/** Shared key convention between the pet profile and the DelegateWork tool. */
export interface PetRunScopedServices {
  petWorkspaces: readonly PetWorkspaceOption[];
  petReusableSessions: readonly PetReusableSessionOption[];
  requestPetWorkDelegation: (request: PetWorkDelegation) => PetWorkDelegationDecision;
}

function workspacesFrom(
  profileParams: Readonly<Record<string, unknown>>,
): readonly PetWorkspaceOption[] {
  return Array.isArray(profileParams.workspaces)
    ? (profileParams.workspaces as readonly PetWorkspaceOption[])
    : [];
}

function reusableSessionsFrom(
  profileParams: Readonly<Record<string, unknown>>,
): readonly PetReusableSessionOption[] {
  return Array.isArray(profileParams.reusableSessions)
    ? (profileParams.reusableSessions as readonly PetReusableSessionOption[])
    : [];
}

export const PET_BEHAVIOR_PROFILE: RunBehaviorProfile = {
  id: "pet",
  systemPromptAppend: PET_SYSTEM_PROMPT,
  allowedToolNames: PET_ALLOWED_TOOL_NAMES,
  forcePermissionMode: "default",
  disablePlanMode: true,
  disableMcp: true,
  runtimeContextTag: "pet-world",
  runtimeContextHeading: "# Trusted Pet Runtime Context (non-durable)",
  activateForSessionKinds: ["pet"],
  buildVisibilityMeta: (profileParams) => ({
    petWorkspaces: workspacesFrom(profileParams),
    petReusableSessions: reusableSessionsFrom(profileParams),
  }),
  createRunServices: ({ profileParams, reportResult }) => {
    let delegated: PetWorkDelegation | undefined;
    const services: PetRunScopedServices = {
      petWorkspaces: workspacesFrom(profileParams),
      petReusableSessions: reusableSessionsFrom(profileParams),
      requestPetWorkDelegation: (request) => {
        if (delegated) {
          return { ok: false, error: "only one delegation is allowed per Mimi turn" };
        }
        delegated = request;
        reportResult("workDelegation", request);
        return { ok: true };
      },
    };
    return services as unknown as Record<string, unknown>;
  },
};
