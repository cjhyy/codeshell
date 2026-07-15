/**
 * 全局数字人库：~/.code-shell/profiles/<name>/profile.json。
 * 路径一律经 codeShellHome() 解析（CODE_SHELL_HOME / identity dataRoot 生效）。
 * core 不内置任何领域 profile；样例见 docs/examples/workspace-profile-sample.md。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { logger } from "../logging/logger.js";
import { codeShellHome } from "../session/session-manager.js";
import {
  WORKSPACE_PROFILE_NAME_RE,
  WorkspaceProfileSchema,
  type WorkspaceProfile,
} from "./types.js";

export function workspaceProfilesRoot(): string {
  return join(codeShellHome(), "profiles");
}

/** 该数字人的根目录 —— 同时也是它可移植记忆层的 MemoryManager baseDir。 */
export function workspaceProfileDir(name: string): string {
  return join(workspaceProfilesRoot(), name);
}

export function readWorkspaceProfile(name: string): WorkspaceProfile | undefined {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) return undefined;
  const path = join(workspaceProfileDir(name), "profile.json");
  if (!existsSync(path)) return undefined;
  try {
    return WorkspaceProfileSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    throw new Error(
      `Invalid workspace profile "${name}" at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function listWorkspaceProfiles(): WorkspaceProfile[] {
  const root = workspaceProfilesRoot();
  if (!existsSync(root)) return [];
  const out: WorkspaceProfile[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const profile = readWorkspaceProfile(entry.name);
      if (profile) out.push(profile);
    } catch (error) {
      logger.warn("profile.library_entry_invalid", {
        cat: "profile",
        name: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 原子写（tmp+rename），与 SettingsManager 的写法一致。 */
export function saveWorkspaceProfile(profile: WorkspaceProfile): void {
  const parsed = WorkspaceProfileSchema.parse(profile);
  const dir = workspaceProfileDir(parsed.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "profile.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}
