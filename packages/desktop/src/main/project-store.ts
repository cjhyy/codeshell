import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { codeShellHome, SessionManager, type SessionWorkspace } from "@cjhyy/code-shell-core";
import {
  canonicalKey,
  createWorkspaceContext,
  mutateJsonFile,
  type WorkspaceContext,
} from "@cjhyy/code-shell-core/internal";
import { resolveProjectRoot } from "@cjhyy/code-shell-capability-coding/git";
import { dlog } from "./desktop-logger.js";
import {
  getSessionCwdIndex,
  type SessionCwdIndex,
  type SessionCwdIndexEntry,
} from "./session-cwd-index.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 5_000;
const MAX_ROOTS_PER_PROJECT = 256;
const MAX_PATH_LENGTH = 32_768;
const MAX_NAME_LENGTH = 1_024;

export type ProjectId = string;
export type ProjectRootId = string;

export interface LocalProjectRoot {
  id: ProjectRootId;
  path: string;
  name: string;
  addedAt: number;
}

export interface LocalProject {
  id: ProjectId;
  name: string;
  displayName?: string;
  roots: LocalProjectRoot[];
  primaryRootId: ProjectRootId;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  deletedAt?: number;
  revision: number;
}

export interface LocalProjectRegistryV2 {
  version: 2;
  projects: LocalProject[];
}

export type ProjectResolveSource = "disk-rebuild" | "automation-import" | "live";

export type ProjectCwdResolution =
  | { projectId: ProjectId; rootId: ProjectRootId; created: boolean }
  | { noRepo: true }
  | null;

interface RecentProjectRecord {
  path: string;
  name: string;
  lastOpenedAt: number;
  pinned?: boolean;
  deletedAt?: number;
}

interface ProjectStoreOptions {
  file?: string;
  recentsFile?: string;
  migrationMarkerFile?: string;
  sessionIndex?: SessionCwdIndex;
  sessionManager?: SessionManager;
  noRepoPath?: string;
  randomUUID?: () => string;
  now?: () => number;
  resolveProjectRoot?: (cwd: string) => string;
}

export interface AddedProjectRoot {
  project: LocalProject;
  folded?: { picked: string; root: string };
}

export interface ProjectRunResolution {
  project: LocalProject;
  mainRoot: LocalProjectRoot;
  cwd: string;
  workspaceContext: WorkspaceContext;
}

export interface MigratedSessionMainRoot {
  sessionId: string;
  projectId: ProjectId;
  previousMainRootId: ProjectRootId;
  targetRootId: ProjectRootId;
  mainRoot: string;
  workspace: SessionWorkspace;
}

export interface MigrateSessionMainRootOptions {
  /** Route the commit through the worker that owns an active Session bundle. */
  persistLive?: (input: {
    sessionId: string;
    projectId: ProjectId;
    mainRootId: ProjectRootId;
    mainRoot: string;
  }) => Promise<void>;
}

export class ProjectStore {
  private readonly file: string;
  private readonly recentsFile: string;
  private readonly migrationMarkerFile: string;
  private readonly sessionIndex: SessionCwdIndex;
  private readonly sessionManager: SessionManager;
  private readonly noRepoPath: string;
  private readonly makeId: () => string;
  private readonly now: () => number;
  private readonly foldProjectRoot: (cwd: string) => string;
  private initialized = false;
  private readonly listeners = new Set<(projects: LocalProject[]) => void>();

  constructor(options: ProjectStoreOptions = {}) {
    const desktopDir = join(codeShellHome(), "desktop");
    this.file = options.file ?? join(desktopDir, "projects.json");
    this.recentsFile = options.recentsFile ?? join(desktopDir, "recents.json");
    this.migrationMarkerFile =
      options.migrationMarkerFile ?? join(desktopDir, "projects-v2-migration.json");
    this.sessionIndex = options.sessionIndex ?? getSessionCwdIndex();
    this.sessionManager = options.sessionManager ?? new SessionManager();
    this.noRepoPath = options.noRepoPath ?? join(codeShellHome(), "no-repo");
    this.makeId = options.randomUUID ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.foldProjectRoot = options.resolveProjectRoot ?? resolveProjectRoot;
  }

