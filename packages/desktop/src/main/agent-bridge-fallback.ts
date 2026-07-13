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
  params?: {
    cwd?: string;
    sessionId?: string;
    sourceSessionId?: string;
    targetSessionId?: string;
    forkKind?: "side";
    quickChatClaimId?: string;
    type?: string;
    objective?: string;
    paused?: boolean;
    expectedGoalId?: string;
    expectedRevision?: number;
  };
}

export interface QuickChatForkRequest {
  requestId: number | string;
  sessionId: string;
  ownerId: number;
  claimId: string;
}

export function quickChatForkRequest(
  parsed: ParsedRpc,
  ownerId: number,
): QuickChatForkRequest | null {
  const { targetSessionId, quickChatClaimId } = parsed.params ?? {};
  if (
    parsed.method !== "agent/forkSession" ||
    parsed.id === undefined ||
    typeof targetSessionId !== "string" ||
    !/^qchat-[A-Za-z0-9.-]+$/.test(targetSessionId) ||
    typeof quickChatClaimId !== "string" ||
    !quickChatClaimId
  ) {
    return null;
  }
  return { requestId: parsed.id, sessionId: targetSessionId, ownerId, claimId: quickChatClaimId };
}

export function forkSourceSessionId(parsed: ParsedRpc): string | null {
  const sourceSessionId = parsed.params?.sourceSessionId;
  return parsed.method === "agent/forkSession" &&
    typeof sourceSessionId === "string" &&
    sourceSessionId.length > 0
    ? sourceSessionId
    : null;
}

export function compactQuerySessionId(parsed: ParsedRpc): string | null {
  const sid = parsed.params?.sessionId;
  if (
    parsed.method === "agent/query" &&
    parsed.params?.type === "compact" &&
    typeof sid === "string" &&
    sid.length > 0
  ) {
    return sid;
  }
  return null;
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
  const respond = (result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id, result });

  switch (method) {
    case "agent/backgroundShells":
      return respond({ shells: [] });
    case "agent/backgroundWork":
      return respond({ items: [] });
    case "agent/goalGet": {
      const sid = parsed.params?.sessionId;
      if (typeof sid !== "string" || !sid) return null;
      const goal = sessions.readActiveGoal(sid);
      return respond({
        ok: true,
        goal: goal ? goal.objective : null,
        ...(goal?.goalId ? { goalId: goal.goalId } : {}),
        ...(goal?.revision ? { revision: goal.revision } : {}),
        paused: goal?.paused === true,
      });
    }
    case "agent/goalUpdate": {
      const sid = parsed.params?.sessionId;
      if (typeof sid !== "string" || !sid) return null;
      const objective =
        typeof parsed.params?.objective === "string" ? parsed.params.objective : undefined;
      const paused = typeof parsed.params?.paused === "boolean" ? parsed.params.paused : undefined;
      if (objective === undefined && paused === undefined) return null;
      const expectedGoalId = parsed.params?.expectedGoalId;
      const expectedRevision = parsed.params?.expectedRevision;
      if (
        typeof expectedGoalId !== "string" ||
        !expectedGoalId ||
        typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 1
      ) {
        return null;
      }
      const updated = sessions.updateActiveGoal(sid, {
        objective,
        paused,
        expectedGoalId,
        expectedRevision,
      })?.goal;
      return respond({
        ok: true,
        updated: !!updated,
        ...(updated
          ? {
              goal: updated.objective,
              ...(updated.goalId ? { goalId: updated.goalId } : {}),
              ...(updated.revision ? { revision: updated.revision } : {}),
              paused: updated.paused === true,
            }
          : {}),
      });
    }
    case "agent/goalDelete": {
      const sid = parsed.params?.sessionId;
      if (typeof sid !== "string" || !sid) return null;
      const expectedGoalId = parsed.params?.expectedGoalId;
      const expectedRevision = parsed.params?.expectedRevision;
      if (
        typeof expectedGoalId !== "string" ||
        !expectedGoalId ||
        typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 1
      ) {
        return null;
      }
      const deleted = sessions.clearActiveGoal(sid, {
        goalId: expectedGoalId,
        revision: expectedRevision,
      });
      return respond({ ok: true, deleted });
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
