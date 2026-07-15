/**
 * “当前激活的是谁 + 它的活字段”的唯一入口。除 overrides 折叠
 * （读 settings 持久化快照，见 overlay.ts）之外，任何代码不得自行读
 * profile.active 拼路径 —— 后续加 per-session 绑定时只改这里。
 * sessionProfile 本期恒为 undefined（预留缝，与 pet 的 behaviorMode
 * 同样走 RunParams 的模式在第二阶段接入）。
 */
import { logger } from "../logging/logger.js";
import type { SettingsManager } from "../settings/manager.js";
import type { WorkspaceProfileSubtree } from "./activation.js";
import { readWorkspaceProfile } from "./store.js";
import type { WorkspaceProfile } from "./types.js";

export interface ResolveActiveWorkspaceProfileInput {
  /** 未来 per-session 绑定的入口；本期调用方一律不传。 */
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
  const name = input.sessionProfile ?? readSubtree(input.settings, input.cwd)?.active;
  if (!name) return undefined;
  let workspaceProfile: WorkspaceProfile | undefined;
  try {
    workspaceProfile = readWorkspaceProfile(name);
  } catch (error) {
    logger.warn("profile.active_invalid", {
      cat: "profile",
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (!workspaceProfile) {
    logger.warn("profile.active_missing_from_library", { cat: "profile", name });
  }
  return workspaceProfile;
}

/** preset 解析用的快照读取（优先级：agent.preset > 本值 > capability 默认）。 */
export function workspaceProfilePresetFor(
  settings: SettingsManager,
  cwd: string,
): string | undefined {
  return readSubtree(settings, cwd)?.preset;
}
