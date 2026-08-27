import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { loadProjects } from "./recents-store.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import {
  getProjectStore,
  type LocalProject,
  type LocalProjectRoot,
} from "./project-store.js";

const MAX_RENDERER_PATH_LENGTH = 32_768;

interface RendererProjectPathOptions {
  registeredPaths?: readonly string[];
  noRepoPath?: string;
  sessionRoot?: string;
}

interface RendererProjectRegistryOptions {
  projects?: readonly LocalProject[];
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

async function rendererProjects(options: RendererProjectRegistryOptions): Promise<LocalProject[]> {
  return options.projects ? [...options.projects] : getProjectStore().list();
}

/** Resolve only a live project id from the authoritative main-process registry. */
export async function requireRendererProject(
  projectId: unknown,
  options: RendererProjectRegistryOptions = {},
): Promise<LocalProject> {
  if (typeof projectId !== "string" || !projectId) throw new Error("project id is required");
  const project = (await rendererProjects(options)).find(
    (candidate) => candidate.id === projectId && candidate.deletedAt === undefined,
  );
  if (!project) throw new Error(`project not found: ${String(projectId)}`);
  return project;
}

/** Resolve one registered root id and return its canonical on-disk directory. */
export async function requireRendererProjectRoot(
  projectId: unknown,
  rootId: unknown,
  options: RendererProjectRegistryOptions = {},
): Promise<{ project: LocalProject; root: LocalProjectRoot; rootId: string; path: string }> {
  const project = await requireRendererProject(projectId, options);
  if (typeof rootId !== "string" || !rootId) throw new Error("project root id is required");
  const root = project.roots.find((candidate) => candidate.id === rootId);
  if (!root) throw new Error(`project root not found: ${String(rootId)}`);
  const path = await canonicalDirectory(root.path);
  if (!path) throw new Error(`project root is missing: ${root.path}`);
  return { project, root, rootId: root.id, path };
}

/** Resolve an existing entry and identify the project root that contains its real target. */
export async function requireRendererProjectRootEntry(
  projectId: unknown,
  input: unknown,
  options: RendererProjectRegistryOptions = {},
): Promise<{ entry: string; rootId: string }> {
  const project = await requireRendererProject(projectId, options);
  const entry = await canonicalProjectEntry(input);
  if (!entry) throw new Error("project entry must be an existing absolute file or directory");
  for (const root of project.roots) {
    const canonicalRoot = await canonicalDirectory(root.path);
    if (!canonicalRoot) continue;
    const rel = relative(canonicalRoot, entry);
    if (rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))) {
      return { entry, rootId: root.id };
    }
  }
  throw new Error("project entry is outside the authorized project roots");
}

async function hasPersistedSessionRoot(sessionRoot: string, requested: string): Promise<boolean> {
  const index = getSessionCwdIndex(sessionRoot);
  await index.ensureLoaded();
  return index.resolveConfirmedCwds([requested])[0] === true;
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
