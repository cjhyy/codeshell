import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  externalAgentSessionStore,
  type ExternalAgentSessionBinding,
  type ExternalAgentCli,
} from "./external-agent-session-store.js";
import {
  countSessions,
  discoverSessions,
  type DiscoveredSession,
  type DiscoverOptions,
} from "./session-discovery.js";
import { countCodexSessions, discoverCodexSessionsForCwds } from "./codex-session-discovery.js";

export interface RelatedSessionDiscoveryOptions {
  claudeHome?: string;
  codexHome?: string;
  /** Test seam; production reads DriveAgent's durable binding store. */
  bindings?: readonly ExternalAgentSessionBinding[];
}

/**
 * List sessions that belong to the selected cwd plus DriveAgent sessions
 * launched in worktrees associated with it. The external CLI's own recorded
 * cwd is retained on every row and becomes the authoritative path when opening
 * the session.
 */
export function discoverRelatedSessions(
  cli: ExternalAgentCli,
  cwd: string,
  opts: DiscoverOptions = {},
  discovery: RelatedSessionDiscoveryOptions = {},
): DiscoveredSession[] {
  const root = resolve(cwd);
  const bindings = discovery.bindings ?? externalAgentSessionStore.list();
  const expectedIdsByCwd = new Map<string, Set<string>>();
  expectedIdsByCwd.set(root, new Set());

  for (const binding of bindings) {
    if (binding.cli !== cli || !isRelatedBinding(binding, root)) continue;
    const bindingCwd = resolve(binding.cwd);
    const ids = expectedIdsByCwd.get(bindingCwd) ?? new Set<string>();
    ids.add(binding.sessionId);
    expectedIdsByCwd.set(bindingCwd, ids);
  }

  const candidateCwds = [...expectedIdsByCwd.keys()];
  const candidates =
    cli === "codex"
      ? discoverCodexSessionsForCwds(
          candidateCwds,
          discovery.codexHome ?? join(homedir(), ".codex"),
          opts,
          ({ sessionId, cwd: sessionCwd }) => {
            const normalizedCwd = resolve(sessionCwd);
            return (
              normalizedCwd === root || expectedIdsByCwd.get(normalizedCwd)?.has(sessionId) === true
            );
          },
        )
      : candidateCwds.flatMap((candidateCwd) =>
          discoverSessions(
            candidateCwd,
            discovery.claudeHome ?? join(homedir(), ".claude"),
            candidateCwd === root ? opts : { sinceMs: opts.sinceMs, now: opts.now },
          ),
        );

  const deduped = new Map<string, DiscoveredSession>();
  for (const session of candidates) {
    const sessionCwd = resolve(session.cwd);
    const expectedIds = expectedIdsByCwd.get(sessionCwd);
    // The selected cwd shows every native CLI session. Related worktree cwd
    // buckets show only sessions CodeShell actually delegated there.
    if (sessionCwd !== root && !expectedIds?.has(session.sessionId)) continue;
    const key = `${cli}:${session.sessionId}`;
    const prior = deduped.get(key);
    if (!prior || session.lastModified > prior.lastModified) deduped.set(key, session);
  }
  let selected = [...deduped.values()].sort((a, b) => b.lastModified - a.lastModified);
  if (opts.sinceMs && opts.sinceMs > 0) {
    const cutoff = (opts.now ?? Date.now()) - opts.sinceMs;
    selected = selected.filter((session) => session.lastModified >= cutoff);
  }
  if (opts.limit && opts.limit > 0) selected = selected.slice(0, opts.limit);
  return selected;
}

/** Cheap total for the related-session list. Exact-cwd sessions come from the
 * CLI index; delegated cwd totals come from durable DriveAgent bindings so we
 * do not deep-read every transcript just to decide whether "load more" is
 * needed. A stale binding can only overestimate this hint; loading all then
 * returns the authoritative discovered length. */
export function countRelatedSessions(
  cli: ExternalAgentCli,
  cwd: string,
  discovery: RelatedSessionDiscoveryOptions = {},
): number {
  const root = resolve(cwd);
  const exact =
    cli === "codex"
      ? countCodexSessions(root, discovery.codexHome ?? join(homedir(), ".codex"))
      : countSessions(root, discovery.claudeHome ?? join(homedir(), ".claude"));
  const relatedIds = new Set<string>();
  for (const binding of discovery.bindings ?? externalAgentSessionStore.list()) {
    if (binding.cli !== cli || !isRelatedBinding(binding, root)) continue;
    if (resolve(binding.cwd) !== root) relatedIds.add(binding.sessionId);
  }
  return exact + relatedIds.size;
}

function isRelatedBinding(binding: ExternalAgentSessionBinding, root: string): boolean {
  return [binding.cwd, binding.workspaceRoot, binding.worktreePath]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => resolve(value) === root);
}
