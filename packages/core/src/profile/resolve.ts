/**
 * “当前激活的是谁 + 它的活字段”的唯一入口。除 overrides 折叠
 * （读 settings 持久化快照，见 overlay.ts）之外，任何代码不得自行读
 * profile.active 拼路径。Session 绑定的 profile 显式优先于项目默认，
 * 让同一项目内的 PM / UI / 工程 Session 可以各自持有稳定数字人身份。
 */
import { logger } from "../logging/logger.js";
import type { SettingsManager } from "../settings/manager.js";
import type { WorkspaceProfileSubtree } from "./activation.js";
import { readWorkspaceProfile } from "./store.js";
import type { WorkspaceProfile } from "./types.js";

export interface ResolveActiveWorkspaceProfileInput {
  /** Session-bound digital-human profile; wins over the project default. */
  sessionProfile?: string;
  cwd: string;
  settings: SettingsManager;
}

function readSubtree(settings: SettingsManager, cwd: string): WorkspaceProfileSubtree | undefined {
  try {
    return settings.getForScope("project", cwd).profile as WorkspaceProfileSubtree | undefined;
  } catch {
    return undefined;
  }
}

export function resolveActiveWorkspaceProfile(
  input: ResolveActiveWorkspaceProfileInput,
): WorkspaceProfile | undefined {
  return resolveActiveWorkspaceProfileSelection(input).profile;
}

/** Retains an unavailable selected identity so authorization callers can fail closed. */
export function resolveActiveWorkspaceProfileSelection(input: ResolveActiveWorkspaceProfileInput): {
  name?: string;
  profile?: WorkspaceProfile;
} {
  const name = input.sessionProfile ?? readSubtree(input.settings, input.cwd)?.active;
  if (!name) return {};
  let workspaceProfile: WorkspaceProfile | undefined;
  try {
    workspaceProfile = readWorkspaceProfile(name);
  } catch (error) {
    logger.warn("profile.active_invalid", {
      cat: "profile",
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { name };
  }
  if (!workspaceProfile) {
    logger.warn("profile.active_missing_from_library", { cat: "profile", name });
  }
  return { name, ...(workspaceProfile ? { profile: workspaceProfile } : {}) };
}

/** preset 解析用的快照读取（优先级：agent.preset > 本值 > capability 默认）。 */
export function workspaceProfilePresetFor(
  settings: SettingsManager,
  cwd: string,
): string | undefined {
  return readSubtree(settings, cwd)?.preset;
}
