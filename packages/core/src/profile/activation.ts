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

/**
 * 当前机器上可见的能力清单，用于 `exclusiveCapabilities` 决定「要关掉哪些」。
 * 由 host 注入（core 不扫描磁盘）。缺省即无法独占，退回并集语义。
 */
export interface InstalledCapabilityNames {
  skills?: readonly string[];
  plugins?: readonly string[];
  mcp?: readonly string[];
  agents?: readonly string[];
}

/**
 * 把 profile 声明的能力展开为 override 快照；空 bucket 不落键。
 *
 * 默认只产出 `"on"`（并集：保证该有的在，不动用户开的）。profile 声明
 * `exclusiveCapabilities` 且 host 给出 `installed` 时，未声明的同类能力显式
 * 落 `"off"`，形成独占工作面。
 */
// 返回 NonNullable：`CapabilityOverrides` 自身以 `.optional()` 结尾（settings 里
// 整个 key 可以缺失），但这个函数**总是**构造一个对象字面量，永不返回 undefined。
// 沿用可空别名会迫使每个调用方（含断言 `overrides.skills` 的测试）先做一次不可能
// 为真的 null 检查。
export function profileOverridesFromDefinition(
  profile: WorkspaceProfile,
  installed?: InstalledCapabilityNames,
): NonNullable<CapabilityOverrides> {
  const exclusive = profile.exclusiveCapabilities === true;
  const bucket = (
    declared: readonly string[],
    available: readonly string[] | undefined,
  ): Record<string, "on" | "off"> | undefined => {
    const entries: Record<string, "on" | "off"> = {};
    for (const name of declared) entries[name] = "on";
    if (exclusive && available) {
      const claimed = new Set(declared);
      for (const name of available) {
        if (!claimed.has(name)) entries[name] = "off";
      }
    }
    return Object.keys(entries).length > 0 ? entries : undefined;
  };
  const plugins = bucket(profile.plugins, installed?.plugins);
  const skills = bucket(profile.skills, installed?.skills);
  const mcp = bucket(profile.mcp, installed?.mcp);
  const agents = bucket(profile.agents, installed?.agents);
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
  installed?: InstalledCapabilityNames,
): WorkspaceProfile {
  const profile = readWorkspaceProfile(name);
  if (!profile) {
    throw new Error(`Workspace profile "${name}" not found in the global library`);
  }
  const subtree: WorkspaceProfileSubtree = {
    active: profile.name,
    // A digital human contributes its role, capabilities, and memory. The
    // CodeShell runtime base is a host concern and must not vary with imported
    // definitions that happen to carry a legacy basePreset value.
    preset: "general",
    overrides: profileOverridesFromDefinition(profile, installed),
  };
  settings.saveProjectSetting("profile", subtree, cwd);
  return profile;
}

export function deactivateWorkspaceProfile(settings: SettingsManager, cwd: string): void {
  settings.deleteProjectSetting("profile", cwd);
}
