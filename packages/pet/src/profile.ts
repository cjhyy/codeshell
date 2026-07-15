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
  type PetDigitalHumanOption,
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
- If the request needs execution work and the target Workspace is clear, call ${DELEGATE_WORK_TOOL_NAME} with an available workspace_id and a self-contained objective. Reuse one host-listed Session only when the new objective clearly continues that same thread; otherwise create a new Session by omitting session_id. The host will validate, create or resume, and start the Work Session; do not encode routing in ordinary text and do not ask the user to choose between chatting and delegating.
- When the host provides a selected digital human, delegate to that digital_human_id. When it provides a digital-human team, split independent work into clear assignments and call ${DELEGATE_WORK_TOOL_NAME} once per useful member; use the team's stated mode, run independent assignments in parallel, keep dependent work coherent, and leave unnecessary members idle.
- After ${DELEGATE_WORK_TOOL_NAME} succeeds, briefly confirm the delegation. Never claim delegation succeeded without a successful tool result.
- If the request can be answered from the bounded status or by management reasoning alone, answer it directly and do not call ${DELEGATE_WORK_TOOL_NAME}.
- Questions, complaints, or corrections about Mimi's own routing, delegation, workspace choice, or session behavior are management conversation. Address them directly and do not delegate unless the user separately asks for execution work.
- If essential scope is missing, ask one concise clarifying question and do not call ${DELEGATE_WORK_TOOL_NAME} yet.
- Never approve, answer, or construct decisions for another session.
- Never mutate a workspace, configuration, permission scope, or session ownership.
- Never claim a delegation or team run happened unless the corresponding tool call succeeded.
- Treat the normal permission gate as mandatory; Mimi identity grants no bypass.`;

export const PET_ALLOWED_TOOL_NAMES = new Set<string>([DELEGATE_WORK_TOOL_NAME]);

/** Shared key convention between the pet profile and the DelegateWork tool. */
export interface PetRunScopedServices {
  petWorkspaces: readonly PetWorkspaceOption[];
  petReusableSessions: readonly PetReusableSessionOption[];
  petDigitalHumans: readonly PetDigitalHumanOption[];
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

function digitalHumansFrom(
  profileParams: Readonly<Record<string, unknown>>,
): readonly PetDigitalHumanOption[] {
  return Array.isArray(profileParams.digitalHumans)
    ? (profileParams.digitalHumans as readonly PetDigitalHumanOption[])
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
    petDigitalHumans: digitalHumansFrom(profileParams),
  }),
  createRunServices: ({ profileParams, reportResult }) => {
    const delegated: PetWorkDelegation[] = [];
    const digitalHumans = digitalHumansFrom(profileParams);
    const services: PetRunScopedServices = {
      petWorkspaces: workspacesFrom(profileParams),
      petReusableSessions: reusableSessionsFrom(profileParams),
      petDigitalHumans: digitalHumans,
      requestPetWorkDelegation: (request) => {
        if (digitalHumans.length === 0 && delegated.length > 0) {
          return { ok: false, error: "only one delegation is allowed per Mimi turn" };
        }
        if (digitalHumans.length > 0) {
          if (delegated.length >= digitalHumans.length) {
            return { ok: false, error: "the selected team has no unassigned member slot" };
          }
          if (delegated.some((entry) => entry.digitalHumanId === request.digitalHumanId)) {
            return { ok: false, error: "each selected digital human can receive one assignment per turn" };
          }
        }
        delegated.push(request);
        if (digitalHumans.length > 0) {
          reportResult("workDelegations", [...delegated]);
          if (delegated.length === 1) reportResult("workDelegation", request);
        } else {
          reportResult("workDelegation", request);
        }
        return { ok: true };
      },
    };
    return services as unknown as Record<string, unknown>;
  },
};
