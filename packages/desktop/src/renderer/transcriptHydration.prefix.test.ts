import { expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { FoldItem } from "../preload/types";
import { foldTranscript } from "./automation/foldTranscript";
import { INITIAL_STATE, type MessagesReducerState } from "./types";
import {
  transcriptsReducer,
  type TranscriptsAction,
  type TranscriptsMap,
} from "./transcriptsReducer";
import { transcriptRecoveryFailed } from "./transcriptHydration";

const bucket = "project::session";
const epoch = "main";
const identity = { runId: "run", clientMessageId: "first-client" };
const stream = (event: Record<string, unknown>): StreamEvent =>
  ({ ...event, ...identity }) as StreamEvent;
const events = [
  stream({ type: "session_started", sessionId: "session" }),
  stream({ type: "stream_request_start", turnNumber: 1, messageId: "first-reply" }),
  stream({
    type: "tool_use_start",
    toolCall: {
      id: "call",
      toolName: "Write",
      args: { file_path: "/work/note.txt", content: "note" },
    },
  }),
  stream({ type: "tool_result", result: { id: "call", toolName: "Write", result: "written" } }),
  stream({ type: "steer_injected", id: "second-steer", text: "continue" }),
  stream({ type: "stream_request_start", turnNumber: 2, messageId: "second-reply" }),
  stream({ type: "text_delta", text: "final " }),
  stream({ type: "text_delta", text: "reply" }),
  stream({
    type: "assistant_message",
    messageId: "second-reply",
    message: { role: "assistant", content: "final reply" },
  }),
  stream({ type: "turn_complete", reason: "completed" }),
];
const snapshot = events.map((event, index) => ({ event, seq: index + 1, epoch }));
const first: FoldItem = { kind: "user", text: "continue", clientMessageId: "first-client" };
const second: FoldItem = {
  kind: "user",
  text: "continue",
  clientMessageId: "second-client",
  steerId: "second-steer",
};
const items: FoldItem[] = [
  first,
  { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } },
  { kind: "stream", event: events[2]! },
  { kind: "stream", event: events[3]! },
  { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
  second,
  { kind: "stream", event: { type: "stream_request_start", turnNumber: 1 } },
  { kind: "stream", event: { type: "text_delta", text: "final reply" } },
  { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
];
const history = foldTranscript(items);
const begin = (map: TranscriptsMap = {}) =>
  transcriptsReducer(map, { type: "hydrate_begin", bucket, token: 1 });
function finish(
  map: TranscriptsMap,
  replayBase: MessagesReducerState,
  canonical = history,
  retained = snapshot,
) {
  return transcriptsReducer(map, {
    type: "hydrate_history",
    bucket,
    token: 1,
    epoch,
    snapshot: retained,
    replayBase,
    history: canonical,
    state: canonical,
    goalAtStart: null,
  });
}
function cache(cursor: number) {
  let state = foldTranscript([first]);
  for (const entry of snapshot.slice(0, cursor))
    state = transcriptsReducer(
      { [bucket]: state },
      {
        type: "stream_batch",
        bucket,
        events: [entry.event],
        maxSeq: entry.seq,
        epoch,
      },
    )[bucket]!;
  return state;
}

for (let cursor = 0; cursor <= snapshot.length; cursor++)
  test(`replays cache cursor ${cursor} before merging newer canonical`, () => {
    const saved = cursor === 0 ? INITIAL_STATE : cache(cursor);
    const before = JSON.stringify(saved);
    const state = finish(begin(), saved)[bucket]!;
    expect(state.messages.filter((m) => m.kind === "user").map((m) => m.clientMessageId)).toEqual([
      "first-client",
      "second-client",
    ]);
    expect(
      state.messages.filter((m) => m.kind === "assistant" && m.text === "final reply"),
    ).toHaveLength(1);
    expect(state.messages.filter((m) => m.kind === "tool")).toHaveLength(1);
    expect(state.snapshotSeq).toBe(snapshot.length);
    expect(JSON.stringify(saved)).toBe(before);
  });

for (const missing of ["reply", "input", "all"] as const)
  test(`retains terminal snapshot data when canonical lacks ${missing}`, () => {
    const canonical =
      missing === "all"
        ? INITIAL_STATE
        : foldTranscript(items.slice(0, missing === "reply" ? 6 : 5));
    const state = finish(begin(), INITIAL_STATE, canonical)[bucket]!;
    expect(
      state.messages.filter((m) => m.kind === "assistant" && m.text === "final reply"),
    ).toHaveLength(1);
    expect(
      state.messages.filter((m) => m.kind === "user" && m.steerId === "second-steer"),
    ).toHaveLength(1);
  });

test("a canonical reply cannot supply a missing stream prefix", () => {
  const state = finish(begin(), INITIAL_STATE, history, [
    { seq: 20, epoch, event: stream({ type: "text_delta", text: "orphan" }) },
  ]);
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
});

test("an old epoch's cached pointer cannot supply the new epoch's missing prefix", () => {
  const old = { ...cache(7), snapshotEpoch: "old", snapshotSeq: 900 };
  const state = finish(begin({ [bucket]: old }), old, history, [
    { seq: 1000, epoch, event: stream({ type: "text_delta", text: "orphan" }) },
  ]);
  expect(transcriptRecoveryFailed(state, bucket)).toBe(true);
  expect(state[bucket]?.snapshotEpoch).toBe("old");
});

test("a local question and answer survive canonical reconciliation around stream events", () => {
  let map = begin();
  const actions: TranscriptsAction[] = [
    { type: "stream_batch", bucket, events: [events[5]!], maxSeq: 6, epoch },
    {
      type: "ask_user",
      bucket,
      requestId: "ask",
      question: "Choose?",
      multiSelect: false,
      optionsOnly: false,
    },
    { type: "ask_user_answered", bucket, requestId: "ask", answer: "Yes" },
    { type: "stream_batch", bucket, events: [events[6]!], maxSeq: 7, epoch },
  ];
  for (const action of actions) map = transcriptsReducer(map, action);
  map = finish(map, INITIAL_STATE);
  expect(map[bucket]?.messages.filter((m) => m.kind === "ask_user")).toMatchObject([
    { requestId: "ask", answer: "Yes" },
  ]);
  expect(
    map[bucket]?.messages.filter((m) => m.kind === "assistant" && m.text === "final reply"),
  ).toHaveLength(1);
});

test("a buffered new intent and matching reply text remain a distinct later turn", () => {
  let map = begin();
  map = transcriptsReducer(map, {
    type: "user_message",
    bucket,
    text: "continue",
    clientMessageId: "third-client",
  });
  map = transcriptsReducer(map, {
    type: "stream_batch",
    bucket,
    events: [
      { type: "stream_request_start", turnNumber: 1, messageId: "third-reply" },
      { type: "text_delta", text: "final reply" },
    ],
    raw: [
      {
        seq: 11,
        epoch,
        event: { type: "stream_request_start", turnNumber: 1, messageId: "third-reply" },
      },
      { seq: 12, epoch, event: { type: "text_delta", text: "final reply" } },
    ],
    maxSeq: 12,
    epoch,
  });
  map = finish(map, INITIAL_STATE);
  expect(
    map[bucket]?.messages.filter((m) => m.kind === "user").map((m) => m.clientMessageId),
  ).toEqual(["first-client", "second-client", "third-client"]);
  expect(
    map[bucket]?.messages.filter((m) => m.kind === "assistant" && m.text === "final reply"),
  ).toHaveLength(2);
  expect(map[bucket]?.streamingAssistantId).toBe("third-reply");
});

for (const answered of [false, true])
  test(`a cached question covered by canonical is retained only when answered (${answered})`, () => {
    let map = { [bucket]: cache(5) };
    map = transcriptsReducer(map, {
      type: "ask_user",
      bucket,
      requestId: "cached",
      question: "Choose?",
      multiSelect: false,
      optionsOnly: false,
    });
    if (answered)
      map = transcriptsReducer(map, {
        type: "ask_user_answered",
        bucket,
        requestId: "cached",
        answer: "Yes",
      });
    const state = finish(begin(), map[bucket]!)[bucket]!;
    const questions = state.messages.filter((m) => m.kind === "ask_user");
    expect(questions).toHaveLength(answered ? 1 : 0);
    if (answered) expect(questions[0]).toMatchObject({ requestId: "cached", answer: "Yes" });
  });

test("an ambiguous durable steer does not fall back to an unrelated matching client id", () => {
  const canonical = foldTranscript([
    { kind: "user", text: "one", clientMessageId: "one", steerId: "conflict" },
    { kind: "user", text: "two", clientMessageId: "two", steerId: "conflict" },
    { kind: "user", text: "unrelated", clientMessageId: "conflict" },
  ]);
  const state = finish(begin(), INITIAL_STATE, canonical, [
    {
      seq: 1,
      epoch,
      event: stream({ type: "steer_injected", id: "conflict", text: "actual injection" }),
    },
  ])[bucket]!;
  expect(state.messages.at(-1)).toMatchObject({
    kind: "user",
    steerId: "conflict",
    text: "actual injection",
  });
  expect(state.messages.at(-1)?.clientMessageId).toBeUndefined();
});

test("canonical and journal copies of one Stop leave the partial before one detailed marker", () => {
  const input: FoldItem = { kind: "user", text: "Stop", clientMessageId: "stop" };
  const prefix = foldTranscript([input]);
  let map = begin({ [bucket]: prefix });
  map = transcriptsReducer(map, {
    type: "stream_batch",
    bucket,
    epoch,
    maxSeq: 2,
    events: [
      { type: "stream_request_start", turnNumber: 1, messageId: "partial" },
      { type: "text_delta", text: "Partial" },
    ],
    raw: [
      {
        seq: 1,
        epoch,
        event: { type: "stream_request_start", turnNumber: 1, messageId: "partial" },
      },
      { seq: 2, epoch, event: { type: "text_delta", text: "Partial" } },
    ],
  });
  map = transcriptsReducer(map, {
    type: "turn_end",
    bucket,
    reason: "stopped",
    elapsedMs: 123,
    detail: "local detail",
  });
  const state = finish(map, prefix, foldTranscript([input, { kind: "turn_stopped" }]), [])[bucket]!;
  expect(state.messages.map((m) => m.kind)).toEqual(["user", "assistant", "turn_end"]);
  expect(state.messages.at(-1)).toMatchObject({
    reason: "stopped",
    elapsedMs: 123,
    detail: "local detail",
  });
  expect(state.streamingAssistantId).toBeNull();
});

test("Stops in different user intents remain separate", () => {
  const old: FoldItem = { kind: "user", text: "Stop", clientMessageId: "old" };
  const next: FoldItem = { kind: "user", text: "Stop", clientMessageId: "next" };
  const prefix = foldTranscript([old, { kind: "turn_stopped" }, next]);
  let map = begin({ [bucket]: prefix });
  map = transcriptsReducer(map, { type: "turn_end", bucket, reason: "stopped", elapsedMs: 456 });
  const state = finish(
    map,
    prefix,
    foldTranscript([old, { kind: "turn_stopped" }, next, { kind: "turn_stopped" }]),
    [],
  )[bucket]!;
  expect(state.messages.map((m) => m.kind)).toEqual(["user", "turn_end", "user", "turn_end"]);
  expect(state.messages.at(-1)).toMatchObject({ elapsedMs: 456 });
});

test("a guarded local goal rollback cannot overwrite a newer replayed goal", () => {
  let map = begin();
  map = transcriptsReducer(map, {
    type: "goal_reconcile",
    bucket,
    expected: null,
    goal: { goalId: "old", revision: 1, objective: "old" } as any,
  });
  const state = finish(map, INITIAL_STATE, INITIAL_STATE, [
    {
      seq: 1,
      epoch,
      event: { type: "goal_set", goalId: "new", revision: 2, objective: "new" } as StreamEvent,
    },
  ])[bucket]!;
  expect(state.activeGoal).toMatchObject({ goalId: "new", revision: 2, objective: "new" });
});

test("restoring an answered question keeps an active agent index on its original card", () => {
  let map = { [bucket]: cache(5) };
  map = transcriptsReducer(map, {
    type: "ask_user",
    bucket,
    requestId: "cached-agent",
    question: "Choose?",
    multiSelect: false,
    optionsOnly: false,
  });
  map = transcriptsReducer(map, {
    type: "ask_user_answered",
    bucket,
    requestId: "cached-agent",
    answer: "Yes",
  });
  map = transcriptsReducer(map, {
    type: "stream",
    bucket,
    event: { type: "agent_start", agentId: "child", name: "Child", description: "Work" },
  });
  const cached = map[bucket]!;
  const state = finish(begin(), cached)[bucket]!;
  expect(state.messages[state.agentMessageIndex.child!]?.id).toBe("child");
  expect(state.messages.filter((m) => m.kind === "ask_user")).toHaveLength(1);
});

for (const persistedPartial of [false, true])
  test(`a cached Stop merges after its partial (partial persisted: ${persistedPartial})`, () => {
    const input: FoldItem = { kind: "user", text: "Stop", clientMessageId: "cached-stop" };
    let map = { [bucket]: foldTranscript([input]) };
    map = transcriptsReducer(map, {
      type: "stream_batch",
      bucket,
      epoch,
      maxSeq: 2,
      events: [
        { type: "stream_request_start", turnNumber: 1, messageId: "cached-partial" },
        { type: "text_delta", text: "Partial" },
      ],
    });
    map = transcriptsReducer(map, {
      type: "turn_end",
      bucket,
      reason: "stopped",
      elapsedMs: 800,
      detail: "saved detail",
    });
    const state = finish(
      begin(),
      map[bucket]!,
      foldTranscript([
        input,
        ...(persistedPartial
          ? ([
              { kind: "stream", event: { type: "stream_request_start", turnNumber: 1 } },
              { kind: "stream", event: { type: "text_delta", text: "Partial" } },
            ] as FoldItem[])
          : []),
        { kind: "turn_stopped" },
      ]),
      [],
    )[bucket]!;
    expect(state.messages.map((m) => m.kind)).toEqual(["user", "assistant", "turn_end"]);
    expect(state.messages.at(-1)).toMatchObject({
      reason: "stopped",
      elapsedMs: 800,
      detail: "saved detail",
    });
    expect(state.streamingAssistantId).toBeNull();
  });

for (const fresh of [false, true])
  test(`compaction discards cached decisions but retains current journal decisions (${fresh})`, () => {
    const input: FoldItem = { kind: "user", text: "first", clientMessageId: "compacted" };
    const next: FoldItem = { kind: "user", text: "next", clientMessageId: "next" };
    let cached = { [bucket]: foldTranscript([input]) };
    for (const action of [
      {
        type: "ask_user",
        bucket,
        requestId: "old",
        question: "Old?",
        multiSelect: false,
        optionsOnly: false,
      },
      { type: "ask_user_answered", bucket, requestId: "old", answer: "Yes" },
      { type: "turn_end", bucket, reason: "stopped", elapsedMs: 100 },
    ] as TranscriptsAction[])
      cached = transcriptsReducer(cached, action);
    const later: TranscriptsAction[] = [
      { type: "user_message", bucket, text: "next", clientMessageId: "next" },
      { type: "stream", bucket, event: { type: "stream_request_start", turnNumber: 2 } },
      { type: "stream", bucket, event: { type: "text_delta", text: "later reply" } },
      { type: "stream", bucket, event: { type: "turn_complete", reason: "completed" } },
    ];
    if (!fresh) for (const action of later) cached = transcriptsReducer(cached, action);
    const canonical = foldTranscript([
      input,
      next,
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 2 } },
      { kind: "stream", event: { type: "text_delta", text: "later reply" } },
      { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
    ]);
    canonical.messages.splice(1, 0, {
      kind: "context_boundary",
      id: "boundary",
      strategy: "compacted",
      before: 200,
      after: 100,
    } as any);
    let map = begin();
    if (fresh) {
      map = transcriptsReducer(map, {
        type: "ask_user",
        bucket,
        requestId: "new",
        question: "Now?",
        multiSelect: false,
        optionsOnly: false,
      });
      map = transcriptsReducer(map, {
        type: "ask_user_answered",
        bucket,
        requestId: "new",
        answer: "Yes",
      });
      map = transcriptsReducer(map, {
        type: "turn_end",
        bucket,
        reason: "stopped",
        elapsedMs: 200,
      });
      for (const action of later) map = transcriptsReducer(map, action);
    }
    const state = finish(map, cached[bucket]!, canonical, [])[bucket]!;
    expect(state.messages.filter((m) => m.kind === "ask_user").map((m) => m.requestId)).toEqual(
      fresh ? ["new"] : [],
    );
    expect(state.messages.filter((m) => m.kind === "turn_end").map((m) => m.elapsedMs)).toEqual(
      fresh ? [200] : [],
    );
    expect(state.messages.filter((m) => m.kind === "context_boundary")).toHaveLength(1);
  });

test("an older cache containing two copies of a Stop is repaired once and stays idempotent", () => {
  const input: FoldItem = { kind: "user", text: "Stop", clientMessageId: "double-stop" };
  const canonical = foldTranscript([
    input,
    { kind: "stream", event: { type: "stream_request_start", turnNumber: 1 } },
    { kind: "stream", event: { type: "text_delta", text: "Partial" } },
    { kind: "turn_stopped" },
  ]);
  let cached = {
    ...canonical,
    messages: [
      ...canonical.messages,
      {
        kind: "turn_end",
        id: "detailed-stop",
        reason: "stopped",
        elapsedMs: 823,
        detail: "saved",
      } as const,
    ],
  };
  const original = JSON.stringify(cached);
  for (let pass = 0; pass < 3; pass++) {
    cached = finish(begin(), cached, canonical, [])[bucket]!;
    expect(cached.messages.map((m) => m.kind)).toEqual(["user", "assistant", "turn_end"]);
    expect(cached.messages.at(-1)).toMatchObject({
      id: "detailed-stop",
      elapsedMs: 823,
      detail: "saved",
    });
  }
  expect(JSON.parse(original).messages).toHaveLength(4);
});

test("contradictory repeated user identities do not collapse their Stop markers", () => {
  const canonical = foldTranscript([
    { kind: "user", text: "first", clientMessageId: "first" },
    { kind: "turn_stopped" },
    { kind: "user", text: "second", clientMessageId: "second" },
    { kind: "turn_stopped" },
  ]);
  canonical.messages = canonical.messages.map((message) =>
    message.kind === "user" ? { ...message, clientMessageId: "ambiguous" } : message,
  );
  const state = finish(begin(), canonical, canonical, [])[bucket]!;
  expect(state.messages.map((m) => m.kind)).toEqual(["user", "turn_end", "user", "turn_end"]);
});
