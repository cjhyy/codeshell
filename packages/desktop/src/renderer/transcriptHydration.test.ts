import { expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { createEventCoalescer, type SequencedStreamEvent } from "./streamCoalescer";
import { hasTranscriptRecovery, transcriptRecoveryFailed } from "./transcriptHydration";
import {
  transcriptsReducer,
  type TranscriptsAction,
  type TranscriptsMap,
} from "./transcriptsReducer";
import { INITIAL_STATE } from "./types";

const bucket = "project::session";
const start = { type: "stream_request_start", turnNumber: 1, messageId: "reply" } as StreamEvent;
const text = (value: string) => ({ type: "text_delta", text: value }) as StreamEvent;
const begin = (map: TranscriptsMap = {}) =>
  transcriptsReducer(map, { type: "hydrate_begin", bucket, token: 1 });
function finish(map: TranscriptsMap, snapshot: SequencedStreamEvent[], token = 1, epoch?: string) {
  return transcriptsReducer(map, {
    type: "hydrate_history",
    bucket,
    token,
    epoch,
    snapshot,
    history: INITIAL_STATE,
    state: INITIAL_STATE,
    goalAtStart: null,
  });
}
function reply(map: TranscriptsMap) {
  return map[bucket]?.messages.find(
    (message) => message.kind === "assistant" && message.id === "reply",
  );
}

test("a coalesced batch spanning the snapshot boundary replays each raw delta once", () => {
  let state = begin();
  const coalescer = createEventCoalescer((events, raw) => {
    state = transcriptsReducer(state, { type: "stream_batch", bucket, events, raw, maxSeq: 11 });
  });
  coalescer.push(text("prefix"), 10);
  coalescer.push(text(" tail"), 11);
  coalescer.flush();
  expect(reply(state)).toBeUndefined();
  state = finish(state, [
    { seq: 9, event: start },
    { seq: 10, event: text("prefix") },
  ]);
  expect(reply(state)).toMatchObject({ text: "prefix tail" });
  expect(state[bucket]?.snapshotSeq).toBe(11);
  expect(hasTranscriptRecovery(state, bucket)).toBe(false);
});

test("a queued coalescer flush after hydration trims only the already replayed prefix", () => {
  let state = finish(begin(), [
    { seq: 9, event: start },
    { seq: 10, event: text("prefix") },
  ]);
  const coalescer = createEventCoalescer((events, raw) => {
    state = transcriptsReducer(state, { type: "stream_batch", bucket, events, raw, maxSeq: 11 });
  });
  coalescer.push(text("prefix"), 10);
  coalescer.push(text(" tail"), 11);
  coalescer.flush();
  expect(reply(state)).toMatchObject({ text: "prefix tail" });
});

test("local inputs and approval answers retain order around replayed stream events", () => {
  let state = begin();
  const actions: TranscriptsAction[] = [
    { type: "user_message", bucket, text: "Local request", clientMessageId: "local-request" },
    { type: "stream_batch", bucket, events: [start], maxSeq: 9 },
    { type: "ask_user", bucket, requestId: "ask", question: "Choose?", options: ["Yes"] },
    { type: "ask_user_answered", bucket, requestId: "ask", answer: "Yes" },
  ];
  for (const action of actions) state = transcriptsReducer(state, action);
  state = finish(state, [
    { seq: 9, event: start },
    { seq: 10, event: text("reply") },
  ]);
  expect(state[bucket]?.messages[0]).toMatchObject({
    kind: "user",
    clientMessageId: "local-request",
  });
  expect(reply(state)).toMatchObject({ text: "reply" });
  expect(state[bucket]?.messages.find((message) => message.kind === "ask_user")).toMatchObject({
    answer: "Yes",
  });
});

test("cancelled windows retain raw tails for retry and reject the older completion token", () => {
  let state = begin();
  state = transcriptsReducer(state, {
    type: "stream_batch",
    bucket,
    events: [text(" tail")],
    maxSeq: 11,
  });
  state = transcriptsReducer(state, { type: "hydrate_cancel", bucket, token: 1 });
  state = transcriptsReducer(state, { type: "hydrate_begin", bucket, token: 2 });
  expect(finish(state, [], 1)).toBe(state);
  state = finish(
    state,
    [
      { seq: 9, event: start },
      { seq: 10, event: text("prefix") },
    ],
    2,
  );
  expect(reply(state)).toMatchObject({ text: "prefix tail" });
});

test("recovery cannot publish a successful cursor after its bounded journal overflows", () => {
  let state = begin();
  state = transcriptsReducer(state, {
    type: "stream_batch",
    bucket,
    events: [text("x".repeat(5 * 1024 * 1024))],
    maxSeq: 11,
  });
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
  expect(finish(state, [{ seq: 9, event: start }])).toBe(state);
  expect(hasTranscriptRecovery(state, bucket)).toBe(true);
  state = transcriptsReducer(state, { type: "hydrate_cancel", bucket, token: 1 });
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
});

test("a new snapshot epoch can replay low sequence numbers over an older persisted cursor", () => {
  let state = begin({ [bucket]: { ...INITIAL_STATE, snapshotEpoch: "old", snapshotSeq: 900 } });
  state = transcriptsReducer(state, {
    type: "stream_batch",
    bucket,
    epoch: "new",
    events: [text(" tail")],
    maxSeq: 3,
    raw: [{ seq: 3, epoch: "new", event: text(" tail") }],
  });
  state = finish(
    state,
    [
      { seq: 1, epoch: "new", event: start },
      { seq: 2, epoch: "new", event: text("prefix") },
    ],
    1,
    "new",
  );
  expect(reply(state)).toMatchObject({ text: "prefix tail" });
  expect(state[bucket]).toMatchObject({ snapshotEpoch: "new", snapshotSeq: 3 });
});

test("an old epoch's stream pointer cannot establish the prefix for a new epoch", () => {
  let state = finish(
    begin(),
    [
      { seq: 899, event: start },
      { seq: 900, event: text("old reply") },
    ],
    1,
    "old",
  );
  state = begin(state);
  state = finish(state, [{ seq: 2001, epoch: "new", event: text("new epoch tail") }], 1, "new");
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
  expect(reply(state)).toMatchObject({ text: "old reply" });
  expect(state[bucket]?.snapshotEpoch).toBe("old");
});

test("overflow retry uses the original baseline and requires a recoverable prefix", () => {
  let state = begin();
  state = transcriptsReducer(state, { type: "stream_batch", bucket, events: [start], maxSeq: 9 });
  state = transcriptsReducer(state, {
    type: "stream_batch",
    bucket,
    events: [text("x".repeat(5 * 1024 * 1024))],
    maxSeq: 11,
  });
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
  state = transcriptsReducer(state, { type: "hydrate_begin", bucket, token: 2 });
  state = finish(state, [{ seq: 11, event: text("tail without its prefix") }], 2);
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
  state = transcriptsReducer(state, { type: "hydrate_begin", bucket, token: 3 });
  state = finish(
    state,
    [
      { seq: 9, event: start },
      { seq: 10, event: text("full prefix") },
      { seq: 11, event: text(" and tail") },
    ],
    3,
  );
  expect(reply(state)).toMatchObject({ text: "full prefix and tail" });
  expect(hasTranscriptRecovery(state, bucket)).toBe(false);
});

test("a guarded local goal rollback cannot replace a newer goal in the replay", () => {
  let state = begin();
  state = transcriptsReducer(state, {
    type: "goal_reconcile",
    bucket,
    expected: null,
    goal: { goalId: "old", revision: 1, objective: "obsolete" } as any,
  });
  state = finish(state, [
    {
      seq: 1,
      event: {
        type: "goal_set",
        goalId: "current",
        revision: 2,
        objective: "current objective",
      } as StreamEvent,
    },
  ]);
  expect(state[bucket]?.activeGoal).toMatchObject({ goalId: "current", revision: 2 });
});

test("overflow retry cannot jump past missing bytes even with a valid old stream pointer", () => {
  let state = finish(begin(), [
    { seq: 9, event: start },
    { seq: 10, event: text("prefix") },
  ]);
  state = begin(state);
  state = transcriptsReducer(state, {
    type: "stream_batch",
    bucket,
    events: [text("x".repeat(5 * 1024 * 1024))],
    maxSeq: 11,
  });
  state = transcriptsReducer(state, { type: "hydrate_begin", bucket, token: 2 });
  state = finish(state, [{ seq: 12, event: text("later tail") }], 2);
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
});

test("local inputs and approval answers survive raw overflow and the retry window", () => {
  let state = begin();
  state = transcriptsReducer(state, {
    type: "ask_user",
    bucket,
    requestId: "ask",
    question: "Choose?",
    options: ["Yes"],
  });
  state = transcriptsReducer(state, {
    type: "stream_batch",
    bucket,
    events: [text("x".repeat(5 * 1024 * 1024))],
    maxSeq: 11,
  });
  state = transcriptsReducer(state, {
    type: "user_message",
    bucket,
    text: "Do not lose me",
    clientMessageId: "after-overflow",
  });
  state = transcriptsReducer(state, {
    type: "ask_user_answered",
    bucket,
    requestId: "ask",
    answer: "Yes",
  });
  state = transcriptsReducer(state, { type: "hydrate_begin", bucket, token: 2 });
  state = finish(
    state,
    [
      { seq: 9, event: start },
      { seq: 10, event: text("prefix") },
    ],
    2,
  );
  expect(state[bucket]?.messages).toContainEqual(
    expect.objectContaining({ kind: "user", clientMessageId: "after-overflow" }),
  );
  expect(state[bucket]?.messages.find((message) => message.kind === "ask_user")).toMatchObject({
    answer: "Yes",
  });
  expect(hasTranscriptRecovery(state, bucket)).toBe(false);
});

test("coalescer error and discard boundaries retain only their own raw identities", () => {
  const batches: SequencedStreamEvent[][] = [];
  const coalescer = createEventCoalescer((_events, raw) => batches.push(raw));
  coalescer.push(text("before"), 20, "epoch");
  coalescer.push({ type: "error", message: "failed" } as StreamEvent, 21, "epoch");
  coalescer.push(text("discarded"), 22, "epoch");
  coalescer.discard();
  coalescer.push(text("after"), 23, "epoch");
  coalescer.flush();
  expect(batches.map((batch) => batch.map((entry) => entry.seq))).toEqual([[20], [21], [23]]);
});
