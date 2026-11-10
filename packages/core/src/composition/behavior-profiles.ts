import type { RunBehaviorProfile } from "../engine/run-types.js";

export const QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT = `# Side Conversation Boundary

This is a side conversation, not the main-thread task execution environment.
- Treat all content before this boundary as reference history only. Do not proactively continue any earlier plan, task, or modification.
- Default to answering the user's question directly. Use lightweight read-only exploration only when needed.
- Do not modify files, git state, configuration, or permissions unless the user explicitly asks after this boundary (for example, "Allow you to modify files, please help me..." or "Please directly edit..."). When explicitly requested, use the normally available tools subject to the current permission and approval mode.
- Sub-agents are disabled for this side conversation. Do not create or invoke sub-agents.`;

/** The side-conversation restriction expressed as a generic behavior profile. */
export const QUICK_CHAT_RESTRICTED_PROFILE: RunBehaviorProfile = {
  id: "quickChatRestricted",
  systemPromptAppend: QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT,
};

export const ISOLATED_TASK_BEHAVIOR_MODE = "isolatedTask" as const;

export const ISOLATED_TASK_SYSTEM_PROMPT = `# Isolated Task Boundary

This is a bounded Task, not a continuation of any user conversation.
- Use only the explicit Task input, the visible tool surface, and the selected Skill when one is available.
- Do not infer or search for prior Session history, persistent memory, unrelated Skills, or other projects.
- Do not create sub-agents or start unrelated work.
- Finish the requested outcome, then return a concise result suitable for the owning application.`;

/** Minimal, process-local run profile used by host-owned Tasks. */
export const ISOLATED_TASK_PROFILE: RunBehaviorProfile = {
  id: ISOLATED_TASK_BEHAVIOR_MODE,
  systemPromptAppend: ISOLATED_TASK_SYSTEM_PROMPT,
  disableMcp: true,
  disableInstructions: true,
  disableMemoryContext: true,
  disableCapabilityContext: true,
  disableSourcesContext: true,
  disableWorkspaceProfile: true,
  disableHooks: true,
  disableSessionTitle: true,
};
