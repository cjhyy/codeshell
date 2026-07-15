/**
 * 激活/切换/关闭事务。原子性来源：整个 `profile` 子树一次
 * saveProjectSetting 写入（内部 tmp+rename）——切换即全量替换，
 * 永远不存在“旧的撤一半、新的写一半”。
 * mainInstruction / portableMemory 不落 settings：settings 只记 active
 * 名字（+ preset/overrides 快照），活字段由 resolve.ts 从库读取。
 */
import type { SettingsManager } from "../settings/manager.js";
import type { CapabilityOverrides } from "../settings/schema.js";
import { readWorkspaceProfile } from "./store.js";
import type { WorkspaceProfile } from "./types.js";

/** settings.profile 子树的形状（与 settings/schema.ts 的 zod 定义一致）。 */
export interface WorkspaceProfileSubtree {
  active: string;
  preset?: string;
  overrides?: CapabilityOverrides;
}

/** 把 profile 声明的能力展开为 force-enable 快照；空 bucket 不落键。 */
export function profileOverridesFromDefinition(profile: WorkspaceProfile): CapabilityOverrides {
  const bucket = (names: readonly string[]): Record<string, "on"> | undefined =>
    names.length > 0 ? Object.fromEntries(names.map((name) => [name, "on" as const])) : undefined;
  const plugins = bucket(profile.plugins);
  const skills = bucket(profile.skills);
  const mcp = bucket(profile.mcp);
  const agents = bucket(profile.agents);
  return {
    ...(plugins ? { plugins } : {}),
    ...(skills ? { skills } : {}),
    ...(mcp ? { mcp } : {}),
    ...(agents ? { agents } : {}),
  };
}

export function activateWorkspaceProfile(
  settings: SettingsManager,
  name: string,
  cwd: string,
): WorkspaceProfile {
  const profile = readWorkspaceProfile(name);
  if (!profile) {
    throw new Error(`Workspace profile "${name}" not found in the global library`);
  }
  const subtree: WorkspaceProfileSubtree = {
    active: profile.name,
    preset: profile.basePreset,
    overrides: profileOverridesFromDefinition(profile),
  };
  settings.saveProjectSetting("profile", subtree, cwd);
  return profile;
}

export function deactivateWorkspaceProfile(settings: SettingsManager, cwd: string): void {
  settings.deleteProjectSetting("profile", cwd);
}
