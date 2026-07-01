// packages/desktop/src/main/agent-bridge-fallback.ts
//
// No-worker fallback replies for the agent bridge, split into its OWN module
// (no electron import) so it is unit-testable under bun without an Electron
// runtime. AgentBridge imports from here.

import type { SessionManager } from "@cjhyy/code-shell-core";

/** Minimal shape of a parsed inbound JSON-RPC line the bridge cares about. */
export interface ParsedRpc {
  id?: number | string;
  method?: string;
  params?: { cwd?: string; sessionId?: string };
}

/**
 * When no worker subprocess is live, decide whether the bridge can answer a
 * request WITHOUT the worker — and return the JSON-RPC response line to send,
 * or null to fall through to the "dropped" path.
 *
 * Two classes are answerable off-process:
 *   - Read-only registry queries (backgroundShells / backgroundWork): the
 *     in-RAM registry is gone with the worker, so the honest answer is "empty".
 *     Answering keeps the renderer's rpc() from hanging its 30s timeout (#7).
 *   - Disk-backed goal ops (goalGet / goalClear): a persistent goal lives ONLY
 *     in state.json, so it outlives the worker. Reading/clearing it needs only
 *     SessionManager, not a live Engine. Without this, "Clear goal" did nothing
 *     for an aborted goal session (worker already exited) — the goal was
 *     uncancellable from the UI. Mirrors core server.ts's disk-fallback intent.
 *
 * Requests with no `id` (notifications) and worker-only ops (run/cancel/approve)
 * return null — the caller drops them as before.
 */
export function buildNoChildFallbackReply(
  parsed: ParsedRpc,
  sessions: SessionManager,
): string | null {
  const { id, method } = parsed;
  if (id === undefined) return null;
  const respond = (result: unknown): string =>
    JSON.stringify({ jsonrpc: "2.0", id, result });

  switch (method) {
    case "agent/backgroundShells":
      return respond({ shells: [] });
    case "agent/backgroundWork":
      return respond({ items: [] });
    case "agent/goalGet": {
      const sid = parsed.params?.sessionId;
      if (typeof sid !== "string" || !sid) return null;
      const goal = sessions.readActiveGoal(sid);
      return respond({ ok: true, goal: goal ? goal.objective : null });
    }
    case "agent/goalClear": {
      const sid = parsed.params?.sessionId;
      if (typeof sid !== "string" || !sid) return null;
      const cleared = sessions.clearActiveGoal(sid);
      return respond({ ok: true, cleared });
    }
    default:
      return null;
  }
}
