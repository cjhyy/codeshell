/** Renderer projection of Main's authoritative V2 project registry. */

import { isCaseInsensitivePlatform, normalizeCwd } from "./automation/pathMatch";

export type ProjectId = string;
export type ProjectRootId = string;

export interface TrackedProjectRoot {
  id: ProjectRootId;
  path: string;
  name: string;
  addedAt: number;
}

export interface TrackedProject {
  id: ProjectId;
  name: string;
  path: string;
  roots: TrackedProjectRoot[];
  primaryRootId: ProjectRootId;
  addedAt: number;
  displayName?: string;
  pinned?: boolean;
}

interface LegacyRepo {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  displayName?: string;
  pinned?: boolean;
}

export interface ReconciledProjects {
  projects: TrackedProject[];
  projectIdRemap: Record<ProjectId, ProjectId>;
}

export interface LegacyProjectMigrationPathResult {
  path: string;
  status: "migrated" | "reauthorization_required" | "failed";
  error?: string;
}

export interface LegacyProjectMigrationResult extends ReconciledProjects {
  results: LegacyProjectMigrationPathResult[];
  completed: boolean;
}

type RegistryProject = Parameters<typeof reconcileProjectsFromDiskWithRemap>[0][number];

interface LegacyProjectMigrationRegistry {
  list(): Promise<RegistryProject[]>;
  beginLegacyMigration(paths: string[]): Promise<{ completed: boolean; token?: string }>;
  authorizeLegacyMigration(
    token: string,
    path: string,
  ): Promise<LegacyProjectMigrationPathResult & { project?: RegistryProject }>;
  completeLegacyMigration(token: string): Promise<void>;
}

const LEGACY_PROJECTS_KEY = "codeshell.repos";
const ACTIVE_PROJECT_KEY = "codeshell.activeRepoId";
const REMOVED_PATHS_KEY = "codeshell.removedRepoPaths";

let projectSnapshot: TrackedProject[] = [];
let legacyProjectsRead = false;
let legacyProjectsSnapshot: TrackedProject[] = [];

/** Read the current Main-supplied V2 snapshot. Never consults localStorage. */
export function loadProjects(): TrackedProject[] {
  return projectSnapshot.slice();
}

/** Replace the renderer projection after a V2 list/change notification. */
export function saveProjects(projects: TrackedProject[]): void {
  projectSnapshot = projects.slice();
}

/** Read codeshell.repos at most once, solely for the one-time upgrade migration. */
export function readLegacyProjectsForMigration(): TrackedProject[] {
  if (legacyProjectsRead) return legacyProjectsSnapshot.slice();
  legacyProjectsRead = true;
  try {
    const raw = localStorage.getItem(LEGACY_PROJECTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) {
      legacyProjectsSnapshot = parsed
        .filter(isLegacyRepo)
        .map((repo) => adaptLegacyRepo(repo));
    }
  } catch {
    legacyProjectsSnapshot = [];
  }
  return legacyProjectsSnapshot.slice();
}

function clearLegacyProjectsAfterMigration(): void {
  try {
    localStorage.removeItem(LEGACY_PROJECTS_KEY);
  } catch {
    // Storage may be disabled; Main's completion marker still prevents reuse.
  }
}

export function __resetProjectSnapshotForTest(): void {
  projectSnapshot = [];
  legacyProjectsRead = false;
  legacyProjectsSnapshot = [];
}

function isLegacyRepo(value: unknown): value is LegacyRepo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<LegacyRepo>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.path === "string" &&
    typeof item.addedAt === "number"
  );
}

export function adaptLegacyRepo(repo: LegacyRepo): TrackedProject {
  const rootId = `legacy-root:${repo.id}`;
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    roots: [{ id: rootId, path: repo.path, name: repo.name, addedAt: repo.addedAt }],
    primaryRootId: rootId,
    addedAt: repo.addedAt,
    ...(repo.displayName ? { displayName: repo.displayName } : {}),
    ...(repo.pinned === true ? { pinned: true } : {}),
  };
}

export function loadActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function saveActiveProjectId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    // Best-effort UI selection state.
  }
}

function normalizeProjectPath(path: string): string {
  const trimmed = path.trim();
  return trimmed ? normalizeCwd(trimmed, isCaseInsensitivePlatform()) : "";
}

export function loadRemovedProjectPaths(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REMOVED_PATHS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((path): path is string => typeof path === "string").map(normalizeProjectPath).filter(Boolean))];
  } catch {
    return [];
  }
}

export function saveRemovedProjectPaths(paths: string[]): void {
  try {
    localStorage.setItem(
      REMOVED_PATHS_KEY,
      JSON.stringify([...new Set(paths.map(normalizeProjectPath).filter(Boolean))]),
    );
  } catch {
    // Best-effort legacy UI state; Main tombstones remain authoritative.
  }
}

export function isProjectPathRemoved(path: string): boolean {
  return loadRemovedProjectPaths().includes(normalizeProjectPath(path));
}

export function markProjectPathRemoved(path: string): void {
  saveRemovedProjectPaths([...loadRemovedProjectPaths(), path]);
}

