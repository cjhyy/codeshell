/**
 * Session-scoped approval memory for a host that answers prompts itself.
 *
 * A Native Engine asks through the process-wide `InteractiveApprovalBackend`,
 * which is also what remembers "allow for this session". A host that supplies
 * its own backend (an external Agent Runtime session, whose prompts are shown
 * by Desktop Main rather than a protocol client) bypasses that singleton, and
 * with it the memory: the user's choice was answered and then forgotten.
 *
 * This wraps such a backend in a PRIVATE `InteractiveApprovalBackend`, so the
 * rule that is recorded, how it is narrowed (Bash to its head command, file
 * tools to a path scope) and how a later call is matched against it are the
 * native code, not a second implementation that could drift.
 *
 * Two deliberate differences, both narrower than native:
 *  - nothing is written to settings. A "project" answer is kept for this
 *    session only; the caller decides whether to offer that choice at all.
 *  - only an approval is remembered. A refusal is always a one-off answer.
 */
import type { ApprovalResult } from "../types.js";
import { ApprovalRouter, InteractiveApprovalBackend, type ApprovalBackend } from "./permission.js";

export interface SessionApprovalMemory {
  /** Ask through this instead of the wrapped backend. */
  readonly backend: ApprovalBackend;
  /** Forget every grant and refuse later requests. Call when the session ends. */
  clear(): void;
}

function sessionScoped(result: ApprovalResult): ApprovalResult {
  if (!result.approved) {
    const {
      always: _always,
      scope: _scope,
      ...refusal
    } = result as typeof result & {
      always?: unknown;
      scope?: unknown;
    };
    return refusal;
  }
  const remembered = result.always === true && result.scope !== "once";
  const { always: _always, scope: _scope, pathScope, ...rest } = result;
  return remembered
    ? { ...rest, always: true, scope: "session", ...(pathScope ? { pathScope } : {}) }
    : rest;
}

export function rememberSessionApprovals(
  backend: ApprovalBackend,
  options: {
    /** Grants are bucketed under this id whatever the request carries. */
    sessionId: string;
    /** Resolves a path-scoped file grant; never a place settings are written. */
    cwd: string;
  },
): SessionApprovalMemory {
  const { sessionId, cwd } = options;
  const memory = new InteractiveApprovalBackend(new ApprovalRouter());
  memory.setSessionContext(sessionId, { cwd, onProjectRules: () => {} });
  memory.setPromptFn(async (request, promptOptions) =>
    sessionScoped(await backend.requestApproval(request, promptOptions)),
  );
  return {
    backend: {
      requestApproval: (request, requestOptions) =>
        memory.requestApproval({ ...request, sessionId }, requestOptions),
    },
    clear: () => {
      memory.clearSession(sessionId);
      // Without a prompt function a late request fails closed as unavailable.
      memory.clearPromptFn();
    },
  };
}
