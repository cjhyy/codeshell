import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { canonicalKey, canonicalPath } from "./canonical-key.js";

export { canonicalKey, canonicalPath };

export type ProjectId = string;
export type ProjectRootId = string;

export interface ProjectRootContext {
  id: ProjectRootId;
  path: string;
  role: "primary" | "secondary";
}

export interface WorkspaceContext {
  version: 1;
  projectId: ProjectId;
  projectRevision: number;
  sessionMainRootId: ProjectRootId;
  roots: ProjectRootContext[];
  rootsDigest: string;
}

export type WorkspaceContextInput = Omit<WorkspaceContext, "version" | "rootsDigest">;

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`invalid WorkspaceContext ${label}`);
  }
  return value;
}

function containsPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function computeWorkspaceRootsDigest(roots: readonly ProjectRootContext[]): string {
  const keys = roots.map((root) => canonicalKey(root.path)).sort();
  return createHash("sha256").update(keys.join("\0"), "utf8").digest("hex");
}

function validateRoots(
  roots: readonly ProjectRootContext[],
  sessionMainRootId: string,
): ProjectRootContext[] {
  if (roots.length === 0 || roots.length > 256) {
    throw new Error("WorkspaceContext roots must contain between 1 and 256 entries");
  }
  const ids = new Set<string>();
  const normalized: ProjectRootContext[] = roots.map((root, index) => {
    if (!root || typeof root !== "object") {
      throw new Error(`invalid WorkspaceContext root at index ${index}`);
    }
    const id = requireIdentifier(root.id, `roots[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate root id: ${id}`);
    ids.add(id);
    if (typeof root.path !== "string" || root.path.length === 0 || root.path.length > 16_384) {
      throw new Error(`invalid WorkspaceContext roots[${index}].path`);
    }
    if (!isAbsolute(root.path)) {
      throw new Error(`WorkspaceContext root path must be absolute: ${root.path}`);
    }
    if (root.role !== "primary" && root.role !== "secondary") {
      throw new Error(`invalid WorkspaceContext roots[${index}].role`);
    }
    return { id, path: root.path, role: root.role };
  });

  const primary = normalized.filter((root) => root.role === "primary");
  if (primary.length !== 1 || primary[0]?.id !== sessionMainRootId) {
    throw new Error("WorkspaceContext must have exactly one primary matching sessionMainRootId");
  }

  const keys = normalized.map((root) => canonicalKey(root.path));
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      if (containsPath(keys[left]!, keys[right]!) || containsPath(keys[right]!, keys[left]!)) {
        throw new Error(
          `WorkspaceContext roots overlap: ${normalized[left]!.path} and ${normalized[right]!.path}`,
        );
      }
    }
  }
  return normalized;
}

export function createWorkspaceContext(input: WorkspaceContextInput): WorkspaceContext {
  const projectId = requireIdentifier(input.projectId, "projectId");
  const sessionMainRootId = requireIdentifier(input.sessionMainRootId, "sessionMainRootId");
  if (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 1) {
    throw new Error("invalid WorkspaceContext projectRevision");
  }
  const roots = validateRoots(input.roots, sessionMainRootId);
  return {
    version: 1,
    projectId,
    projectRevision: input.projectRevision,
    sessionMainRootId,
    roots,
    rootsDigest: computeWorkspaceRootsDigest(roots),
  };
}

export function validateWorkspaceContext(value: unknown): WorkspaceContext {
  if (!value || typeof value !== "object") throw new Error("invalid WorkspaceContext");
  const candidate = value as Partial<WorkspaceContext>;
  if (candidate.version !== 1) throw new Error("invalid WorkspaceContext version");
  const created = createWorkspaceContext({
    projectId: candidate.projectId as string,
    projectRevision: candidate.projectRevision as number,
    sessionMainRootId: candidate.sessionMainRootId as string,
    roots: candidate.roots as ProjectRootContext[],
  });
  if (candidate.rootsDigest !== created.rootsDigest) {
    throw new Error("WorkspaceContext rootsDigest does not match roots");
  }
  return created;
}

/** Compatibility context for callers that only possess one cwd. It is never persisted as a binding. */
export function legacySingleRootWorkspace(cwd: string): WorkspaceContext {
  const path = canonicalPath(cwd);
  const keyDigest = createHash("sha256").update(canonicalKey(path), "utf8").digest("hex");
  return createWorkspaceContext({
    projectId: `legacy-${keyDigest}`,
    projectRevision: 1,
    sessionMainRootId: "legacy-root",
    roots: [{ id: "legacy-root", path, role: "primary" }],
  });
}

export function workspacePrimaryRoot(context: WorkspaceContext): ProjectRootContext {
  return context.roots.find((root) => root.id === context.sessionMainRootId)!;
}

/** Paths present in the previous run-scoped root set but absent from the next one. */
export function removedWorkspaceRootPaths(
  previous: Pick<WorkspaceContext, "roots">,
  next: Pick<WorkspaceContext, "roots">,
): string[] {
  const nextKeys = new Set(next.roots.map((root) => canonicalKey(root.path)));
  return previous.roots
    .filter((root) => !nextKeys.has(canonicalKey(root.path)))
    .map((root) => root.path);
}
