import { canonicalKey } from "@cjhyy/code-shell-core/internal";
import { getProjectStore } from "./project-store.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";

export interface AutomationWorkspaceAuthorityInput {
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
  resumeSessionId?: string | null;
  /** Non-persisted creator Session used by Main to authorize standalone CronCreate. */
  authoritySessionId?: string | null;
}

export interface ResolvedAutomationAuthority {
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
}

export interface AutomationSessionAuthority {
  sessionId: string;
  /** Durable Session main-root spelling, or the no-repo/legacy cwd. */
  cwd: string;
  /** Current worktree spelling, accepted only as a caller consistency hint. */
  workspaceCwd?: string;
  projectId?: string;
  rootId?: string;
}

export interface AutomationAuthorityDeps {
  requireRendererPath: (cwd: string) => Promise<string>;
  isNoRepoCwd: (cwd: string) => boolean;
  resolveProjectRootById: (
    projectId: string,
    rootId?: string,
  ) => { projectId: string; rootId: string; cwd: string };
  resolveExactRoot: (cwd: string) => { projectId: string; rootId: string; cwd: string } | undefined;
  /** Must re-read the durable Session state; callers must not answer from a stale projection. */
  resolveSessionAuthority: (sessionId: string) => Promise<AutomationSessionAuthority | undefined>;
}

export type AutomationResumeAuthorityValidation =
  | { ok: true; authority: ResolvedAutomationAuthority }
  | { ok: false; reason: string };

function hasOwn(
  input: AutomationWorkspaceAuthorityInput,
  key: keyof AutomationWorkspaceAuthorityInput,
): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function hasWorkspaceInput(input: AutomationWorkspaceAuthorityInput): boolean {
  return hasOwn(input, "cwd") || hasOwn(input, "projectId") || hasOwn(input, "rootId");
}

function nonEmptyResumeSessionId(input: AutomationWorkspaceAuthorityInput): string | undefined {
  return typeof input.resumeSessionId === "string" && input.resumeSessionId.length > 0
    ? input.resumeSessionId
    : undefined;
}

function samePath(left: string, right: string): boolean {
  return canonicalKey(left) === canonicalKey(right);
}

function callerCwdMatchesSession(
  cwd: string,
  session: AutomationSessionAuthority,
  resolvedCwd: string,
): boolean {
  if (!cwd) return false;
  return [session.cwd, session.workspaceCwd, resolvedCwd].some(
    (candidate) => typeof candidate === "string" && samePath(cwd, candidate),
  );
}

async function resolveResumeSessionAuthority(
  sessionId: string,
  input: AutomationWorkspaceAuthorityInput,
  deps: AutomationAuthorityDeps,
  options: { allowLegacy: boolean },
): Promise<ResolvedAutomationAuthority> {
  const session = await deps.resolveSessionAuthority(sessionId);
  if (!session) throw new Error(`resume Session is missing: ${sessionId}`);

  if (session.projectId || session.rootId) {
    if (!session.projectId || !session.rootId) {
      throw new Error("resume Session has an incomplete stable project root binding");
    }
    const resolved = deps.resolveProjectRootById(session.projectId, session.rootId);
    if (hasOwn(input, "projectId") && input.projectId !== session.projectId) {
      throw new Error("caller projectId does not match persisted resume Session project authority");
    }
    if (hasOwn(input, "rootId") && input.rootId !== session.rootId) {
      throw new Error("caller rootId does not match persisted resume Session root authority");
    }
    if (input.cwd !== undefined && !callerCwdMatchesSession(input.cwd, session, resolved.cwd)) {
      throw new Error("caller cwd does not match persisted resume Session cwd authority");
    }
    return resolved;
  }

  if (deps.isNoRepoCwd(session.cwd)) {
    if (hasOwn(input, "projectId") && input.projectId !== null) {
      throw new Error("no-repo resume Session cannot specify projectId");
    }
    if (hasOwn(input, "rootId") && input.rootId !== null) {
      throw new Error("no-repo resume Session cannot specify rootId");
    }
    if (input.cwd !== undefined && input.cwd !== "" && !samePath(input.cwd, session.cwd)) {
      throw new Error("caller cwd does not match persisted no-repo resume Session authority");
    }
    return { cwd: "", projectId: null, rootId: null };
  }

  if (!options.allowLegacy) {
    throw new Error("resume Session has no stable project root binding");
  }
  if (hasOwn(input, "projectId") || hasOwn(input, "rootId")) {
    throw new Error("legacy resume Session cannot accept stable ids from the caller");
  }
  if (!input.cwd || !callerCwdMatchesSession(input.cwd, session, session.cwd)) {
    throw new Error("legacy automation cwd does not match persisted resume Session cwd");
  }
  return { cwd: session.cwd };
}

