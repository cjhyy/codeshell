/**
 * Canonical renderer terminology for user-tracked projects.
 *
 * Persistence deliberately remains implemented by the legacy `repos.ts`
 * module for this compatibility phase. In particular, these exports keep
 * reading and writing the existing `codeshell.repos`,
 * `codeshell.activeRepoId`, and `codeshell.removedRepoPaths` contracts.
 */
import {
  isRepoPathRemoved,
  loadActiveRepoId,
  loadRemovedRepoPaths,
  loadRepos,
  makeCreateRepoForCwd,
  makeRepoId,
  markRepoPathRemoved,
  reconcileReposFromDisk,
  repoLabel,
  saveActiveRepoId,
  saveRemovedRepoPaths,
  saveRepos,
  sortRepos,
  unmarkRepoPathRemoved,
  type Repo,
} from "./repos";

export type ProjectId = string;
export type ProjectRootId = string;

export interface TrackedProjectRoot {
  id: ProjectRootId;
  path: string;
  name: string;
  addedAt: number;
}

/** Canonical renderer model for a project tracked in the sidebar. */
export interface TrackedProject {
  /** Stable project id. Persisted as the legacy `id` JSON field for compatibility. */
  id: ProjectId;
  /** Default name derived from the path basename when first added. */
  name: string;
  /** Absolute canonical project path. */
  path: string;
  roots: TrackedProjectRoot[];
  primaryRootId: ProjectRootId;
  addedAt: number;
  /** User-set rename, which wins over `name` in project UI. */
  displayName?: string;
  /** Pinned projects render before unpinned projects. */
  pinned?: boolean;
}

export interface ReconciledProjects {
  projects: TrackedProject[];
  projectIdRemap: Record<ProjectId, ProjectId>;
}

/** Convert a value read through the legacy Repo API into the canonical project model. */
export function adaptLegacyRepo(repo: Repo): TrackedProject {
  const rootId = `legacy-root:${repo.id}`;
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    roots: [{ id: rootId, path: repo.path, name: repo.name, addedAt: repo.addedAt }],
    primaryRootId: rootId,
    addedAt: repo.addedAt,
    displayName: repo.displayName,
    pinned: repo.pinned,
  };
}

export function loadProjects(): TrackedProject[] {
  return loadRepos().map(adaptLegacyRepo);
}
export function saveProjects(projects: TrackedProject[]): void {
  saveRepos(projects);
}
export const loadActiveProjectId = loadActiveRepoId;
export const saveActiveProjectId = saveActiveRepoId;
export const loadRemovedProjectPaths = loadRemovedRepoPaths;
export const saveRemovedProjectPaths = saveRemovedRepoPaths;
export const isProjectPathRemoved = isRepoPathRemoved;
export const markProjectPathRemoved = markRepoPathRemoved;
export const unmarkProjectPathRemoved = unmarkRepoPathRemoved;
export const makeProjectId = makeRepoId;
export const reconcileProjectsFromDisk = reconcileReposFromDisk;
export function projectLabel(project: TrackedProject): string {
  return repoLabel(project);
}

export function sortProjects(projects: TrackedProject[]): TrackedProject[] {
  return sortRepos(projects) as TrackedProject[];
}

export function makeCreateProjectForCwd(projectList: TrackedProject[]): {
  createProjectForCwd: (cwd: string) => ProjectId | null;
  changed: () => boolean;
} {
  const legacy = makeCreateRepoForCwd(projectList as Repo[]);
  return {
    createProjectForCwd: legacy.createRepoForCwd,
    changed: legacy.changed,
  };
}

export function reconcileProjectsFromDiskWithRemap(
  diskProjects: Array<{
    id?: string;
    path?: string;
    name: string;
    displayName?: string;
    addedAt?: number;
    pinned?: boolean;
    roots?: TrackedProjectRoot[];
    primaryRootId?: string;
    createdAt?: number;
  }>,
  cached: TrackedProject[],
): ReconciledProjects {
  const byPath = new Map(cached.map((project) => [project.path, project]));
  const projects = diskProjects.map((disk) => {
    const declaredPrimary = disk.roots?.find((root) => root.id === disk.primaryRootId);
    const diskPath = declaredPrimary?.path ?? disk.path ?? disk.roots?.[0]?.path;
    if (!diskPath) throw new Error("project registry entry has no primary path");
    const prior = byPath.get(diskPath);
    const id = disk.id ?? prior?.id ?? makeProjectId();
    const roots =
      disk.roots && disk.roots.length > 0
        ? disk.roots
        : [
            {
              id: disk.primaryRootId ?? `legacy-root:${id}`,
              path: diskPath,
              name: disk.name,
              addedAt: disk.addedAt ?? disk.createdAt ?? prior?.addedAt ?? Date.now(),
            },
          ];
    const primaryRootId =
      disk.primaryRootId && roots.some((root) => root.id === disk.primaryRootId)
        ? disk.primaryRootId
        : roots[0]!.id;
    const primary = roots.find((root) => root.id === primaryRootId)!;
    return {
      id,
      name: disk.name,
      displayName: disk.displayName ?? prior?.displayName,
      path: primary.path,
      roots,
      primaryRootId,
      addedAt: disk.addedAt ?? disk.createdAt ?? prior?.addedAt ?? Date.now(),
      pinned: disk.pinned,
    };
  });
  const targetByPath = new Map(projects.map((project) => [project.path, project]));
  const projectIdRemap: Record<string, string> = {};
  for (const project of cached) {
    const target = targetByPath.get(project.path);
    if (target && target.id !== project.id) projectIdRemap[project.id] = target.id;
  }
  return { projects, projectIdRemap };
}

export function trackedProjectFromRegistry(
  project: Parameters<typeof reconcileProjectsFromDiskWithRemap>[0][number],
): TrackedProject {
  return reconcileProjectsFromDiskWithRemap([project], []).projects[0]!;
}

export function projectPrimary(project: TrackedProject): TrackedProjectRoot {
  return project.roots.find((root) => root.id === project.primaryRootId) ?? project.roots[0]!;
}

export function projectPath(project: TrackedProject): string {
  return projectPrimary(project).path;
}

export async function resolveProjectCwds(
  cwds: readonly string[],
  source: "disk-rebuild" | "automation-import" | "live",
): Promise<
  Map<string, { projectId: string; rootId: string; created: boolean } | { noRepo: true } | null>
> {
  const unique = [...new Set(cwds)];
  const allowed = unique.filter((cwd) => !isProjectPathRemoved(cwd));
  const resolutions = await window.codeshell.projectRegistry.resolveForCwdBatch(allowed, source);
  const result = new Map<
    string,
    { projectId: string; rootId: string; created: boolean } | { noRepo: true } | null
  >();
  unique.forEach((cwd) => result.set(cwd, null));
  allowed.forEach((cwd, index) => result.set(cwd, resolutions[index] ?? null));
  return result;
}
