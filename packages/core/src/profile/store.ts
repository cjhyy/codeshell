/**
 * 全局数字人库：~/.code-shell/profiles/<name>/profile.json。
 * 路径一律经 codeShellHome() 解析（CODE_SHELL_HOME / identity dataRoot 生效）。
 * core 不内置任何领域 profile；样例见 docs/examples/workspace-profile-sample.md。
 */
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function checkedProfilesRoot(create = false): string | undefined {
  const root = workspaceProfilesRoot();
  let info = lstatIfPresent(root);
  if (!info && create) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    info = lstatSync(root);
  }
  if (!info) return undefined;

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Invalid workspace profiles root: ${root}`);
  }
  return root;
}

function checkedProfileDirectory(name: string, create = false): string | undefined {
  const root = checkedProfilesRoot(create);
  if (!root) return undefined;

  const dir = join(root, name);
  let info = lstatIfPresent(dir);
  if (!info && create) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    info = lstatSync(dir);
  }
  if (!info) return undefined;

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Invalid workspace profile directory: ${dir}`);
  }
  if (!isContained(realpathSync(root), realpathSync(dir))) {
    throw new Error(`Workspace profile directory escapes the profiles root: ${dir}`);
  }
  return dir;
}

function checkedProfileFile(name: string): string | undefined {
  const dir = checkedProfileDirectory(name);
  if (!dir) return undefined;

  const path = join(dir, "profile.json");
  const info = lstatIfPresent(path);
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Invalid workspace profile file: ${path}`);
  }
  return path;
}

export function readWorkspaceProfile(name: string): WorkspaceProfile | undefined {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) return undefined;
  const path = join(workspaceProfileDir(name), "profile.json");
  try {
    const checkedPath = checkedProfileFile(name);
    if (!checkedPath) return undefined;
    return WorkspaceProfileSchema.parse(JSON.parse(readFileSync(checkedPath, "utf-8")));
  } catch (error) {
    throw new Error(
      `Invalid workspace profile "${name}" at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function listWorkspaceProfiles(): WorkspaceProfile[] {
  const root = checkedProfilesRoot();
  if (!root) return [];
  const out: WorkspaceProfile[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) {
        logger.warn("profile.library_entry_invalid", {
          cat: "profile",
          name: entry.name,
          error: "symbolic links are not allowed",
        });
      }
      continue;
    }
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
  const dir = checkedProfileDirectory(parsed.name, true);
  if (!dir) throw new Error(`Could not create workspace profile directory for "${parsed.name}"`);
  const path = join(dir, "profile.json");
  const existing = lstatIfPresent(path);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Invalid workspace profile file: ${path}`);
    }
  }

  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 删除前再次执行目录 containment 校验；不会跟随 profile 目录 symlink。 */
export function deleteWorkspaceProfile(name: string): boolean {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) return false;
  const dir = checkedProfileDirectory(name);
  if (!dir) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
