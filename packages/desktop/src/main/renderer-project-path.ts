import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { getProjectStore, type LocalProject, type LocalProjectRoot } from "./project-store.js";
import { requireMountedProjectRoot, validateMountedProjectRoot } from "./mounted-project-root.js";

const MAX_RENDERER_PATH_LENGTH = 32_768;

export interface RendererProjectPathOptions {
  registeredPaths?: readonly string[];
  noRepoPath?: string;
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
  const path = requireMountedProjectRoot(root);
  return { project, root, rootId: root.id, path };
}

/** Resolve the current primary root from an opaque V2 project id. */
export async function requireRendererProjectPrimary(
  projectId: unknown,
  options: RendererProjectRegistryOptions = {},
): Promise<{ project: LocalProject; root: LocalProjectRoot; rootId: string; path: string }> {
  const project = await requireRendererProject(projectId, options);
  return requireRendererProjectRoot(project.id, project.primaryRootId, options);
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
    const canonicalRoot = requireMountedProjectRoot(root);
    if (isWithin(canonicalRoot, entry)) return { entry, rootId: root.id };
  }
  throw new Error("project entry is outside the authorized project roots");
}

/**
 * Validate a renderer-supplied project path against main-owned facts.
 *
 * A directory becomes eligible only when it is a live V2 root or the
 * main-owned no-repo workspace. Persisted Session cwd values are deliberately
 * excluded: Session authority must flow through Session-scoped IPC.
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

  if ((await registeredRootPaths(options)).includes(requested)) return requested;

  throw new Error(`project path is not registered with CodeShell: ${String(input)}`);
}

/**
 * Validate the cwd of an external CLI session opened from a Pet/DriveAgent
 * link. External CLIs routinely run in a git worktree or a subdirectory of a
 * registered project, so beyond the exact roots accepted above this admits a
 * directory inside a live root, or inside a linked worktree whose repository
 * is a live root. Worktree membership is proven from git's metadata in both
 * directions without spawning git: navigation stays zero-spawn until the user
 * explicitly takes over.
 */
export async function requireRendererLinkedSessionPath(
  input: unknown,
  options: RendererProjectPathOptions = {},
): Promise<string> {
  const requested = await canonicalDirectory(input);
  if (!requested) throw new Error("project path must be an existing absolute directory");

  const noRepo = await canonicalDirectory(
    options.noRepoPath ?? join(homedir(), ".code-shell", "no-repo"),
  );
  if (requested === noRepo) return requested;

  const roots = await registeredRootPaths(options);
  if (roots.some((root) => isWithin(root, requested))) return requested;
  const repository = await linkedWorktreeRepository(requested);
  if (repository && roots.includes(repository)) return requested;

  throw new Error(`project path is not registered with CodeShell: ${String(input)}`);
}

async function registeredRootPaths(options: RendererProjectPathOptions): Promise<string[]> {
  if (options.registeredPaths) {
    const paths: string[] = [];
    for (const path of options.registeredPaths) {
      const canonical = await canonicalDirectory(path);
      if (canonical) paths.push(canonical);
    }
    return paths;
  }
  return (await getProjectStore().list()).flatMap((project) =>
    project.roots.flatMap((root) => {
      const validated = validateMountedProjectRoot(root);
      return validated.status === "ok" ? [validated.path] : [];
    }),
  );
}

function isWithin(root: string, entry: string): boolean {
  const rel = relative(root, entry);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Return the canonical main checkout of the linked git worktree containing
 * `dir`, or undefined. The worktree's `.git` file names an admin directory
 * under `<repo>/.git/worktrees/`, and that admin directory's `gitdir` file
 * must point back at the same `.git` file, so a directory cannot claim a
 * repository that does not list it as a worktree.
 */
async function linkedWorktreeRepository(dir: string): Promise<string | undefined> {
  let top = dir;
  while (true) {
    const dotGit = join(top, ".git");
    const info = await lstat(dotGit).catch(() => undefined);
    if (info) {
      if (!info.isFile()) return undefined;
      try {
        const match = /^gitdir:\s*(.+?)\s*$/u.exec(await readFile(dotGit, "utf8"));
        if (!match) return undefined;
        const adminDir = await realpath(resolve(top, match[1]!));
        const commonDir = await realpath(
          resolve(adminDir, (await readFile(join(adminDir, "commondir"), "utf8")).trim()),
        );
        if (basename(commonDir) !== ".git" || dirname(adminDir) !== join(commonDir, "worktrees")) {
          return undefined;
        }
        // worktree.useRelativePaths writes this relative to the admin dir.
        const backPointer = (await readFile(join(adminDir, "gitdir"), "utf8")).trim();
        if ((await realpath(resolve(adminDir, backPointer))) !== (await realpath(dotGit))) {
          return undefined;
        }
        return dirname(commonDir);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(top);
    if (parent === top) return undefined;
    top = parent;
  }
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
