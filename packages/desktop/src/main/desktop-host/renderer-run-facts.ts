import type { AgentRunMetadataDeps, ResolvedAgentProjectRun } from "../agent-run-metadata.js";
import type { SessionCwdIndexEntry } from "../session-cwd-index.js";

/** Facts for exactly one renderer run. Only Main can attest the window's
 * project registry, current trust and not-yet-persisted session admission. */
export interface RendererRunFacts {
  session?: { id: string; cached?: SessionCwdIndexEntry; refreshed?: SessionCwdIndexEntry };
  project?: { id: string; session: string; root?: string; result: ResolvedAgentProjectRun };
  exact?: { cwd: string; result?: ResolvedAgentProjectRun };
  persisted?: string;
  noRepo?: { cwd: string; result: boolean };
  trust?: { cwd: string; result: boolean };
}

export function captureRendererRunFacts(
  deps: AgentRunMetadataDeps,
  facts: RendererRunFacts,
): AgentRunMetadataDeps {
  return {
    lookupSession(id, refresh) {
      if (facts.session && facts.session.id !== id)
        throw new Error("Session changed during admission");
      const session = (facts.session ??= { id });
      const value = deps.lookupSession?.(id, refresh);
      session[refresh ? "refreshed" : "cached"] = value;
      return value;
    },
    resolveProjectRun(id, session, entry, root) {
      if (!deps.resolveProjectRun) throw new Error("Project registry unavailable");
      const result = deps.resolveProjectRun(id, session, entry, root);
      facts.project = { id, session, root, result };
      return result;
    },
    resolveExactRoot(cwd) {
      const result = deps.resolveExactRoot?.(cwd);
      facts.exact = { cwd, result };
      return result;
    },
    validatePersistedRoot(cwd) {
      deps.validatePersistedRoot?.(cwd);
      facts.persisted = cwd;
    },
    isNoRepoCwd(cwd) {
      const result = deps.isNoRepoCwd?.(cwd) ?? false;
      facts.noRepo = { cwd, result };
      return result;
    },
    isProjectTrusted(cwd) {
      const result = deps.isProjectTrusted(cwd);
      facts.trust = { cwd, result };
      return result;
    },
  };
}

export function rendererRunFactReader(facts: RendererRunFacts): AgentRunMetadataDeps {
  const revoked = (): never => {
    throw new Error("Run admission facts changed");
  };
  return {
    lookupSession(id, refresh) {
      return facts.session?.id === id ? facts.session[refresh ? "refreshed" : "cached"] : revoked();
    },
    resolveProjectRun(id, session, _entry, root) {
      const fact = facts.project;
      return fact && fact.id === id && fact.session === session && fact.root === root
        ? fact.result
        : revoked();
    },
    resolveExactRoot: (cwd) => (facts.exact?.cwd === cwd ? facts.exact.result : revoked()),
    validatePersistedRoot(cwd) {
      if (facts.persisted !== cwd) revoked();
    },
    isNoRepoCwd: (cwd) => (facts.noRepo?.cwd === cwd ? facts.noRepo.result : revoked()),
    isProjectTrusted: (cwd) => (facts.trust?.cwd === cwd ? facts.trust.result : revoked()),
  };
}