  async list(options: { includeDeleted?: boolean } = {}): Promise<LocalProject[]> {
    this.ensureInitialized();
    const projects = readRegistryFile(this.file).projects;
    return cloneProjects(
      options.includeDeleted
        ? projects
        : projects.filter((project) => project.deletedAt === undefined),
    );
  }

  onChanged(listener: (projects: LocalProject[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async warm(): Promise<void> {
    this.ensureInitialized();
    await this.sessionIndex.ensureLoaded();
  }

  async sessionMainRoots(projectId: string): Promise<Record<string, string[]>> {
    const project = (await this.list()).find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("project not found");
    await this.sessionIndex.ensureLoaded();
    const result: Record<string, string[]> = {};
    for (const entry of this.sessionIndex.confirmedEntries()) {
      if (this.sessionManager.readSessionArchivedAt(entry.sessionId) !== undefined) continue;
      let rootId: string | undefined;
      if (entry.projectId === projectId && entry.mainRootId) {
        rootId = entry.mainRootId;
      } else if (!entry.projectId) {
        const cwdKey = canonicalKey(entry.cwd);
        rootId = project.roots.find((root) => canonicalKey(root.path) === cwdKey)?.id;
      }
      if (rootId) (result[rootId] ??= []).push(entry.sessionId);
    }
    return result;
  }

  async createFromPath(pickedPath: string): Promise<LocalProject> {
    const root = this.resolvePickedRoot(pickedPath);
    let changed = false;
    const project = this.mutate((registry) => {
      const existing = findRoot(registry.projects, root.path);
      if (existing) {
        if (existing.project.deletedAt !== undefined) {
          const timestamp = this.now();
          delete existing.project.deletedAt;
          existing.project.updatedAt = timestamp;
          existing.project.lastOpenedAt = timestamp;
          existing.project.revision += 1;
          changed = true;
        }
        return existing.project;
      }
      if (registry.projects.length >= MAX_PROJECTS) throw new Error("project registry is full");
      const timestamp = this.now();
      const rootId = this.makeId();
      const created: LocalProject = {
        id: this.makeId(),
        name: root.name,
        roots: [{ id: rootId, path: root.path, name: root.name, addedAt: timestamp }],
        primaryRootId: rootId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
        revision: 1,
      };
      registry.projects.push(created);
      changed = true;
      return created;
    });
    if (changed) await this.didChange();
    return cloneProject(project);
  }

  async addRoot(projectId: string, pickedPath: string): Promise<AddedProjectRoot> {
    const root = this.resolvePickedRoot(pickedPath);
    const picked = resolve(pickedPath);
    const project = this.mutate((registry) => {
      const target = requireLiveProject(registry, projectId);
      if (target.roots.length >= MAX_ROOTS_PER_PROJECT)
        throw new Error("project has too many roots");

      const sameProject = target.roots.find(
        (candidate) => canonicalKey(candidate.path) === root.key,
      );
      if (sameProject)
        throw new Error(`folder is already mounted in this project: ${sameProject.path}`);
      if (target.roots.some((candidate) => pathsOverlap(candidate.path, root.path))) {
        throw new Error("project roots must not overlap");
      }
      const duplicate = findRoot(
        registry.projects.filter((candidate) => candidate.id !== projectId),
        root.path,
      );
      if (duplicate) throw new Error("folder already belongs to another project");

      const timestamp = this.now();
      target.roots.push({
        id: this.makeId(),
        path: root.path,
        name: root.name,
        addedAt: timestamp,
      });
      touchProject(target, timestamp);
      return target;
    });
    await this.didChange();
    return {
      project: cloneProject(project),
      ...(canonicalKey(picked) !== root.key ? { folded: { picked, root: root.path } } : {}),
    };
  }

  async removeRoot(projectId: string, rootId: string): Promise<LocalProject> {
    await this.sessionIndex.ensureLoaded();
    const current = await this.requireLive(projectId);
    const removedRoot = current.roots.find((root) => root.id === rootId);
    if (!removedRoot) throw new Error("project root not found");
    const removedKey = canonicalKey(removedRoot.path);
    const affected = this.sessionIndex
      .confirmedEntries()
      .filter(
        (entry) =>
          this.sessionManager.readSessionArchivedAt(entry.sessionId) === undefined &&
          ((entry.projectId === projectId && entry.mainRootId === rootId) ||
            (!entry.projectId && canonicalKey(entry.cwd) === removedKey)),
      )
      .map((entry) => entry.sessionId);
    if (affected.length > 0) {
      throw new Error(`folder is the main root for sessions: ${affected.join(", ")}`);
    }
    const project = this.mutate((registry) => {
      const target = requireLiveProject(registry, projectId);
      if (target.roots.length === 1) throw new Error("a project must retain at least one root");
      if (target.primaryRootId === rootId) throw new Error("cannot remove the primary root");
      const index = target.roots.findIndex((root) => root.id === rootId);
      if (index < 0) throw new Error("project root not found");
      target.roots.splice(index, 1);
      touchProject(target, this.now());
      return target;
    });
    await this.didChange();
    return cloneProject(project);
  }

  /**
   * Main-authoritative Session root migration. The renderer supplies only the
   * opaque Session and target-root ids; project identity and paths are resolved
   * from durable Session state plus this registry.
   */
  async migrateSessionMainRoot(
    sessionId: string,
    targetRootId: string,
    options: MigrateSessionMainRootOptions = {},
  ): Promise<MigratedSessionMainRoot> {
    await this.sessionIndex.ensureLoaded();
    const state = this.sessionManager.readSessionState(sessionId);
    if (!state) throw new Error(`unknown or corrupt Session: ${sessionId}`);
    const binding = state.project;
    if (!binding?.projectId || !binding.mainRootId) {
      throw new Error("Session is not bound to a project root");
    }
    const project = await this.requireLive(binding.projectId);
    const target = project.roots.find((root) => root.id === targetRootId);
    if (!target) throw new Error("migration target root not found in the same project");
    if (!existsDirectory(target.path)) {
      throw new Error(`migration target directory is missing: ${target.path}`);
    }

    const from = state.workspace ?? ({ root: state.cwd, kind: "main" } as const);
    const workspace: SessionWorkspace = { root: target.path, kind: "main" };
    const commit = {
      sessionId,
      projectId: project.id,
      mainRootId: target.id,
      mainRoot: target.path,
    };

    if (options.persistLive) {
      try {
        await options.persistLive(commit);
      } catch (error) {
        // A worker response can be lost after its atomic rename. Re-read the
        // commit point: a fully matching state is success and can safely finish
        // the recoverable index/handoff projections; anything else is failure.
        if (!sessionRootMigrationMatches(this.sessionManager.readSessionState(sessionId), commit)) {
          throw error;
        }
      }
      if (!sessionRootMigrationMatches(this.sessionManager.readSessionState(sessionId), commit)) {
        throw new Error("live Session owner did not commit the root migration");
      }
    } else {
      this.sessionManager.migrateSessionMainRoot(
        sessionId,
        { projectId: project.id, mainRootId: target.id },
        target.path,
      );
    }

    // state.json is the commit point. These projections are deterministic and
    // replayable: a process restart rebuilds the index from that same state.
    this.sessionIndex.upsert(sessionId, {
      cwd: target.path,
      workspaceRoot: target.path,
      projectId: project.id,
      mainRootId: target.id,
    });
    this.sessionManager.recordWorkspaceHandoff(sessionId, from, workspace);
    return {
      sessionId,
      projectId: project.id,
      previousMainRootId: binding.mainRootId,
      targetRootId: target.id,
      mainRoot: target.path,
      workspace,
    };
  }

  async setPrimary(projectId: string, rootId: string): Promise<LocalProject> {
    const project = this.mutate((registry) => {
      const target = requireLiveProject(registry, projectId);
      if (!target.roots.some((root) => root.id === rootId))
        throw new Error("project root not found");
      if (target.primaryRootId !== rootId) {
        target.primaryRootId = rootId;
        touchProject(target, this.now());
      }
      return target;
    });
    await this.didChange();
    return cloneProject(project);
  }

  async rename(projectId: string, name: string): Promise<LocalProject> {
    const normalized = checkedName(name);
    const project = this.mutate((registry) => {
      const target = requireLiveProject(registry, projectId);
      if (target.name !== normalized) {
        target.name = normalized;
        target.displayName = normalized;
        touchProject(target, this.now());
      }
      return target;
    });
    await this.didChange();
    return cloneProject(project);
  }

  async setPinned(projectId: string, pinned: boolean): Promise<LocalProject> {
    if (typeof pinned !== "boolean") throw new Error("invalid pinned state");
    const project = this.mutate((registry) => {
      const target = requireLiveProject(registry, projectId);
      target.pinned = pinned || undefined;
      touchProject(target, this.now());
      return target;
    });
    await this.didChange();
    return cloneProject(project);
  }

  async remove(projectId: string): Promise<void> {
    this.mutate((registry) => {
      const target = requireLiveProject(registry, projectId);
      const timestamp = this.now();
      target.deletedAt = timestamp;
      touchProject(target, timestamp);
      return target;
    });
    await this.didChange();
  }

  async resolveProjectForCwd(
    cwd: string,
    source: ProjectResolveSource = "live",
  ): Promise<ProjectCwdResolution> {
    const [resolved] = await this.resolveProjectForCwdBatch([cwd], source);
    return resolved ?? null;
  }

  async resolveProjectForCwdBatch(
    cwds: readonly string[],
    _source: ProjectResolveSource = "live",
  ): Promise<ProjectCwdResolution[]> {
    this.ensureInitialized();
    await this.sessionIndex.ensureLoaded();
    const registry = readRegistryFile(this.file);
    const noRepoKey = canonicalKey(this.noRepoPath);
    const normalized = cwds.map((cwd) => checkedComparablePath(cwd));
    const confirmed = this.sessionIndex.resolveConfirmedCwds(normalized.map((entry) => entry.path));
    const results: ProjectCwdResolution[] = [];

    for (let index = 0; index < normalized.length; index += 1) {
      const candidate = normalized[index]!;
      const found = findRoot(registry.projects, candidate.path);
      if (found && found.project.deletedAt === undefined && existsDirectory(found.root.path)) {
        results.push({ projectId: found.project.id, rootId: found.root.id, created: false });
      } else if (candidate.key === noRepoKey) {
        results.push({ noRepo: true });
      } else if (confirmed[index]) {
        const created = await this.createFromPath(candidate.path);
        results.push({ projectId: created.id, rootId: created.primaryRootId, created: true });
      } else {
        results.push(null);
      }
    }
    return results;
  }

  async migrateLegacyPath(path: string): Promise<LocalProject | null> {
    if (existsSync(this.migrationMarkerFile)) {
      throw new Error("legacy project migration is complete");
    }
    const resolution = await this.resolveProjectForCwd(path, "live");
    if (!resolution || "noRepo" in resolution) return null;
    return (await this.get(resolution.projectId)) ?? null;
  }

  /** Register a legacy path only when the native picker selected that same canonical root. */
  async migrateLegacyPickedPath(
    expectedPath: string,
    pickedPath: string,
  ): Promise<LocalProject | null> {
    if (existsSync(this.migrationMarkerFile)) {
      throw new Error("legacy project migration is complete");
    }
    const expected = this.resolvePickedRoot(expectedPath);
    const picked = this.resolvePickedRoot(pickedPath);
    if (expected.key !== picked.key) return null;
    return this.createFromPath(picked.path);
  }

  async completeLegacyMigration(): Promise<void> {
    mutateJsonFile<{ completed: true }>(this.migrationMarkerFile, {
      parse: (raw) => {
        if (raw === undefined) return { completed: true };
        const parsed = JSON.parse(raw) as { completed?: unknown };
        if (parsed.completed !== true) throw new Error("invalid project migration marker");
        return { completed: true };
      },
      serialize: (value) => `${JSON.stringify(value)}\n`,
      mutation: (value) => ({ value }),
      mode: 0o600,
      maxBytes: 1_024,
    });
  }

  async get(projectId: string): Promise<LocalProject | undefined> {
    return (await this.list({ includeDeleted: true })).find((project) => project.id === projectId);
  }

  async requireLive(projectId: string): Promise<LocalProject> {
    const project = await this.get(projectId);
    if (!project || project.deletedAt !== undefined) throw new Error("project not found");
    return project;
  }

  resolveRunProjectSync(
    projectId: string,
    sessionId: string,
    session: SessionCwdIndexEntry | undefined,
  ): ProjectRunResolution {
    this.ensureInitialized();
    if (!this.sessionIndex.isLoaded()) {
      throw new Error("session cwd index is not ready");
    }
    const registry = readRegistryFile(this.file);
    const project = registry.projects.find(
      (candidate) => candidate.id === projectId && candidate.deletedAt === undefined,
    );
    if (!project) {
      if (session?.projectId === projectId) {
        throw new Error("Session root status root_removed: bound project is unavailable");
      }
      throw new Error("project not found");
    }
    if (session && session.sessionId !== sessionId) {
      throw new Error("resolved Session entry does not match the requested session");
    }
    let mainRoot: LocalProjectRoot | undefined;
    let cwd: string;
    if (!session) {
      mainRoot = project.roots.find((root) => root.id === project.primaryRootId);
      cwd = mainRoot?.path ?? "";
    } else if (session.projectId || session.mainRootId) {
      if (session.projectId !== projectId || !session.mainRootId) {
        throw new Error("session project binding does not match the requested project");
      }
      mainRoot = project.roots.find((root) => root.id === session.mainRootId);
      cwd = session.workspaceRoot ?? session.cwd;
    } else {
      mainRoot = project.roots.find(
        (root) => canonicalKey(root.path) === canonicalKey(session.cwd),
      );
      cwd = session.workspaceRoot ?? session.cwd;
    }
    if (!mainRoot) {
      throw new Error("Session root status root_removed: main root is not mounted in the project");
    }
    if (!existsDirectory(mainRoot.path)) {
      throw new Error(`Session root status dir_missing: directory is missing: ${mainRoot.path}`);
    }
    return {
      project: cloneProject(project),
      mainRoot: { ...mainRoot },
      cwd,
      workspaceContext: workspaceContextFor(project, mainRoot, cwd),
    };
  }

  /** Exact mounted-root lookup used by Main's origin-sensitive run decision table. */
  resolveExactRootSync(cwd: string): ProjectRunResolution | undefined {
    this.ensureInitialized();
    const registry = readRegistryFile(this.file);
    const found = findRoot(registry.projects, cwd);
    if (!found || found.project.deletedAt !== undefined || !existsDirectory(found.root.path)) {
      return undefined;
    }
    return {
      project: cloneProject(found.project),
      mainRoot: { ...found.root },
      cwd: found.root.path,
      workspaceContext: workspaceContextFor(found.project, found.root, found.root.path),
    };
  }

  isNoRepoCwd(cwd: string): boolean {
    return canonicalKey(cwd) === canonicalKey(this.noRepoPath);
  }

  private resolvePickedRoot(pickedPath: string): { path: string; key: string; name: string } {
    if (!validAbsolutePath(pickedPath) || !existsDirectory(pickedPath)) {
      throw new Error("project root must be an existing absolute directory");
    }
    const folded = this.foldProjectRoot(realpathSync(resolve(pickedPath)));
    if (!existsDirectory(folded)) throw new Error("resolved project root must exist");
    const real = realpathSync(resolve(folded));
    return { path: real, key: canonicalKey(real), name: basename(real) || real };
  }

  private ensureInitialized(): void {
    if (this.initialized && existsSync(this.file)) return;
    let created = false;
    mutateJsonFile<LocalProjectRegistryV2>(this.file, {
      parse: (raw) => {
        if (raw !== undefined) return parseRegistryText(raw, this.file);
        created = true;
        return this.migrateRecents();
      },
      serialize: serializeRegistry,
      mutation: (registry) => ({ value: created ? registry : undefined }),
      mode: 0o600,
      maxBytes: MAX_FILE_BYTES,
    });
    this.initialized = true;
    if (created) this.projectRecents(readRegistryFile(this.file));
  }

  private migrateRecents(): LocalProjectRegistryV2 {
    const recents = readRecentsSafely(this.recentsFile);
    const projects: LocalProject[] = [];
    const seen = new Set<string>();
    for (const recent of recents.slice(0, MAX_PROJECTS)) {
      const path = canonicalStoredPath(recent.path);
      const key = canonicalKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const rootId = this.makeId();
      projects.push({
        id: this.makeId(),
        name: recent.name,
        roots: [
          { id: rootId, path, name: basename(path) || recent.name, addedAt: recent.lastOpenedAt },
        ],
        primaryRootId: rootId,
        ...(recent.pinned === true ? { pinned: true } : {}),
        createdAt: recent.lastOpenedAt,
        updatedAt: recent.lastOpenedAt,
        lastOpenedAt: recent.lastOpenedAt,
        ...(recent.deletedAt !== undefined ? { deletedAt: recent.deletedAt } : {}),
        revision: 1,
      });
    }
    return { version: 2, projects };
  }

  private mutate<T>(mutation: (registry: LocalProjectRegistryV2) => T): T {
    this.ensureInitialized();
    const result = mutateJsonFile<LocalProjectRegistryV2, T>(this.file, {
      parse: (raw) => {
        if (raw === undefined) throw new Error("project registry disappeared during mutation");
        return parseRegistryText(raw, this.file);
      },
      serialize: serializeRegistry,
      mutation: (registry) => ({ value: registry, result: mutation(registry) }),
      mode: 0o600,
      maxBytes: MAX_FILE_BYTES,
    });
    if (result === undefined) throw new Error("project mutation did not produce a result");
    this.projectRecents(readRegistryFile(this.file));
    return result;
  }

  private projectRecents(registry: LocalProjectRegistryV2): void {
    const projected = registry.projects.map((project) => {
      const primary = project.roots.find((root) => root.id === project.primaryRootId)!;
      return {
        path: primary.path,
        name: project.name,
        lastOpenedAt: project.lastOpenedAt,
        ...(project.pinned === true ? { pinned: true } : {}),
        ...(project.deletedAt !== undefined ? { deletedAt: project.deletedAt } : {}),
      };
    });
    try {
      mutateJsonFile<RecentProjectRecord[]>(this.recentsFile, {
        parse: (raw) => {
          if (raw === undefined) return [];
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) throw new Error("recent registry root must be an array");
          return [];
        },
        serialize: (value) => `${JSON.stringify(value, null, 2)}\n`,
        mutation: () => ({ value: projected }),
        mode: 0o600,
        maxBytes: MAX_FILE_BYTES,
      });
    } catch (error) {
      dlog("main", "project_store.recents_projection_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async didChange(): Promise<void> {
    if (this.listeners.size === 0) return;
    const projects = await this.list();
    for (const listener of this.listeners) listener(projects);
  }
}

function workspaceContextFor(
  project: LocalProject,
  mainRoot: LocalProjectRoot,
  runtimeMainPath: string,
): WorkspaceContext {
  return createWorkspaceContext({
    projectId: project.id,
    projectRevision: project.revision,
    sessionMainRootId: mainRoot.id,
    roots: project.roots.map((root) => ({
      id: root.id,
      path: root.id === mainRoot.id ? runtimeMainPath : root.path,
      role: root.id === mainRoot.id ? ("primary" as const) : ("secondary" as const),
    })),
  });
}

function sessionRootMigrationMatches(
  state:
    | {
        cwd: string;
        project?: { projectId: string; mainRootId: string };
        workspace?: SessionWorkspace;
      }
    | undefined,
  commit: { projectId: string; mainRootId: string; mainRoot: string },
): boolean {
  return Boolean(
    state &&
    state.project?.projectId === commit.projectId &&
    state.project.mainRootId === commit.mainRootId &&
    canonicalKey(state.cwd) === canonicalKey(commit.mainRoot) &&
    state.workspace?.kind === "main" &&
    canonicalKey(state.workspace.root) === canonicalKey(commit.mainRoot),
  );
}

function parseRegistryText(raw: string, file: string): LocalProjectRegistryV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Project registry JSON parse failed at ${file}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("project registry top-level value must be an object");
  }
  const envelope = parsed as { version?: unknown; projects?: unknown };
  if (envelope.version !== 2 || !Array.isArray(envelope.projects)) {
    throw new Error("project registry must use version 2");
  }
  const projects = envelope.projects
    .slice(0, MAX_PROJECTS)
    .map(parseProject)
    .filter((project): project is LocalProject => project !== undefined);
  return { version: 2, projects };
}

function parseProject(value: unknown): LocalProject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!validId(item.id) || !validName(item.name) || !Array.isArray(item.roots)) return undefined;
  const roots = item.roots
    .slice(0, MAX_ROOTS_PER_PROJECT)
    .map(parseRoot)
    .filter((root): root is LocalProjectRoot => root !== undefined);
  if (roots.length === 0 || !validId(item.primaryRootId)) return undefined;
  if (!roots.some((root) => root.id === item.primaryRootId)) return undefined;
  if (
    !validTimestamp(item.createdAt) ||
    !validTimestamp(item.updatedAt) ||
    !validTimestamp(item.lastOpenedAt) ||
    !validRevision(item.revision)
  ) {
    return undefined;
  }
  if (item.displayName !== undefined && !validName(item.displayName)) return undefined;
  if (item.pinned !== undefined && typeof item.pinned !== "boolean") return undefined;
  if (item.deletedAt !== undefined && !validTimestamp(item.deletedAt)) return undefined;
  const keys = roots.map((root) => canonicalKey(root.path));
  if (new Set(keys).size !== keys.length) return undefined;
  if (
    roots.some((root, index) =>
      roots.some((other, j) => index !== j && pathsOverlap(root.path, other.path)),
    )
  ) {
    return undefined;
  }
  return {
    id: item.id,
    name: item.name.trim(),
    ...(typeof item.displayName === "string" ? { displayName: item.displayName.trim() } : {}),
    roots,
    primaryRootId: item.primaryRootId,
    ...(item.pinned === true ? { pinned: true } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastOpenedAt: item.lastOpenedAt,
    ...(typeof item.deletedAt === "number" ? { deletedAt: item.deletedAt } : {}),
    revision: item.revision,
  };
}

function parseRoot(value: unknown): LocalProjectRoot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!validId(item.id) || !validAbsolutePath(item.path) || !validName(item.name)) return undefined;
  if (!validTimestamp(item.addedAt)) return undefined;
  return { id: item.id, path: item.path, name: item.name.trim(), addedAt: item.addedAt };
}

