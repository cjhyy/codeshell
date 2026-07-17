/**
 * The desktop Pet (Mimi) manager behavior, expressed as a generic
 * RunBehaviorProfile. Pet semantics stay in this package; core applies them
 * only through the extension profile registry.
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
import { petRunOptionsFrom } from "./run-params.js";

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
- Treat the normal permission gate as mandatory; Mimi identity grants no bypass.
- When the runtime context includes a carryover brief (open tasks / recent conclusions from an earlier topic segment), treat it as background continuity; do not re-announce it unprompted.`;

export const PET_ALLOWED_TOOL_NAMES = new Set<string>([DELEGATE_WORK_TOOL_NAME]);

/** Shared key convention between the pet profile and the DelegateWork tool. */
export interface PetRunScopedServices {
  petWorkspaces: readonly PetWorkspaceOption[];
  petReusableSessions: readonly PetReusableSessionOption[];
  petDigitalHumans: readonly PetDigitalHumanOption[];
  requestPetWorkDelegation: (request: PetWorkDelegation) => PetWorkDelegationDecision;
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
  buildVisibilityMeta: (profileParams) => {
    const options = petRunOptionsFrom(profileParams);
    return {
      petWorkspaces: options.workspaces,
      petReusableSessions: options.reusableSessions,
      petDigitalHumans: options.digitalHumans,
    };
  },
  createRunServices: ({ profileParams, reportResult }) => {
    const delegated: PetWorkDelegation[] = [];
    const options = petRunOptionsFrom(profileParams);
    const digitalHumans = options.digitalHumans;
    const services: PetRunScopedServices = {
      petWorkspaces: options.workspaces,
      petReusableSessions: options.reusableSessions,
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
            return {
              ok: false,
              error: "each selected digital human can receive one assignment per turn",
            };
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