async function resolveStandaloneAuthority(
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
      return { cwd: "", projectId: null, rootId: null };
    }
    if (typeof input.projectId !== "string" || !input.projectId) {
      throw new Error("automation rootId requires projectId");
    }
    if (input.rootId === null) throw new Error("automation rootId is invalid");
    const resolved = deps.resolveProjectRootById(input.projectId, input.rootId);
    if (input.cwd && !samePath(input.cwd, resolved.cwd)) {
      throw new Error("renderer cwd does not match the authoritative project root");
    }
    return resolved;
  }

  if (input.cwd === undefined) {
    return update ? {} : { cwd: "", projectId: null, rootId: null };
  }
  if (!input.cwd) {
    return update ? { cwd: "", projectId: null, rootId: null } : {};
  }
  const cwd = await deps.requireRendererPath(input.cwd);
  if (deps.isNoRepoCwd(cwd)) {
    return { cwd: "", projectId: null, rootId: null };
  }
  const mounted = deps.resolveExactRoot(cwd);
  if (mounted) return mounted;
  if (update) return { cwd };
  throw new Error("new automation requires explicit projectId/rootId authority");
}

export function resolveAutomationCreateAuthority(
  input: AutomationWorkspaceAuthorityInput,
  deps: AutomationAuthorityDeps,
): Promise<ResolvedAutomationAuthority> {
  const sessionId = nonEmptyResumeSessionId(input);
  if (sessionId) {
    return resolveResumeSessionAuthority(sessionId, input, deps, { allowLegacy: false });
  }
  const authoritySessionId =
    typeof input.authoritySessionId === "string" && input.authoritySessionId.length > 0
      ? input.authoritySessionId
      : undefined;
  if (authoritySessionId) {
    return resolveResumeSessionAuthority(authoritySessionId, input, deps, { allowLegacy: false });
  }
  return resolveStandaloneAuthority(input, deps, false);
}

export function resolveAutomationUpdateAuthority(
  patch: AutomationWorkspaceAuthorityInput,
  existing: AutomationWorkspaceAuthorityInput,
  deps: AutomationAuthorityDeps,
): Promise<ResolvedAutomationAuthority> {
  if (
    hasOwn(patch, "resumeSessionId") &&
    (patch.resumeSessionId ?? null) !== (existing.resumeSessionId ?? null)
  ) {
    return Promise.reject(new Error("automation resume Session binding is immutable"));
  }
  const sessionId = nonEmptyResumeSessionId(existing);
  if (sessionId) {
    return resolveResumeSessionAuthority(sessionId, patch, deps, { allowLegacy: false });
  }
  const authorityInput = hasWorkspaceInput(patch) ? patch : existing;
  return resolveStandaloneAuthority(authorityInput, deps, true);
}

/**
 * Trigger-time guard for resume jobs. Unlike update, this never repairs a stale
 * job: a Session root migration leaves the old job disabled with an explicit
 * reason, so an old-root preflight can never launch a turn in the new root.
 */
