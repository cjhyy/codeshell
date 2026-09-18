import { expect, test } from "bun:test";
import {
  activeQuestion,
  answerPendingQuestion,
  INITIAL_PENDING_QUESTIONS,
  reducePendingQuestions,
  type PendingQuestion,
} from "./pending-questions.js";

const optional: PendingQuestion = {
  requestId: "a",
  sessionId: "origin",
  question: "Color?",
  asynchronous: true,
};

test("optional questions queue without taking input focus or overwriting earlier questions", () => {
  let state = reducePendingQuestions(INITIAL_PENDING_QUESTIONS, {
    type: "receive",
    question: optional,
  });
  state = reducePendingQuestions(state, {
    type: "receive",
    question: { ...optional, requestId: "b" },
  });
  expect(state.questions).toHaveLength(2);
  expect(activeQuestion(state)).toBeNull();
  expect(reducePendingQuestions(state, { type: "receive", question: optional })).toBe(state);
  state = reducePendingQuestions(state, { type: "open_next" });
  expect(activeQuestion(state)?.requestId).toBe("a");
  state = reducePendingQuestions(state, { type: "defer", requestId: "a" });
  expect(activeQuestion(state)).toBeNull();
  expect(state.questions.map((question) => question.requestId)).toEqual(["b", "a"]);
  state = reducePendingQuestions(state, { type: "open_next" });
  expect(activeQuestion(state)?.requestId).toBe("b");
});

test("required questions still display immediately and survive optional-question deferral", () => {
  let state = reducePendingQuestions(INITIAL_PENDING_QUESTIONS, {
    type: "receive",
    question: optional,
  });
  state = reducePendingQuestions(state, { type: "open_next" });
  const required = { ...optional, requestId: "required", asynchronous: false };
  state = reducePendingQuestions(state, { type: "receive", question: required });
  expect(activeQuestion(state)).toEqual(required);
  expect(reducePendingQuestions(state, { type: "defer", requestId: "required" })).toBe(state);
  state = reducePendingQuestions(state, {
    type: "resolve",
    requestId: "required",
    sessionId: "origin",
  });
  expect(activeQuestion(state)?.requestId).toBe("a");
});

test("resolution clears open and deferred questions only for the originating session", () => {
  let state = reducePendingQuestions(INITIAL_PENDING_QUESTIONS, {
    type: "receive",
    question: optional,
  });
  state = reducePendingQuestions(state, { type: "open_next" });
  state = reducePendingQuestions(state, {
    type: "resolve",
    requestId: "a",
    sessionId: "different",
  });
  expect(activeQuestion(state)?.requestId).toBe("a");
  state = reducePendingQuestions(state, { type: "resolve", requestId: "a", sessionId: "origin" });
  expect(activeQuestion(state)).toBeNull();
  expect(state.questions).toHaveLength(0);
  state = reducePendingQuestions(state, { type: "receive", question: optional });
  state = reducePendingQuestions(state, { type: "resolve", requestId: "a", sessionId: "origin" });
  expect(state.questions).toHaveLength(0);
});

test("answers use the stored origin session and preserve the legacy client form", async () => {
  const calls: unknown[][] = [];
  const client = {
    approve: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve();
    },
  };
  const answer = { approved: true as const, answer: "blue" };
  await answerPendingQuestion(client, optional, answer);
  await answerPendingQuestion(client, { ...optional, sessionId: undefined }, answer);
  expect(calls).toEqual([
    ["origin", "a", answer],
    ["a", answer],
  ]);
});

test("question drafts stay attached to their request across deferral and another question", () => {
  let state = reducePendingQuestions(INITIAL_PENDING_QUESTIONS, {
    type: "receive",
    question: optional,
  });
  state = reducePendingQuestions(state, {
    type: "receive",
    question: { ...optional, requestId: "b" },
  });
  const draft = {
    phase: "review" as const,
    cursor: 2,
    selected: [0, 1],
    inputValue: "keep this text",
    reviewCursor: 0,
  };
  state = reducePendingQuestions(state, { type: "draft", requestId: "a", draft });
  draft.selected.push(5);
  state = reducePendingQuestions(state, { type: "defer", requestId: "a" });
  state = reducePendingQuestions(state, { type: "open_next" });
  expect(activeQuestion(state)?.requestId).toBe("b");
  expect(activeQuestion(state)?.draft).toBeUndefined();
  state = reducePendingQuestions(state, { type: "resolve", requestId: "b", sessionId: "origin" });
  state = reducePendingQuestions(state, { type: "open_next" });
  expect(activeQuestion(state)?.draft).toEqual({ ...draft, selected: [0, 1] });
});

test("submission state belongs to the request and blocks deferral until a failure unlocks it", () => {
  let state = reducePendingQuestions(INITIAL_PENDING_QUESTIONS, {
    type: "receive",
    question: optional,
  });
  state = reducePendingQuestions(state, { type: "submitting", requestId: "a", submitting: true });
  state = reducePendingQuestions(state, { type: "open_next" });
  expect(activeQuestion(state)?.submitting).toBe(true);
  expect(reducePendingQuestions(state, { type: "defer", requestId: "a" })).toBe(state);
  state = reducePendingQuestions(state, { type: "submitting", requestId: "a", submitting: false });
  state = reducePendingQuestions(state, { type: "defer", requestId: "a" });
  expect(activeQuestion(state)).toBeNull();
  state = reducePendingQuestions(state, { type: "resolve", requestId: "a", sessionId: "origin" });
  state = reducePendingQuestions(state, { type: "submitting", requestId: "a", submitting: false });
  expect(state.questions).toHaveLength(0);
});
