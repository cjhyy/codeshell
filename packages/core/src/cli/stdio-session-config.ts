import type { EngineConfigSlice } from "../protocol/chat-session-manager.js";
import { noRepoDir } from "../settings/manager.js";
import type { ValidatedSettings } from "../settings/schema.js";

/** Protocol overrides win; otherwise session engines inherit disk settings. */
export function resolveSessionAgentConfig(slice: EngineConfigSlice, settings: ValidatedSettings) {
  return {
    preset: slice.preset ?? settings.agent.preset ?? settings.profile?.preset,
    customSystemPrompt: slice.customSystemPrompt ?? settings.agent.customSystemPrompt,
    appendSystemPrompt: slice.appendSystemPrompt ?? settings.agent.appendSystemPrompt,
  };
}

/**
 * A slice without cwd represents a no-project chat. Never inherit the long-lived
 * worker's boot cwd: that would select a stale project's files and bypass the
 * no-repo skill/plugin visibility rules.
 */
export function resolveSessionCwd(slice: EngineConfigSlice): string {
  return slice.cwd ?? noRepoDir();
}
