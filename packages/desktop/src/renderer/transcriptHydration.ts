import type { TranscriptsAction, TranscriptsMap } from "./transcriptsReducer";
import type { MessagesReducerState } from "./types";
import type { SequencedStreamEvent } from "./streamCoalescer";
import { mergeHistoryIntoLive } from "./automation/hydrateOrder";

type Reduce = (map: TranscriptsMap, action: TranscriptsAction) => TranscriptsMap;
interface JournalEntry {
  action: TranscriptsAction;
  previous?: JournalEntry;
}
interface Recovery {
  token: number;
  sessionId?: string;
  initial?: MessagesReducerState;
  head?: JournalEntry;
  locals?: JournalEntry;
  localCount?: number;
  localBytes?: number;
  localsOverflow?: boolean;
  requiresContiguous?: boolean;
  count: number;
  bytes: number;
  failed?: boolean;
}

// Recovery metadata belongs to immutable reducer snapshots. It is never
// serialized with a transcript, and is collected with old React state.
const recoveries = new WeakMap<TranscriptsMap, ReadonlyMap<string, Recovery>>();
const MAX_RECOVERY_EVENTS = 8_192;
const MAX_RECOVERY_BYTES = 8 * 1024 * 1024;

export function hasTranscriptRecovery(map: TranscriptsMap, bucket: string): boolean {
  return recoveries.get(map)?.has(bucket) ?? false;
}

export function transcriptRecoveryFailed(map: TranscriptsMap, bucket: string): boolean {
  return recoveries.get(map)?.get(bucket)?.failed === true;
}

export function hasBufferedTranscriptRecovery(
  map: TranscriptsMap,
  bucket: string,
  token: number,
): boolean {
  const recovery = recoveries.get(map)?.get(bucket);
  return recovery?.token === token && recovery.count > 0;
}

function entries(action: TranscriptsAction): SequencedStreamEvent[] | undefined {
  if (action.type === "stream") return [{ event: action.event }];
  if (action.type !== "stream_batch") return undefined;
  return (
    action.raw ??
    action.events.map((event) => ({
      event,
      // Legacy single-event callers can still identify an exact event. Multiple
      // coalesced events require the raw sidecar to split a snapshot boundary.
      seq: action.events.length === 1 ? action.maxSeq : undefined,
      epoch: action.epoch,
    }))
  );
}

function replay(
  bucket: string,
  recovery: Recovery,
  action: Extract<TranscriptsAction, { type: "hydrate_history" }>,
  reduce: Reduce,
): MessagesReducerState | undefined {
  const journal: TranscriptsAction[] = [];
  for (let node = recovery.head; node; node = node.previous) journal.push(node.action);
  journal.reverse();
  const initial = recovery.initial;
  let baseline = initial ? mergeHistoryIntoLive(action.history, initial) : action.history;
  if (action.sessionId && baseline.sessionId && baseline.sessionId !== action.sessionId) {
    baseline = {
      ...baseline,
      snapshotSeq: 0,
      sessionId: action.sessionId,
      streamingAssistantId: null,
      streamingThinkingId: null,
      agentMessageIndex: {},
      activeAgents: {},
    };
  } else if (action.sessionId && !baseline.sessionId) {
    // Legacy snapshots omitted the binding while retaining a valid cursor.
    // Filling it in does not establish that the sequence domain changed.
    baseline = { ...baseline, sessionId: action.sessionId };
  }
  if (action.epoch && baseline.snapshotEpoch !== action.epoch) {
    baseline = {
      ...baseline,
      snapshotSeq: 0,
      snapshotEpoch: action.epoch,
      streamingAssistantId: null,
      streamingThinkingId: null,
      agentMessageIndex: {},
      activeAgents: {},
    };
  }
  // session_started or an orphan delta may have created an otherwise empty
  // bucket before hydration began. Its cursor does not prove a stream prefix.
  if (initial && !initial.messages.length && !initial.turnEpoch) {
    baseline = {
      ...baseline,
      snapshotSeq:
        action.epoch && action.history.snapshotEpoch !== action.epoch
          ? 0
          : action.history.snapshotSeq,
    };
  }
  const sequenced = new Map<number, SequencedStreamEvent>();
  let pendingLocal: TranscriptsAction[] = [];
  const beforeSequence = new Map<number, TranscriptsAction[]>();
  for (const entry of action.snapshot ?? []) {
    if (entry.seq !== undefined && entry.seq > baseline.snapshotSeq)
      sequenced.set(entry.seq, entry);
  }
  for (const recorded of journal) {
    const raw = entries(recorded);
    if (!raw) {
      pendingLocal.push(recorded);
      continue;
    }
    for (const entry of raw) {
      if (action.epoch && entry.epoch && entry.epoch !== action.epoch) continue;
      if (entry.seq === undefined) {
        pendingLocal.push({ type: "stream", bucket, event: entry.event });
      } else {
        if (pendingLocal.length) {
          beforeSequence.set(entry.seq, [
            ...(beforeSequence.get(entry.seq) ?? []),
            ...pendingLocal,
          ]);
          pendingLocal = [];
        }
        if (entry.seq > baseline.snapshotSeq && !sequenced.has(entry.seq))
          sequenced.set(entry.seq, entry);
      }
    }
  }
  let state: TranscriptsMap = { [bucket]: baseline };
  const anchors = [...beforeSequence].sort(([left], [right]) => left - right);
  let anchor = 0;
  let previousSeq = baseline.snapshotSeq;
  for (const [seq, entry] of [...sequenced].sort(([left], [right]) => left - right)) {
    if (recovery.requiresContiguous && seq > previousSeq + 1 && state[bucket]?.streamingAssistantId)
      return undefined;
    while (anchor < anchors.length && anchors[anchor]![0] <= seq) {
      for (const local of anchors[anchor++]![1]) state = reduce(state, local);
    }
    if (
      entry.event.type === "text_delta" &&
      !entry.event.agentId &&
      entry.event.text &&
      !state[bucket]?.streamingAssistantId
    ) {
      // The retained main window can have evicted the turn's start. Advancing
      // past a delta that cannot be applied would turn a temporary gap into a
      // durable loss; keep the recovery failed until a complete prefix exists.
      return undefined;
    }
    state = reduce(state, {
      type: "stream_batch",
      bucket,
      events: [entry.event],
      maxSeq: seq,
      epoch: action.epoch,
    });
    previousSeq = seq;
  }
  // Local user intents, approval answers, and guarded goal updates are not
  // contained in the main snapshot. Keep their own order after the replay;
  // clientMessageId/steerId and goal revisions provide their existing guards.
  for (; anchor < anchors.length; anchor++) {
    for (const local of anchors[anchor]![1]) state = reduce(state, local);
  }
  for (const recorded of pendingLocal) state = reduce(state, recorded);
  return state[bucket]!;
}

