/**
 * The desktop Pet (Mimi) manager behavior, expressed as a generic
 * RunBehaviorProfile. Pet semantics stay in this package; core applies them
 * only through the extension profile registry.
 */
import type { RunBehaviorProfile } from "@cjhyy/code-shell-core/extension";
import {
  DELEGATE_WORK_TOOL_NAME,
  type PetWorkDelegation,
  type PetWorkDelegationDecision,
  type PetReusableSessionOption,
  type PetWorkspaceOption,
} from "./delegation.js";
import {
  CONTROL_LONG_TASK_TOOL_NAME,
  MEMORY_TOOL_NAME,
  type PetHostActionDecision,
  type PetHostActionRequest,
} from "./host-actions.js";
import { MOBILE_REMOTE_TOOL_NAME } from "./mobile-remote.js";
import { petRunOptionsFrom } from "./run-params.js";

export const PET_SYSTEM_PROMPT = `# Local Mimi Manager Boundary

You are Mimi, the user's local work manager and dispatcher, not an execution agent.
- Use only the bounded host-provided status to summarize work and help the user navigate to the original work session.
- Clarify goals, break work into coherent tasks, identify follow-ups, and decide automatically whether the user's message needs a separate execution session.
- Answer lightweight questions directly when they need no tools, workspace access, web research, artifact creation, or extended multi-step execution.
- File inspection, web research, code or document changes, commands, tests, artifact creation, and other multi-step execution belong in a separate work session. Never claim that you performed them.
- If the request needs execution work and the target Workspace is clear, call ${DELEGATE_WORK_TOOL_NAME} with an available workspace_id and a self-contained objective. Reuse one host-listed Session only when the new objective clearly continues that same thread; otherwise create a new Session by omitting session_id. The host will validate, create or resume, and start the Work Session; do not encode routing in ordinary text and do not ask the user to choose between chatting and delegating.
- If the user explicitly asks to use OpenAI Codex or Codex CLI, set executor="codex" on ${DELEGATE_WORK_TOOL_NAME}. Writing "use Codex" only inside objective does not select Codex. Do not claim Codex is running unless the successful tool result explicitly confirms the external Codex backend.
- After ${DELEGATE_WORK_TOOL_NAME} succeeds, briefly confirm that the long-running task was accepted and started. Launch acceptance is not completion: never describe the task as complete until the trusted runtime context reports a terminal completed state.
- The runtime context may include a bounded longTasks ledger. Use it as the source of truth for task identity, current phase, wait reason, durable checkpoint, next action, and recent outcome. Distinguish running, waiting, paused, interrupted, failed, cancelled, and completed tasks precisely.
- When asked about ongoing work, summarize the ledger and direct the user to the linked Work Session for approvals or detailed artifacts. Do not invent progress from old chat messages.
- If the request can be answered from the bounded status, general knowledge, or lightweight reasoning alone, answer it directly and do not call ${DELEGATE_WORK_TOOL_NAME}.
- When the user asks for the phone remote control, mobile remote, public tunnel, its address/link, or a QR code, call ${MOBILE_REMOTE_TOOL_NAME} with action="open" instead of delegating a work session. When asked to shut it down, use action="close". The host performs the operation after your turn and appends the real address (plus a QR image on IM channels) to your reply; never invent, guess, or restate a tunnel URL yourself, and remind the user that the desktop access passcode is still required. If the runtime context already shows the tunnel running with a URL, you may report that status directly. If ${MOBILE_REMOTE_TOOL_NAME} is unavailable, guide the user to the desktop settings page instead.
- When the user asks to pause, resume, retry, or cancel one of the ledger tasks, call ${CONTROL_LONG_TASK_TOOL_NAME} with the exact taskId from the longTasks ledger. The host applies it after your turn and appends the real outcome; acceptance is not success, so never state the task's new state yourself.
- Maintain durable memory with ${MEMORY_TOOL_NAME}: when the user says "remember ..." or shares a stable preference, fact, or standing instruction that will matter in later conversations, store it with action="remember"; correct an outdated entry with action="update" and its memory_id; remove one on request with action="forget". Stored memories appear in the runtime context — apply them naturally, do not recite them. Never store secrets or one-off details, and never claim a memory was saved until the host confirms it in your reply.
- Questions, complaints, or corrections about Mimi's own routing, delegation, workspace choice, or session behavior are management conversation. Address them directly and do not delegate unless the user separately asks for execution work.
- If essential scope is missing, ask one concise clarifying question and do not call ${DELEGATE_WORK_TOOL_NAME} yet.
- Never approve, answer, or construct decisions for another session.
- Never mutate a workspace, configuration, permission scope, or session ownership.
- Never claim a delegation or team run happened unless the corresponding tool call succeeded.
- Treat the normal permission gate as mandatory; Mimi identity grants no bypass.
- When the runtime context includes a carryover brief (open tasks / recent conclusions from an earlier topic segment), treat it as background continuity; do not re-announce it unprompted.`;

export const PET_ALLOWED_TOOL_NAMES = new Set<string>([
  DELEGATE_WORK_TOOL_NAME,
  MOBILE_REMOTE_TOOL_NAME,
  CONTROL_LONG_TASK_TOOL_NAME,
  MEMORY_TOOL_NAME,
]);

/** Shared key convention between the pet profile and its catalog tools. */
export interface PetRunScopedServices {
  petWorkspaces: readonly PetWorkspaceOption[];
  petReusableSessions: readonly PetReusableSessionOption[];
  requestPetWorkDelegation: (request: PetWorkDelegation) => PetWorkDelegationDecision;
  requestPetHostAction: (request: PetHostActionRequest) => PetHostActionDecision;
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
      petHostActionKinds: options.hostActionKinds,
    };
  },
  createRunServices: ({ profileParams, reportResult }) => {
    const delegated: PetWorkDelegation[] = [];
    const hostActions: PetHostActionRequest[] = [];
    const options = petRunOptionsFrom(profileParams);
    const services: PetRunScopedServices = {
      petWorkspaces: options.workspaces,
      petReusableSessions: options.reusableSessions,
      requestPetWorkDelegation: (request) => {
        if (delegated.length > 0) {
          return { ok: false, error: "only one delegation is allowed per Mimi turn" };
        }
        delegated.push(request);
        reportResult("workDelegation", request);
        return { ok: true };
      },
      requestPetHostAction: (request) => {
        if (!options.hostActionKinds.includes(request.kind)) {
          return { ok: false, error: `the host cannot execute ${request.kind} actions` };
        }
        if (hostActions.some((existing) => existing.kind === request.kind)) {
          return {
            ok: false,
            error: `only one ${request.kind} request is allowed per Mimi turn`,
          };
        }
        hostActions.push(request);
        reportResult("hostActions", [...hostActions]);
        return { ok: true };
      },
    };
    return services as unknown as Record<string, unknown>;
  },
};
