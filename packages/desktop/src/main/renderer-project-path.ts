import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { loadProjects } from "./recents-store.js";

const MAX_SESSION_DIRS_TO_SCAN = 20_000;
const MAX_RENDERER_PATH_LENGTH = 32_768;

interface RendererProjectPathOptions {
  registeredPaths?: readonly string[];
  noRepoPath?: string;
  sessionRoot?: string;
}

async function canonicalDirectory(input: unknown): Promise<string | undefined> {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > MAX_RENDERER_PATH_LENGTH ||
    input.includes("\0") ||
    !isAbsolute(input)
  ) {
    return undefined;
  }
  try {
    if (!(await stat(input)).isDirectory()) return undefined;
    return resolve(await realpath(input));
  } catch {
    return undefined;
  }
}

async function canonicalProjectEntry(input: unknown): Promise<string | undefined> {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > MAX_RENDERER_PATH_LENGTH ||
    input.includes("\0") ||
    !isAbsolute(input)
  ) {
    return undefined;
  }
  try {
    const info = await stat(input);
    if (!info.isFile() && !info.isDirectory()) return undefined;
    return resolve(await realpath(input));
  } catch {
    return undefined;
  }
}

async function hasPersistedSessionRoot(sessionRoot: string, requested: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(sessionRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries.slice(0, MAX_SESSION_DIRS_TO_SCAN)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const state = JSON.parse(
        await readFile(join(sessionRoot, entry.name, "state.json"), "utf8"),
      ) as {
        cwd?: unknown;
      };
      const root = await canonicalDirectory(state.cwd);
      if (root === requested) return true;
    } catch {
      // A corrupt/unrelated session is isolated from authorization decisions.
    }
  }
  return false;
}

/**
 * Validate a renderer-supplied project path against main-owned facts.
 *
 * A directory becomes eligible only through the native project picker (which
 * records it in recents), the main-owned no-repo workspace, or a persisted
 * CodeShell session. The session fallback is deliberately retained for the
 * one-time legacy localStorage migration; it is a compatibility gate, not a
 * sandbox against a fully compromised first-party renderer.
 */
export async function requireRendererProjectPath(
  input: unknown,
  options: RendererProjectPathOptions = {},
): Promise<string> {
  const requested = await canonicalDirectory(input);
  if (!requested) throw new Error("project path must be an existing absolute directory");

  const noRepo = await canonicalDirectory(
    options.noRepoPath ?? join(homedir(), ".code-shell", "no-repo"),
  );
  if (requested === noRepo) return requested;

  const registered =
    options.registeredPaths ?? (await loadProjects()).map((project) => project.path);
  for (const path of registered) {
    if ((await canonicalDirectory(path)) === requested) return requested;
  }

  if (await hasPersistedSessionRoot(options.sessionRoot ?? sessionsRoot(), requested)) {
    return requested;
  }
  throw new Error(`project path is not registered with CodeShell: ${String(input)}`);
}

/**
 * Preserve the explicit empty-string sentinel used by settings IPCs for the
 * user/global scope; every non-global value still goes through project-path
 * authorization. Do not use this for IPCs that always require a project.
 */
export async function requireRendererProjectPathOrGlobal(
  input: unknown,
  options: RendererProjectPathOptions = {},
): Promise<string> {
  if (input === "") return "";
  return requireRendererProjectPath(input, options);
}

/** Resolve a renderer-supplied attachment only when its real target stays inside the project. */
export async function requireRendererProjectEntryPath(
  input: unknown,
  projectPath: string,
): Promise<string> {
  const project = await canonicalDirectory(projectPath);
  if (!project) throw new Error("attachment project must be an existing absolute directory");
  const entry = await canonicalProjectEntry(input);
  if (!entry) throw new Error("attachment path must be an existing absolute file or directory");
  const rel = relative(project, entry);
  if (rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))) return entry;
  throw new Error("attachment path is outside the authorized project");
}
