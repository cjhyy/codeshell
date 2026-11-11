import type { ToolContext } from "./context.js";
import type { SettingsScope } from "../settings/manager.js";

export interface ToolVisibilityInputs {
  cwd: string;
  contextStrategy?: "summary" | "notes";
  workspace?: ToolContext["workspace"];
  hasGoal: boolean;
  sessionId?: string;
  settingsScope?: SettingsScope;
  /** Host identity a guard may require, e.g. Panel needs `"desktop"`. */
  host?: string;
  hasBrowserAutomation?: boolean;
  isSubAgent?: boolean;
  rootSessionId?: string;
  behaviorProfile?: string;
  sessionMessageTargets?: readonly import("../session/session-message.js").SessionMessageTarget[];
  profileMeta?: Readonly<Record<string, unknown>>;
}

/**
 * Build the availability-guard context for a tool surface.
 *
 * Extracted from {@link assembleRunToolDefs} so it is callable on its own. It
 * matters that this has exactly one implementation: the executor SKIPS its
 * visibility gate when `toolCtx.toolVisibility` is absent, so a caller that
 * forgets to populate it doesn't just under-expose tools — it makes host-gated
 * tools callable in contexts their guards were written to exclude.
 *
 * Optional keys are omitted rather than set to `undefined`: guards use
 * `!== true` / `?? 0` style checks, and an empty `sessionMessageTargets` must not
 * read as "the host authorized targets".
 */
export function buildToolVisibility(
  inputs: ToolVisibilityInputs,
): import("./context.js").ToolVisibilityContext {
  return {
    cwd: inputs.cwd,
    ...(inputs.contextStrategy ? { contextStrategy: inputs.contextStrategy } : {}),
    ...(inputs.workspace ? { workspace: inputs.workspace } : {}),
    hasGoal: inputs.hasGoal,
    ...(inputs.sessionId ? { sessionId: inputs.sessionId } : {}),
    ...(inputs.settingsScope ? { settingsScope: inputs.settingsScope } : {}),
    ...(inputs.host !== undefined ? { host: inputs.host } : {}),
    ...(inputs.hasBrowserAutomation !== undefined
      ? { hasBrowserAutomation: inputs.hasBrowserAutomation }
      : {}),
    ...(inputs.isSubAgent !== undefined ? { isSubAgent: inputs.isSubAgent } : {}),
    ...(inputs.rootSessionId ? { rootSessionId: inputs.rootSessionId } : {}),
    ...(inputs.behaviorProfile !== undefined ? { behaviorProfile: inputs.behaviorProfile } : {}),
    ...(inputs.sessionMessageTargets?.length
      ? { sessionMessageTargets: inputs.sessionMessageTargets }
      : {}),
    ...(inputs.profileMeta ? { profileMeta: inputs.profileMeta } : {}),
  };
}
