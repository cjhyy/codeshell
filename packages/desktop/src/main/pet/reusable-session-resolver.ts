/**
 * Second-chance lookup behind PetDispatchService's
 * resolveReusableSessionBySelector: maps an off-list DelegateWork selector
 * (one Mimi discovered via the read-only Sessions tool) back to an on-disk
 * work session. It must enforce the same pool boundaries as the in-list
 * listReusableSessions path (index.ts → listDiskSessions): the disclosure
 * catalog already excludes pet/subagent/child/ephemeral sessions, and this
 * module additionally rejects archived sessions (state.archivedAt is a
 * number) and any session whose state.origin is not "desktop" — a legacy
 * session without an origin field stays out, exactly like the sidebar
 * catalog. PetDispatchService re-applies its own per-turn checks (not Mimi's
 * own session, not busy, workspace match) after this returns.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listWorkSessionsOnDisk, sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";

export function createReusableSessionResolver(
  sessionsRootDir: string,
): (selectorId: string) => Promise<PetReusableSessionCandidate | null> {
  return async (selectorId) => {
    const sessions = await listWorkSessionsOnDisk(sessionsRootDir, { limit: 500 });
    const match = sessions.find((session) => sessionSelectorId(session.sessionId) === selectorId);
    if (!match) return null;
    // One extra state read on this miss-only path: the disclosure catalog does
    // not surface archivedAt/origin, and both gates must match the in-list
    // pool (state.json field names are core session-manager's contract).
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(
        await readFile(join(sessionsRootDir, match.sessionId, "state.json"), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (typeof state.archivedAt === "number" || state.origin !== "desktop") return null;
    return {
      sessionId: match.sessionId,
      workspacePath: match.cwd,
      title: match.title,
      updatedAt: match.updatedAt,
    };
  };
}
