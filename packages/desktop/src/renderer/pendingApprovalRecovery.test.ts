import { expect, test } from "bun:test";
import { appendAskUserMessage, INITIAL_STATE, markAskUserAnswered } from "./types";
import { transcriptsReducer, type TranscriptsMap } from "./transcriptsReducer";
import { mergeHistoryIntoLive } from "./automation/hydrateOrder";

const bucket = "project::session";
const question = {
  requestId: "pending-question",
  engineSessionId: "session",
  question: "Which check should run?",
  options: [{ label: "Read only", description: "Inspect without writing" }],
};

test("duplicate approval snapshots preserve the existing question card and its answer", () => {
  const pending = appendAskUserMessage(INITIAL_STATE, question);
  expect(appendAskUserMessage(pending, question)).toBe(pending);
  const answered = markAskUserAnswered(pending, question.requestId, "Read only");
  expect(appendAskUserMessage(answered, { ...question, question: "Stale question" })).toBe(
    answered,
  );
  expect(
    appendAskUserMessage(answered, { ...question, requestId: "different-request" }).messages,
  ).toHaveLength(2);
});

for (const historyFirst of [false, true]) {
  test(`pending snapshot and answered cache remain one answered card (history first: ${historyFirst})`, () => {
    const history = markAskUserAnswered(
      appendAskUserMessage(INITIAL_STATE, question),
      question.requestId,
      "Read only",
    );
    let state: TranscriptsMap = transcriptsReducer({}, { type: "hydrate_begin", bucket, token: 1 });
    const restoreHistory = () => {
      state = transcriptsReducer(state, {
        type: "hydrate_history",
        bucket,
        token: 1,
        history,
        state: history,
        goalAtStart: null,
      });
    };
    if (historyFirst) restoreHistory();
    state = transcriptsReducer(state, { type: "ask_user", bucket, ...question });
    if (!historyFirst) restoreHistory();
    expect(state[bucket]?.messages).toEqual(history.messages);
    expect(state[bucket]?.messages).toHaveLength(1);
  });
}

test("an answer made during history hydration survives a replayed pending question", () => {
  const history = appendAskUserMessage(INITIAL_STATE, question);
  let state = transcriptsReducer({}, { type: "hydrate_begin", bucket, token: 1 });
  state = transcriptsReducer(state, { type: "ask_user", bucket, ...question });
  state = transcriptsReducer(state, {
    type: "ask_user_answered",
    bucket,
    requestId: question.requestId,
    answer: "Read only",
  });
  state = transcriptsReducer(state, {
    type: "hydrate_history",
    bucket,
    token: 1,
    history,
    state: history,
    goalAtStart: null,
  });
  expect(state[bucket]?.messages).toHaveLength(1);
  expect(state[bucket]?.messages[0]).toMatchObject({
    kind: "ask_user",
    requestId: question.requestId,
    answer: "Read only",
  });
});

test("a background question restored before hydration is not duplicated by its persisted card", () => {
  const history = appendAskUserMessage(INITIAL_STATE, question);
  let state: TranscriptsMap = {
    [bucket]: appendAskUserMessage(INITIAL_STATE, question),
  };
  state = transcriptsReducer(state, { type: "hydrate_begin", bucket, token: 1 });
  state = transcriptsReducer(state, {
    type: "hydrate_history",
    bucket,
    token: 1,
    history,
    state: history,
    goalAtStart: null,
  });
  expect(state[bucket]?.messages).toHaveLength(1);
});

for (const liveAnswered of [false, true]) {
  test(`question history merging keeps an existing answer and is idempotent (live answered: ${liveAnswered})`, () => {
    const cached = appendAskUserMessage(INITIAL_STATE, question);
    const restored = appendAskUserMessage(INITIAL_STATE, question);
    const history = liveAnswered
      ? cached
      : markAskUserAnswered(cached, question.requestId, "Read only");
    const live = liveAnswered
      ? markAskUserAnswered(restored, question.requestId, "Read only")
      : restored;
    const merged = mergeHistoryIntoLive(history, live);
    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]).toMatchObject({
      requestId: question.requestId,
      answer: "Read only",
    });
    expect(mergeHistoryIntoLive(history, merged).messages).toEqual(merged.messages);
  });
}
