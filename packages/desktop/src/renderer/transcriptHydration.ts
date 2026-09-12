import type { TranscriptsAction, TranscriptsMap } from "./transcriptsReducer";
import type { Message, MessagesReducerState, UserMessage } from "./types";
import type { SequencedStreamEvent } from "./streamCoalescer";
import { mergeHistoryIntoLive } from "./automation/hydrateOrder";
import { mergeHistoryWindows } from "./app/mergeHistoryWindows";

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

/** Keep local decisions in their proven user turn after disk overlap is removed. */
function retainLocalDecisions(
  merged: MessagesReducerState,
  replayed: MessagesReducerState,
  questions: ReadonlySet<string>,
  endings: ReadonlySet<string>,
  freshEndings: ReadonlySet<string>,
): MessagesReducerState {
  const ids = new Map(merged.messages.map((message, index) => [message.id, index]));
  const questionIds = new Set(
    merged.messages.flatMap((message) => (message.kind === "ask_user" ? [message.requestId] : [])),
  );
  const users = new Map<string, number | null>();
  interface Turn {
    end: number;
    text: Map<string, number | null>;
    endings: Map<string, number[]>;
    compacted: boolean;
  }
  const turns = new Map<number, Turn>();
  let current: Turn | undefined;
  for (let index = 0; index < merged.messages.length; index++) {
    const message = merged.messages[index]!;
    if (message.kind === "user") {
      if (current) current.end = index;
      current = {
        end: merged.messages.length,
        text: new Map(),
        endings: new Map(),
        compacted: false,
      };
      turns.set(index, current);
      for (const key of [
        ...(message.clientMessageId ? [`client:${message.clientMessageId}`] : []),
        ...(message.steerId ? [`steer:${message.steerId}`] : []),
      ])
        users.set(key, users.has(key) ? null : index);
    } else if (current && (message.kind === "assistant" || message.kind === "thinking")) {
      const key = `${message.kind}:${message.text}`;
      current.text.set(key, current.text.has(key) ? null : index);
    } else if (current && message.kind === "turn_end") {
      const markers = current.endings.get(message.reason) ?? [];
      markers.push(index);
      current.endings.set(message.reason, markers);
    } else if (current && message.kind === "context_boundary") {
      current.compacted = true;
    }
  }
  const userKey = (message: UserMessage): string | undefined =>
    message.clientMessageId
      ? `client:${message.clientMessageId}`
      : message.steerId
        ? `steer:${message.steerId}`
        : undefined;
  const savedUsers = new Map<string, number>();
  for (const message of replayed.messages) {
    const key = message.kind === "user" ? userKey(message) : undefined;
    if (key) savedUsers.set(key, (savedUsers.get(key) ?? 0) + 1);
  }
  // Older releases could save both the disk Stop and its detailed local copy.
  // Select one only inside a uniquely identified turn in both projections.
  const preferredEndings = new Map<Turn, Map<string, Extract<Message, { kind: "turn_end" }>>>();
  const detailScore = (message: Extract<Message, { kind: "turn_end" }>): number =>
    Number(freshEndings.has(message.id)) * 4 +
    Number(message.elapsedMs !== undefined) * 2 +
    Number(message.detail !== undefined);
  current = undefined;
  for (const message of replayed.messages) {
    if (message.kind === "user") {
      const key = userKey(message);
      const index = key && savedUsers.get(key) === 1 ? users.get(key) : undefined;
      current = typeof index === "number" ? turns.get(index) : undefined;
    } else if (
      current &&
      message.kind === "turn_end" &&
      endings.has(message.id) &&
      (!current.compacted || freshEndings.has(message.id))
    ) {
      const markers = preferredEndings.get(current) ?? new Map();
      const previous = markers.get(message.reason);
      if (!previous || detailScore(message) > detailScore(previous))
        markers.set(message.reason, message);
      preferredEndings.set(current, markers);
    }
  }
  const insertions = new Map<number, Message[]>();
  const removals = new Set<number>();
  let after: number | undefined;
  current = undefined;
  for (const message of replayed.messages) {
    let position = ids.get(message.id);
    if (message.kind === "user") {
      const key = userKey(message);
      if (position === undefined && key) position = users.get(key) ?? undefined;
      after = position === undefined ? undefined : position + 1;
      current = position === undefined ? undefined : turns.get(position);
    } else {
      // Disk folding changes assistant ids. An exact, unique match within the
      // already-proven user turn can place a decision beside the same reply;
      // this never deduplicates replies or matches text across user intents.
      if (
        position === undefined &&
        current &&
        (message.kind === "assistant" || message.kind === "thinking")
      )
        position = current.text.get(`${message.kind}:${message.text}`) ?? undefined;
      if (position !== undefined) after = position + 1;
    }
    const question =
      message.kind === "ask_user" &&
      (questions.has(message.requestId) || (message.answer !== undefined && !current?.compacted)) &&
      !questionIds.has(message.requestId);
    const ending =
      message.kind === "turn_end" &&
      endings.has(message.id) &&
      (!current?.compacted || freshEndings.has(message.id)) &&
      (!current ||
        !preferredEndings.has(current) ||
        preferredEndings.get(current)?.get(message.reason)?.id === message.id);
    if (ending && current) {
      // The same Stop can already be durable under a fresh fold id. Prefer the
      // journal's marker, including its elapsed/detail, after its partial reply.
      if (preferredEndings.get(current)?.get(message.reason)?.id === message.id) {
        for (const durable of current.endings.get(message.reason) ?? [])
          if (merged.messages[durable]?.id !== message.id) removals.add(durable);
      }
    }
    if ((!question && !(ending && !ids.has(message.id))) || after === undefined) continue;
    // Retain answered cache cards, but restore an old unanswered prompt only
    // when this recovery observed the actual approval action.
    const insertion = ending ? (current?.end ?? merged.messages.length) : after;
    const rows = insertions.get(insertion) ?? [];
    rows.push(message);
    insertions.set(insertion, rows);
    if (message.kind === "ask_user") questionIds.add(message.requestId);
  }
  if (!insertions.size && !removals.size) return merged;
  const positions = new Map<number, number>();
  const messages: Message[] = [];
  for (let index = 0; index <= merged.messages.length; index++) {
    messages.push(...(insertions.get(index) ?? []));
    if (index < merged.messages.length && !removals.has(index)) {
      positions.set(index, messages.length);
      messages.push(merged.messages[index]!);
    }
  }
  return {
    ...merged,
    messages,
    agentMessageIndex: Object.fromEntries(
      Object.entries(merged.agentMessageIndex).map(([id, index]) => [
        id,
        positions.get(index) ?? index,
      ]),
    ),
  };
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
  const prefix = action.replayBase ?? action.history;
  let baseline = initial ? mergeHistoryIntoLive(prefix, initial) : prefix;
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
      snapshotSeq: action.epoch && prefix.snapshotEpoch !== action.epoch ? 0 : prefix.snapshotSeq,
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
  const localQuestions = new Set<string>();
  const localEndings = new Set(
    baseline.messages.flatMap((message) => (message.kind === "turn_end" ? [message.id] : [])),
  );
  const freshEndings = new Set<string>();
  const applyLocal = (local: TranscriptsAction): void => {
    state = reduce(state, local);
    if (local.type === "ask_user" || local.type === "ask_user_answered")
      localQuestions.add(local.requestId);
    if (local.type === "turn_end") {
      const message = state[bucket]?.messages.at(-1);
      if (message?.kind === "turn_end") {
        localEndings.add(message.id);
        freshEndings.add(message.id);
      }
    }
  };
  const users = new Map<string, UserMessage | null>();
  if (action.replayBase) {
    for (const message of action.history.messages) {
      if (message.kind !== "user") continue;
      for (const key of new Set([
        ...(message.clientMessageId ? [`client:${message.clientMessageId}`] : []),
        ...(message.steerId ? [`steer:${message.steerId}`] : []),
      ]))
        users.set(key, users.has(key) ? null : message);
    }
  }
  const anchors = [...beforeSequence].sort(([left], [right]) => left - right);
  let anchor = 0;
  let previousSeq = baseline.snapshotSeq;
  for (const [seq, entry] of [...sequenced].sort(([left], [right]) => left - right)) {
    if (recovery.requiresContiguous && seq > previousSeq + 1 && state[bucket]?.streamingAssistantId)
      return undefined;
    while (anchor < anchors.length && anchors[anchor]![0] <= seq) {
      for (const local of anchors[anchor++]![1]) applyLocal(local);
    }
    const event = entry.event;
    if (action.replayBase && (!("agentId" in event) || !event.agentId)) {
      const user =
        event.type === "session_started" && event.clientMessageId
          ? users.get(`client:${event.clientMessageId}`)
          : event.type === "steer_injected" && event.id
            ? users.has(`steer:${event.id}`)
              ? users.get(`steer:${event.id}`)
              : users.get(`client:${event.id}`)
            : undefined;
      if (user) {
        // Ordinary inputs are absent from the stream. A unique durable id
        // supplies their original anchor without replaying a newer disk reply.
        state = reduce(state, {
          type: "user_message",
          bucket,
          text: user.text,
          clientMessageId: user.clientMessageId,
          steerId: user.steerId,
          attachments: user.attachments,
          isGoal: user.isGoal,
          injected: user.injected,
          pending: false,
        });
      }
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
    for (const local of anchors[anchor]![1]) applyLocal(local);
  }
  for (const recorded of pendingLocal) applyLocal(recorded);
  const replayed = state[bucket]!;
  // Canonical history may be ahead of the cache's cursor. Reconcile only
  // after replay so its completed reply cannot receive the same deltas twice.
  if (!action.replayBase) return replayed;
  const merged = mergeHistoryIntoLive(mergeHistoryWindows(action.history, replayed), replayed);
  return retainLocalDecisions(merged, replayed, localQuestions, localEndings, freshEndings);
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
