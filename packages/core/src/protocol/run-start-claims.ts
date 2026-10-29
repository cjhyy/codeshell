import type { ChatSessionManager } from "./chat-session-manager.js";

// A run can await a lifecycle handoff before it reaches ChatSession's queue.
// Share this transient fence across transports using the same manager, while
// keeping independent managers/identities and subsequent user runs separate.
const pendingRunStarts = new WeakMap<ChatSessionManager, Map<string, Set<AbortController>>>();

export function trackRunStart(
  manager: ChatSessionManager,
  id: string,
  controller: AbortController,
) {
  let sessions = pendingRunStarts.get(manager);
  if (!sessions) pendingRunStarts.set(manager, (sessions = new Map()));
  let starts = sessions.get(id);
  if (!starts) sessions.set(id, (starts = new Set()));
  starts.add(controller);
  return () => {
    starts.delete(controller);
    if (!starts.size && sessions.get(id) === starts) sessions.delete(id);
  };
}

export function cancelRunStarts(manager: ChatSessionManager, id: string): boolean {
  const starts = pendingRunStarts.get(manager)?.get(id);
  if (!starts?.size) return false;
  for (const controller of [...starts]) controller.abort();
  return true;
}

export function hasPendingRunStarts(
  manager: ChatSessionManager | null,
  sessionId: string,
): boolean {
  return !!(manager && pendingRunStarts.get(manager)?.get(sessionId)?.size);
}
