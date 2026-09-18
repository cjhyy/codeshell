import { expect, test } from "bun:test";
import { foldTranscript } from "./foldTranscript";
import { chooseHydrateBase, mergeHistoryIntoLive } from "./hydrateOrder";
import { mergeHistoryWindows } from "../app/mergeHistoryWindows";
import { transcriptsReducer, type TranscriptsMap } from "../transcriptsReducer";
import { INITIAL_STATE, type Message, type MessagesReducerState } from "../types";
import type { StreamEvent } from "@cjhyy/code-shell-core";

const event: StreamEvent = { type: "steer_injected", id: "steer", text: "same request" };
const history = foldTranscript([
  { kind: "user", text: "same request", clientMessageId: "client", steerId: "steer" },
  { kind: "stream", event: { type: "stream_request_start", turnNumber: 1 } },
  { kind: "stream", event: { type: "text_delta", text: "answer" } },
  { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
]);

for (const historyFirst of [false, true]) {
  test(`ordinary chat identified steer joins history (history first: ${historyFirst})`, () => {
    let map: TranscriptsMap = historyFirst ? { b: history } : {};
    for (const item of [
      event,
      event,
      { type: "stream_request_start", turnNumber: 1, messageId: "live-answer" },
      { type: "text_delta", text: "answer" },
      { type: "turn_complete", reason: "completed" },
    ] as StreamEvent[]) {
      map = transcriptsReducer(map, { type: "stream", bucket: "b", event: item });
    }
    for (let repeat = 0; repeat < 3; repeat++) {
      map = transcriptsReducer(map, {
        type: "hydrate_history",
        bucket: "b",
        history,
        state: history,
        goalAtStart: null,
      });
      expect(
        map.b!.messages.map((message) => ({ kind: message.kind, text: message.text })),
      ).toEqual([
        { kind: "user", text: "same request" },
        { kind: "assistant", text: "answer" },
      ]);
      expect(map.b!.messages[0]).toMatchObject({ clientMessageId: "client", steerId: "steer" });
    }
  });
}

test("ordinary cached steers are aligned before the initial disk and snapshot recovery", () => {
  const events = [
    event,
    { type: "stream_request_start", turnNumber: 1, messageId: "live-answer" },
    { type: "text_delta", text: "answer" },
    { type: "turn_complete", reason: "completed" },
  ] as StreamEvent[];
  let saved = transcriptsReducer(
    {},
    {
      type: "stream_batch",
      bucket: "b",
      events,
      maxSeq: 4,
      epoch: "main",
    },
  ).b!;
  expect(saved.messages[0]).toMatchObject({ steerId: "steer" });
  expect(saved.messages[0]?.clientMessageId).toBeUndefined();
  const snapshot = events.map((event, index) => ({ event, seq: index + 1, epoch: "main" }));
  for (let repeat = 0; repeat < 3; repeat++) {
    const disk = {
      ...history,
      messages: history.messages.map((m) => ({ ...m, id: `${m.id}-${repeat}` })),
    };
    const base = mergeHistoryWindows(disk, saved);
    expect(chooseHydrateBase(disk, saved).messages).toHaveLength(2);
    let map = transcriptsReducer({}, { type: "hydrate_begin", bucket: "b", token: repeat });
    map = transcriptsReducer(map, {
      type: "hydrate_history",
      bucket: "b",
      history: base,
      state: base,
      goalAtStart: null,
      token: repeat,
      snapshot,
      epoch: "main",
    });
    expect(map.b!.messages).toHaveLength(2);
    expect(map.b!.messages[0]).toMatchObject({ clientMessageId: "client", steerId: "steer" });
    expect(map.b!.snapshotSeq).toBe(4);
    saved = map.b!;
  }
});

test("ordinary hydration applies a retained steer and overlapping live delivery once", () => {
  const events = [
    event,
    { type: "stream_request_start", turnNumber: 1, messageId: "reply" },
    { type: "text_delta", text: "partial" },
  ] as StreamEvent[];
  const raw = events.map((event, index) => ({ event, seq: index + 1, epoch: "main" }));
  let map = transcriptsReducer({}, { type: "hydrate_begin", bucket: "b", token: 1 });
  for (let repeat = 0; repeat < 2; repeat++)
    map = transcriptsReducer(map, {
      type: "stream_batch",
      bucket: "b",
      events,
      raw,
      maxSeq: 3,
      epoch: "main",
    });
  const disk = foldTranscript([
    { kind: "user", text: "same request", clientMessageId: "client", steerId: "steer" },
  ]);
  map = transcriptsReducer(map, {
    type: "hydrate_history",
    bucket: "b",
    history: disk,
    state: disk,
    goalAtStart: null,
    token: 1,
    snapshot: raw,
    epoch: "main",
  });
  expect(map.b!.messages).toHaveLength(2);
  expect(map.b!.messages[0]).toMatchObject({ clientMessageId: "client", steerId: "steer" });
  expect(map.b!.messages[1]).toMatchObject({ kind: "assistant", text: "partial" });
  map = transcriptsReducer(map, {
    type: "stream",
    bucket: "b",
    event: { type: "text_delta", text: " continues" },
  });
  expect(map.b!.messages[1]).toMatchObject({ text: "partial continues" });
});

function state(messages: Message[]): MessagesReducerState {
  return { ...INITIAL_STATE, messages };
}
const user = (id: string, steerId?: string, clientMessageId?: string): Message => ({
  kind: "user",
  id,
  steerId,
  clientMessageId,
  text: "same request",
});
const assistant = (id: string): Message => ({ kind: "assistant", id, text: "answer", done: true });

test("same text in separate steer intents never becomes an alias", () => {
  const disk = state([user("d-user", "old-steer", "old-client"), assistant("d-answer")]);
  const live = state([user("l-user", "new-steer"), assistant("l-answer")]);
  expect(mergeHistoryIntoLive(disk, live).messages).toEqual([...disk.messages, ...live.messages]);
});

test("an existing different client id cannot be overwritten by a shared steer id", () => {
  const disk = state([user("d-user", "shared", "disk-client"), assistant("d-answer")]);
  const live = state([user("l-user", "shared", "live-client"), assistant("l-answer")]);
  expect(mergeHistoryIntoLive(disk, live).messages).toEqual([...disk.messages, ...live.messages]);
});

test("contradictory durable aliases remain ambiguous even when the last id repeats", () => {
  const disk = state([
    user("d-one", "shared", "one"),
    user("d-two", "shared", "two"),
    user("d-three", "shared", "two"),
  ]);
  const live = state([user("l-user", "shared"), assistant("l-answer")]);
  expect(mergeHistoryIntoLive(disk, live).messages).toEqual([...disk.messages, ...live.messages]);
});

test("a paged history without the steer anchor keeps the live input and partial tail", () => {
  const live = state([user("l-user", "new-steer"), assistant("l-answer")]);
  expect(mergeHistoryIntoLive(INITIAL_STATE, live).messages).toEqual(live.messages);
});

test("aligns repeated durable evidence of one identity without mutating its live source", () => {
  const disk = state([user("d-one", "shared", "one"), user("d-two", "shared", "one")]);
  const live = state([user("l-user", "shared"), assistant("l-answer")]);
  const merged = mergeHistoryIntoLive(disk, live);
  expect(merged.messages).toEqual([...disk.messages, live.messages[1]!]);
  expect(live.messages[0]).not.toHaveProperty("clientMessageId", "one");
});
