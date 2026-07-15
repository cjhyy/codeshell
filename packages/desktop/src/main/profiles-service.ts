/**
 * WorkspaceProfile（数字人）的 desktop main 门面。与 capabilities-service
 * 相同的组合方式：直接 import core host API，per-call 建 SettingsManager。
 * 激活/关闭写的是项目 settings（原子事务在 core），worker 经现有 settings
 * 热重载在下一轮生效 —— 无需额外通知通道。
 */
import { SettingsManager, type WorkspaceProfile } from "@cjhyy/code-shell-core";
import {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  listWorkspaceProfiles,
  readWorkspaceProfile,
  resolveActiveWorkspaceProfile,
  saveWorkspaceProfile,
} from "@cjhyy/code-shell-core/internal";
import { DIGITAL_HUMAN_CATALOG, type DigitalHumanCatalogEntry } from "./digital-human-catalog.js";

export interface ProfileListEntry {
  name: string;
  label: string;
  description: string | undefined;
  basePreset: string;
  plugins: string[];
  skills: string[];
  mcp: string[];
  agents: string[];
  mainInstruction: string | undefined;
  active: boolean;
  portableMemory: boolean;
  version: string | undefined;
}

export function listProfiles(cwd?: string): ProfileListEntry[] {
  const active = cwd
    ? resolveActiveWorkspaceProfile({ cwd, settings: new SettingsManager(cwd, "full") })?.name
    : undefined;
  return listWorkspaceProfiles().map((profile) => ({
    name: profile.name,
    label: profile.label,
    description: profile.description,
    basePreset: profile.basePreset,
    plugins: profile.plugins,
    skills: profile.skills,
    mcp: profile.mcp,
    agents: profile.agents,
    mainInstruction: profile.mainInstruction,
    active: profile.name === active,
    portableMemory: profile.portableMemory,
    version: profile.version,
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

export type ProfileCatalogEntry = DigitalHumanCatalogEntry & { installed: boolean };

export function listProfileCatalog(): ProfileCatalogEntry[] {
  return DIGITAL_HUMAN_CATALOG.map((entry) => ({
    ...entry,
    installed: readWorkspaceProfile(entry.name) !== undefined,
  }));
}

export function installCatalogProfile(name: string): void {
  const entry = DIGITAL_HUMAN_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown digital human catalog entry "${name}"`);
  const { category: _category, tags: _tags, ...profile } = entry;
  saveWorkspaceProfile(profile);
}

/** Create or atomically update one user-owned digital-human definition. */
export function saveProfile(profile: WorkspaceProfile): void {
  saveWorkspaceProfile(profile);
}