export function reduceTranscriptHydration(
  map: TranscriptsMap,
  action: TranscriptsAction,
  reduce: Reduce,
): TranscriptsMap {
  const previous = recoveries.get(map);
  const recovery = previous?.get(action.bucket);
  if (action.type === "hydrate_begin") {
    const next = { ...map };
    const windows = new Map(previous);
    windows.set(
      action.bucket,
      recovery && recovery.sessionId === action.sessionId
        ? recovery.failed
          ? {
              ...recovery,
              token: action.token,
              head: recovery.locals,
              requiresContiguous: true,
              count: recovery.localCount ?? 0,
              bytes: recovery.localBytes ?? 0,
              failed: recovery.localsOverflow,
            }
          : { ...recovery, token: action.token }
        : {
            token: action.token,
            sessionId: action.sessionId,
            initial: map[action.bucket],
            count: 0,
            bytes: 0,
          },
    );
    recoveries.set(next, windows);
    return next;
  }
  if (action.type === "hydrate_cancel") {
    if (!recovery || recovery.token !== action.token || recovery.count > 0 || recovery.failed)
      return map;
    const next = { ...map };
    const windows = new Map(previous);
    windows.delete(action.bucket);
    if (windows.size) recoveries.set(next, windows);
    return next;
  }
  if (action.type === "hydrate_history" && action.token !== undefined) {
    if (!recovery || recovery.token !== action.token) return map;
    if (recovery.failed) return map;
    const restored = replay(action.bucket, recovery, action, reduce);
    const next = restored ? { ...map, [action.bucket]: restored } : { ...map };
    const windows = new Map(previous);
    if (restored) windows.delete(action.bucket);
    else windows.set(action.bucket, { ...recovery, head: undefined, failed: true });
    if (windows.size) recoveries.set(next, windows);
    return next;
  }
  let visibleAction = action;
  if (action.type === "stream_batch" && action.raw?.length) {
    const current = map[action.bucket];
    const cursor =
      action.epoch && action.epoch !== current?.snapshotEpoch ? 0 : (current?.snapshotSeq ?? 0);
    const fresh = action.raw.filter(
      (entry) =>
        (!action.epoch || !entry.epoch || action.epoch === entry.epoch) &&
        (entry.seq === undefined || entry.seq > cursor),
    );
    if (fresh.length !== action.raw.length) {
      visibleAction = {
        ...action,
        events: fresh.map((entry) => entry.event),
        raw: fresh,
        maxSeq: fresh.reduce<number | undefined>(
          (max, entry) => (entry.seq === undefined ? max : Math.max(max ?? 0, entry.seq)),
          undefined,
        ),
      };
    }
  }
  let next = reduce(map, visibleAction);
  if (!previous?.size) return next;
  const windows = new Map(previous);
  if (action.type === "evict" || action.type === "evict_if_unchanged") {
    if (!next[action.bucket]) windows.delete(action.bucket);
  } else if (recovery && action.type !== "hydrate_history") {
    const raw = entries(action);
    if (!recovery.failed || !raw) {
      const size = JSON.stringify(raw ?? action).length * 2;
      let updated = recovery;
      if (!raw) {
        const localCount = (recovery.localCount ?? 0) + 1;
        const localBytes = (recovery.localBytes ?? 0) + size;
        updated =
          localCount > MAX_RECOVERY_EVENTS || localBytes > MAX_RECOVERY_BYTES
            ? { ...recovery, localsOverflow: true, failed: true }
            : {
                ...recovery,
                localCount,
                localBytes,
                locals: { action, previous: recovery.locals },
              };
      }
      if (!recovery.failed) {
        const count = recovery.count + (raw?.length ?? 1);
        const bytes = recovery.bytes + size;
        updated =
          count > MAX_RECOVERY_EVENTS || bytes > MAX_RECOVERY_BYTES
            ? { ...updated, count, bytes, head: undefined, failed: true }
            : { ...updated, count, bytes, head: { action, previous: recovery.head } };
      }
      windows.set(action.bucket, updated);
    }
    // Even an orphan delta that the visible reducer cannot apply must survive
    // until its missing stream_request_start is recovered.
    if (next === map) next = { ...map };
  }
  if (windows.size !== previous.size && next === map) next = { ...map };
  if (windows.size) recoveries.set(next, windows);
  return next;
}