function readRegistryFile(file: string): LocalProjectRegistryV2 {
  return parseRegistryText(readBoundedRegularFile(file), file);
}

function readBoundedRegularFile(file: string): string {
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) {
    throw new Error(`project registry is not a bounded regular file: ${file}`);
  }
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) {
      throw new Error(`project registry is not a bounded regular file: ${file}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function readRecentsSafely(file: string): RecentProjectRecord[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readBoundedRegularFile(file)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseRecent)
      .filter((entry): entry is RecentProjectRecord => entry !== undefined);
  } catch {
    return [];
  }
}

function parseRecent(value: unknown): RecentProjectRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    !validAbsolutePath(item.path) ||
    !validName(item.name) ||
    !validTimestamp(item.lastOpenedAt)
  ) {
    return undefined;
  }
  if (item.pinned !== undefined && typeof item.pinned !== "boolean") return undefined;
  if (item.deletedAt !== undefined && !validTimestamp(item.deletedAt)) return undefined;
  return {
    path: item.path,
    name: item.name.trim(),
    lastOpenedAt: item.lastOpenedAt,
    ...(item.pinned === true ? { pinned: true } : {}),
    ...(typeof item.deletedAt === "number" ? { deletedAt: item.deletedAt } : {}),
  };
}

function serializeRegistry(registry: LocalProjectRegistryV2): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function requireLiveProject(registry: LocalProjectRegistryV2, projectId: string): LocalProject {
  const project = registry.projects.find(
    (candidate) => candidate.id === projectId && candidate.deletedAt === undefined,
  );
  if (!project) throw new Error("project not found");
  return project;
}

function findRoot(
  projects: readonly LocalProject[],
  cwd: string,
): { project: LocalProject; root: LocalProjectRoot } | undefined {
  const key = canonicalKey(cwd);
  for (const project of projects) {
    const root = project.roots.find((candidate) => canonicalKey(candidate.path) === key);
    if (root) return { project, root };
  }
  return undefined;
}

function checkedComparablePath(cwd: string): { path: string; key: string } {
  if (!validAbsolutePath(cwd)) throw new Error("cwd must be an absolute path");
  const path = resolve(cwd);
  return { path, key: canonicalKey(path) };
}

function canonicalStoredPath(input: string): string {
  if (!validAbsolutePath(input)) return resolve(input);
  try {
    const real = realpathSync(input);
    return existsDirectory(real) ? realpathSync(resolveProjectRoot(real)) : real;
  } catch {
    return resolve(input);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = canonicalKey(left);
  const b = canonicalKey(right);
  if (a === b) return true;
  const aToB = relative(a, b);
  const bToA = relative(b, a);
  return isContainedRelative(aToB) || isContainedRelative(bToA);
}

function isContainedRelative(value: string): boolean {
  return (
    value !== "" &&
    !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    value !== ".." &&
    !isAbsolute(value)
  );
}

function touchProject(project: LocalProject, timestamp: number): void {
  project.updatedAt = timestamp;
  project.lastOpenedAt = timestamp;
  project.revision += 1;
}

function checkedName(name: string): string {
  if (!validName(name)) throw new Error("invalid project name");
  return name.trim();
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= MAX_NAME_LENGTH &&
    !/[\0\r\n]/u.test(value)
  );
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)
  );
}

function validAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function existsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function cloneProject(project: LocalProject): LocalProject {
  return { ...project, roots: project.roots.map((root) => ({ ...root })) };
}

function cloneProjects(projects: readonly LocalProject[]): LocalProject[] {
  return projects.map(cloneProject);
}

let defaultStore: ProjectStore | undefined;

export function getProjectStore(): ProjectStore {
  defaultStore ??= new ProjectStore();
  return defaultStore;
}

export function __resetProjectStoreForTest(): void {
  defaultStore = undefined;
}
