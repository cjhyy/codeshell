import { canonicalKey } from "@cjhyy/code-shell-core/internal";

export interface AutomationWorkspaceAuthorityInput {
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
}

export interface ResolvedAutomationAuthority {
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
}

export interface AutomationAuthorityDeps {
  requireRendererPath: (cwd: string) => Promise<string>;
  isNoRepoCwd: (cwd: string) => boolean;
  resolveProjectRootById: (
    projectId: string,
    rootId?: string,
  ) => { projectId: string; rootId: string; cwd: string };
  resolveExactRoot: (cwd: string) => { projectId: string; rootId: string; cwd: string } | undefined;
}

function hasOwn(input: AutomationWorkspaceAuthorityInput, key: "projectId" | "rootId"): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

async function resolveAuthority(
  input: AutomationWorkspaceAuthorityInput,
  deps: AutomationAuthorityDeps,
  update: boolean,
): Promise<ResolvedAutomationAuthority> {
  const hasProjectId = hasOwn(input, "projectId");
  const hasRootId = hasOwn(input, "rootId");
  if (hasProjectId || hasRootId) {
    if (input.projectId === null) {
      if (input.rootId !== undefined && input.rootId !== null) {
        throw new Error("no-repo automation cannot specify rootId");
      }
      if (input.cwd && !deps.isNoRepoCwd(input.cwd)) {
        throw new Error("renderer cwd does not match the no-repo automation target");
      }
      return update ? { cwd: "", projectId: null, rootId: null } : {};
    }
    if (typeof input.projectId !== "string" || !input.projectId) {
      throw new Error("automation rootId requires projectId");
    }
    if (input.rootId === null) throw new Error("automation rootId is invalid");
    const resolved = deps.resolveProjectRootById(input.projectId, input.rootId);
    if (input.cwd && canonicalKey(input.cwd) !== canonicalKey(resolved.cwd)) {
      throw new Error("renderer cwd does not match the authoritative project root");
    }
    return resolved;
  }

  if (input.cwd === undefined) return {};
  if (!input.cwd) {
    return update ? { cwd: "", projectId: null, rootId: null } : {};
  }
  const cwd = await deps.requireRendererPath(input.cwd);
  if (deps.isNoRepoCwd(cwd)) {
    return update ? { cwd: "", projectId: null, rootId: null } : {};
  }
  const mounted = deps.resolveExactRoot(cwd);
  return mounted ?? { cwd };
}

export function resolveAutomationCreateAuthority(
  input: AutomationWorkspaceAuthorityInput,
  deps: AutomationAuthorityDeps,
): Promise<ResolvedAutomationAuthority> {
  return resolveAuthority(input, deps, false);
}

export function resolveAutomationUpdateAuthority(
  input: AutomationWorkspaceAuthorityInput,
  deps: AutomationAuthorityDeps,
): Promise<ResolvedAutomationAuthority> {
  return resolveAuthority(input, deps, true);
}
