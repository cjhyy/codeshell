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