export function unmarkProjectPathRemoved(path: string): void {
  const normalized = normalizeProjectPath(path);
  saveRemovedProjectPaths(loadRemovedProjectPaths().filter((candidate) => candidate !== normalized));
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
  const cachedByPath = new Map(cached.map((project) => [project.path, project]));
  const projects = diskProjects.map((disk): TrackedProject => {
    const declaredPrimary = disk.roots?.find((root) => root.id === disk.primaryRootId);
    const diskPath = declaredPrimary?.path ?? disk.path ?? disk.roots?.[0]?.path;
    if (!diskPath) throw new Error("project registry entry has no primary path");
    const prior = cachedByPath.get(diskPath);
    const id = disk.id ?? prior?.id;
    if (!id) throw new Error("project registry entry has no stable id");
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
      path: primary.path,
      roots,
      primaryRootId,
      addedAt: disk.addedAt ?? disk.createdAt ?? roots[0]!.addedAt,
      ...(disk.displayName ? { displayName: disk.displayName } : {}),
      ...(disk.pinned === true ? { pinned: true } : {}),
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

export function reconcileProjectsFromDisk(
  diskProjects: Parameters<typeof reconcileProjectsFromDiskWithRemap>[0],
  cached: TrackedProject[],
): TrackedProject[] {
  return reconcileProjectsFromDiskWithRemap(diskProjects, cached).projects;
}

export async function migrateLegacyProjects(options: {
  diskProjects: Parameters<typeof reconcileProjectsFromDiskWithRemap>[0];
  cachedProjects: TrackedProject[];
  registry: LegacyProjectMigrationRegistry;
}): Promise<LegacyProjectMigrationResult> {
  const diskPaths = new Set(
    options.diskProjects.flatMap((project) => [
      ...(project.roots?.map((root) => root.path) ?? []),
      ...(project.path ? [project.path] : []),
    ]),
  );
  const missing = options.cachedProjects.filter(
    (project, index, projects) =>
      !diskPaths.has(project.path) && projects.findIndex((item) => item.path === project.path) === index,
  );
  const paths = missing.map((project) => project.path);
  const session = await options.registry.beginLegacyMigration(paths);
  const results: Array<LegacyProjectMigrationPathResult & { project?: RegistryProject }> = [];

  if (!session.completed) {
    if (!session.token) throw new Error("legacy project migration did not return a token");
    for (const path of paths) {
      results.push(await options.registry.authorizeLegacyMigration(session.token, path));
    }
    if (results.every((result) => result.status === "migrated")) {
      await options.registry.completeLegacyMigration(session.token);
    }
  }

  const completed = session.completed || results.every((result) => result.status === "migrated");
  const disk = paths.length > 0 || session.completed ? await options.registry.list() : options.diskProjects;
  const reconciled = reconcileProjectsFromDiskWithRemap(disk, options.cachedProjects);
  // Main canonicalizes the picked path, so its spelling may differ from the
  // legacy renderer path (for example /var vs /private/var). The migration
  // result is the proof-backed bridge for remapping renderer UI buckets.
  for (const result of results) {
    if (result.status !== "migrated" || !result.project) continue;
    const legacy = options.cachedProjects.find((project) => project.path === result.path);
    if (legacy && result.project.id && legacy.id !== result.project.id) {
      reconciled.projectIdRemap[legacy.id] = result.project.id;
    }
  }
  if (completed) clearLegacyProjectsAfterMigration();
  return { ...reconciled, results, completed };
}

export function trackedProjectFromRegistry(project: RegistryProject): TrackedProject {
  return reconcileProjectsFromDiskWithRemap([project], []).projects[0]!;
}

export function projectPrimary(project: TrackedProject): TrackedProjectRoot {
  return project.roots.find((root) => root.id === project.primaryRootId) ?? project.roots[0]!;
}

export function projectPath(project: TrackedProject): string {
  return projectPrimary(project).path;
}

export function projectLabel(project: TrackedProject): string {
  return project.displayName?.trim() || project.name;
}

export function sortProjects(projects: TrackedProject[]): TrackedProject[] {
  return [...projects].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return left.addedAt - right.addedAt;
  });
}

/** Legacy planner seam: Main resolution may create projects; renderer never mints ids. */
export function makeCreateProjectForCwd(_projects: TrackedProject[]): {
  createProjectForCwd: (_cwd: string) => null;
  changed: () => false;
} {
  return { createProjectForCwd: () => null, changed: () => false };
}

export function projectIdForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return projectSnapshot.find((project) => project.roots.some((root) => root.path === path))?.id;
}

export async function resolveProjectCwds(
  cwds: readonly string[],
  source: "disk-rebuild" | "automation-import" | "live",
): Promise<
  Map<string, { projectId: string; rootId: string; created: boolean } | { noRepo: true } | null>
> {
  const unique = [...new Set(cwds)];
  const resolutions = await window.codeshell.projectRegistry.resolveForCwdBatch(unique, source);
  return new Map(unique.map((cwd, index) => [cwd, resolutions[index] ?? null]));
}
