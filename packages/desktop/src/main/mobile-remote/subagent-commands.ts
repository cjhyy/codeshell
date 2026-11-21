import type { MobileSubagentSummary } from "@cjhyy/code-shell-core";
import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-server/mobile-remote";
import type { DiskSessionMeta } from "@cjhyy/code-shell-server/storage";
import { assertDesktopSessionId } from "../session-validation.js";

/**
 * Remote read access to subagents: the same data Desktop's subagent panel
 * reads (child Sessions listed by parentSessionId, one child's folded
 * transcript). Read-only. A device may read a child only when the top-level
 * Session it descends from passes the ordinary remote Session authority.
 */

/** Children returned per request (Desktop's panel page size). */
export const MAX_SUBAGENT_PAGE = 100;
/** Nested children a remote may walk up through to reach the authorized Session. */
const MAX_SUBAGENT_DEPTH = 8;

type SubagentEvent = Extract<
  MobileClientEvent,
  { type: "session.subagents" | "session.subagentTranscript" }
>;

export interface SubagentCommandDeps {
  /** Throws unless this device may read the top-level Session. */
  authorizeSession(sessionId: string): Promise<unknown>;
  /** A Session's parent id; undefined for a top-level Session, null when unknown. */
  parentOf(sessionId: string): string | undefined | null;
  listChildren(
    parentSessionId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ sessions: DiskSessionMeta[]; nextCursor?: string | null }>;
  /** Folded transcript as session.history.ok envelopes. */
  readTranscript(sessionId: string): Promise<unknown[]>;
}

export function isSubagentEvent(event: MobileClientEvent): event is SubagentEvent {
  return event.type === "session.subagents" || event.type === "session.subagentTranscript";
}

/** Authorize `sessionId` through the top-level Session it belongs to. */
async function authorizeLineage(deps: SubagentCommandDeps, sessionId: string): Promise<void> {
  let current = sessionId;
  for (let depth = 0; depth <= MAX_SUBAGENT_DEPTH; depth++) {
    assertDesktopSessionId(current);
    const parent = deps.parentOf(current);
    if (parent === null) throw new Error("Session not found");
    if (parent === undefined) {
      await deps.authorizeSession(current);
      return;
    }
    current = parent;
  }
  throw new Error("Subagent nesting is too deep");
}

function summary(child: DiskSessionMeta): MobileSubagentSummary {
  return {
    sessionId: child.engineSessionId,
    title: child.title || child.engineSessionId,
    ...(child.status ? { status: child.status } : {}),
    ...(typeof child.updatedAt === "number" ? { updatedAt: child.updatedAt } : {}),
  };
}

export async function handleSubagentCommand(
  deps: SubagentCommandDeps,
  event: SubagentEvent,
  reply: (event: MobileServerEvent) => void,
): Promise<void> {
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  if (event.type === "session.subagents") {
    try {
      await authorizeLineage(deps, event.sessionId);
      const page = await deps.listChildren(event.sessionId, event.cursor, MAX_SUBAGENT_PAGE);
      reply({
        type: "session.subagents.ok",
        requestId: event.requestId,
        sessionId: event.sessionId,
        agents: page.sessions
          .filter((child) => child.parentSessionId === event.sessionId)
          .slice(0, MAX_SUBAGENT_PAGE)
          .map(summary),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    } catch (error) {
      reply({
        type: "session.subagents.ok",
        requestId: event.requestId,
        sessionId: event.sessionId,
        agents: [],
        error: `读取子代理失败：${message(error)}`,
      });
    }
    return;
  }
  try {
    assertDesktopSessionId(event.sessionId);
    // Only a direct child of the requested parent, under the parent's authority.
    if (deps.parentOf(event.sessionId) !== event.parentSessionId)
      throw new Error("not a subagent of this Session");
    await authorizeLineage(deps, event.parentSessionId);
    reply({
      type: "session.subagentTranscript.ok",
      requestId: event.requestId,
      parentSessionId: event.parentSessionId,
      sessionId: event.sessionId,
      events: await deps.readTranscript(event.sessionId),
    });
  } catch (error) {
    reply({
      type: "session.subagentTranscript.ok",
      requestId: event.requestId,
      parentSessionId: event.parentSessionId,
      sessionId: event.sessionId,
      events: [],
      error: `读取子代理记录失败：${message(error)}`,
    });
  }
}
