export interface SessionReplayEntry {
  seq: number;
  event: unknown;
}

export interface SessionReplaySelection {
  events: unknown[];
  cursor: number;
}

export function selectSessionReplayEntries(
  entries: SessionReplayEntry[],
  appliedSeq: number,
): SessionReplaySelection {
  let cursor = appliedSeq;
  const events: unknown[] = [];
  for (const entry of entries) {
    if (entry.seq > appliedSeq) {
      events.push(entry.event);
      if (entry.seq > cursor) cursor = entry.seq;
    }
  }
  return { events, cursor };
}

export function rawApprovalResolvedRequestId(raw: unknown): string | null {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || obj.method !== "agent/approvalResolved") return null;
  const params = obj.params as Record<string, unknown> | null;
  const requestId = params?.requestId;
  return typeof requestId === "string" && requestId ? requestId : null;
}

export function removeResolvedApproval<T extends { requestId: string }>(
  approvals: T[],
  requestId: string,
): T[] {
  return approvals.filter((approval) => approval.requestId !== requestId);
}

export function roomMessageSeq(msg: unknown): number | undefined {
  const seq = (msg as { seq?: unknown } | null)?.seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}

export function markRoomSeqApplied(
  appliedSeqs: Map<string, Set<number>>,
  roomId: string,
  seq: number,
): void {
  let set = appliedSeqs.get(roomId);
  if (!set) {
    set = new Set<number>();
    appliedSeqs.set(roomId, set);
  }
  set.add(seq);
  if (set.size > 1000) {
    const sorted = [...set].sort((a, b) => a - b);
    for (const old of sorted.slice(0, set.size - 1000)) set.delete(old);
  }
}

export function filterNewRoomMessages(
  roomId: string,
  messages: unknown[],
  appliedSeqs: Map<string, Set<number>>,
): unknown[] {
  const seen = appliedSeqs.get(roomId);
  const next: unknown[] = [];
  for (const msg of messages) {
    const seq = roomMessageSeq(msg);
    if (seq !== undefined && seen?.has(seq)) continue;
    next.push(msg);
  }
  return next;
}

export function maxRoomSeq(current: number, messages: unknown[], latestSeq?: number): number {
  let next = typeof latestSeq === "number" && Number.isFinite(latestSeq) ? latestSeq : current;
  for (const msg of messages) {
    const seq = roomMessageSeq(msg);
    if (seq !== undefined && seq > next) next = seq;
  }
  return next;
}

export function noteSessionSeq(
  latestSeqs: Map<string, number>,
  sessionId: string,
  seq: number,
): boolean {
  if (!Number.isFinite(seq)) return false;
  const current = latestSeqs.get(sessionId) ?? 0;
  if (seq <= current) return false;
  latestSeqs.set(sessionId, seq);
  return true;
}

export function markSessionUnread(
  unreadSessionIds: Set<string>,
  sessionId: string,
  activeSessionId?: string,
): Set<string> {
  if (!sessionId || sessionId === activeSessionId || unreadSessionIds.has(sessionId)) {
    return unreadSessionIds;
  }
  const next = new Set(unreadSessionIds);
  next.add(sessionId);
  return next;
}

export function clearUnreadSession(unreadSessionIds: Set<string>, sessionId?: string): Set<string> {
  if (!sessionId || !unreadSessionIds.has(sessionId)) return unreadSessionIds;
  const next = new Set(unreadSessionIds);
  next.delete(sessionId);
  return next;
}

export function pruneUnreadSessions(
  unreadSessionIds: Set<string>,
  sessionIds: Iterable<string>,
): Set<string> {
  const known = new Set(sessionIds);
  let changed = false;
  for (const id of unreadSessionIds) {
    if (!known.has(id)) {
      changed = true;
      break;
    }
  }
  if (!changed) return unreadSessionIds;
  const next = new Set<string>();
  for (const id of unreadSessionIds) {
    if (known.has(id)) next.add(id);
  }
  return next;
}