export async function validateAutomationResumeAuthority(
  job: AutomationWorkspaceAuthorityInput,
  deps: AutomationAuthorityDeps,
): Promise<AutomationResumeAuthorityValidation> {
  const sessionId = nonEmptyResumeSessionId(job);
  if (!sessionId) return { ok: false, reason: "automation has no resume Session binding" };
  let session: AutomationSessionAuthority | undefined;
  try {
    session = await deps.resolveSessionAuthority(sessionId);
  } catch (error) {
    return {
      ok: false,
      reason: `resume Session authority could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!session) return { ok: false, reason: `resume Session is missing: ${sessionId}` };

  if (session.projectId || session.rootId) {
    if (!session.projectId || !session.rootId) {
      return { ok: false, reason: "resume Session has an incomplete project/root binding" };
    }
    if (job.projectId !== session.projectId) {
      return { ok: false, reason: "resume Session project changed or does not match the job" };
    }
    if (job.rootId !== session.rootId) {
      return { ok: false, reason: "resume Session root changed or does not match the job" };
    }
    try {
      const resolved = deps.resolveProjectRootById(session.projectId, session.rootId);
      return { ok: true, authority: resolved };
    } catch (error) {
      return {
        ok: false,
        reason: `resume Session root is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  if (deps.isNoRepoCwd(session.cwd)) {
    if (job.projectId !== undefined || job.rootId !== undefined) {
      return { ok: false, reason: "no-repo resume Session does not match job stable ids" };
    }
    if (job.cwd && !samePath(job.cwd, session.cwd)) {
      return { ok: false, reason: "no-repo resume Session cwd does not match the job" };
    }
    return { ok: true, authority: { cwd: "", projectId: null, rootId: null } };
  }

  if (job.projectId !== undefined || job.rootId !== undefined || !job.cwd) {
    return { ok: false, reason: "legacy resume job has an invalid cwd-only binding" };
  }
  if (!callerCwdMatchesSession(job.cwd, session, session.cwd)) {
    return { ok: false, reason: "legacy resume job cwd does not match persisted Session cwd" };
  }
  return { ok: true, authority: { cwd: session.cwd } };
}

/** Production composition: every Session lookup refreshes its one durable state file. */
export function desktopAutomationAuthorityDeps(): AutomationAuthorityDeps {
  const projectStore = getProjectStore();
  return {
    requireRendererPath: (cwd) => requireRendererProjectPath(cwd),
    isNoRepoCwd: (cwd) => projectStore.isNoRepoCwd(cwd),
    resolveProjectRootById: (projectId, rootId) => {
      const resolved = projectStore.resolveProjectRootByIdSync(projectId, rootId);
      return {
        projectId: resolved.project.id,
        rootId: resolved.mainRoot.id,
        cwd: resolved.cwd,
      };
    },
    resolveExactRoot: (cwd) => {
      const resolved = projectStore.resolveExactRootSync(cwd);
      return resolved
        ? {
            projectId: resolved.project.id,
            rootId: resolved.mainRoot.id,
            cwd: resolved.cwd,
          }
        : undefined;
    },
    resolveSessionAuthority: async (sessionId) => {
      const index = getSessionCwdIndex();
      await index.ensureLoaded();
      const entry = await index.refresh(sessionId);
      if (!entry || entry.status !== "confirmed") return undefined;
      if (entry.projectId && entry.mainRootId) {
        const resolved = projectStore.resolveRunProjectSync(
          entry.projectId,
          sessionId,
          entry,
          entry.mainRootId,
        );
        return {
          sessionId,
          cwd: resolved.mainRoot.path,
          ...(entry.workspaceRoot ? { workspaceCwd: entry.workspaceRoot } : {}),
          projectId: resolved.project.id,
          rootId: resolved.mainRoot.id,
        };
      }
      return {
        sessionId,
        cwd: entry.cwd,
        ...(entry.workspaceRoot ? { workspaceCwd: entry.workspaceRoot } : {}),
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        ...(entry.mainRootId ? { rootId: entry.mainRootId } : {}),
      };
    },
  };
}
