/**
 * WorkspaceProfile（数字人）的 desktop main 门面。与 capabilities-service
 * 相同的组合方式：直接 import core 公共 API，per-call 建 SettingsManager。
 * 激活/关闭写的是项目 settings（原子事务在 core），worker 经现有 settings
 * 热重载在下一轮生效 —— 无需额外通知通道。
 */
import {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  listWorkspaceProfiles,
  resolveActiveWorkspaceProfile,
  SettingsManager,
} from "@cjhyy/code-shell-core";

export interface ProfileListEntry {
  name: string;
  label: string;
  description: string | undefined;
  active: boolean;
  portableMemory: boolean;
}

export function listProfiles(cwd: string): ProfileListEntry[] {
  const settings = new SettingsManager(cwd, "full");
  const active = resolveActiveWorkspaceProfile({ cwd, settings })?.name;
  return listWorkspaceProfiles().map((profile) => ({
    name: profile.name,
    label: profile.label,
    description: profile.description,
    active: profile.name === active,
    portableMemory: profile.portableMemory,
  }));
}

export function activateProfile(cwd: string, name: string): void {
  const settings = new SettingsManager(cwd, "full");
  activateWorkspaceProfile(settings, name, cwd);
}

export function deactivateProfile(cwd: string): void {
  const settings = new SettingsManager(cwd, "full");
  deactivateWorkspaceProfile(settings, cwd);
}
