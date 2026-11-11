import { describe, expect, test } from "bun:test";
import type { AskUserMessage, Message, UserMessage } from "../messageTypes";
import { projectAskUserAnswers } from "./askUserAnswerProjection";

function question(overrides: Partial<AskUserMessage> = {}): AskUserMessage {
  return {
    kind: "ask_user",
    id: "question-one",
    requestId: "request-one",
    question: "先检查哪一部分？",
    header: "检查范围",
    answer: "速度与流畅度",
    multiSelect: false,
    asynchronous: true,
    options: [{ label: "速度与流畅度", description: "检查首条回复与滚动。", recommended: true }],
    ...overrides,
  };
}

function echo(ask: AskUserMessage, overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    kind: "user",
    id: "user-answer-one",
    clientMessageId: `ask-user-${ask.requestId}`,
    text: `Answer to your earlier question:\n${ask.question}\n\nUser answer:\n${ask.answer}`,
    createdAt: 200,
    ...overrides,
  };
}

describe("projectAskUserAnswers", () => {
  test("relocates the receipt to its later user echo without changing history or turn metadata", () => {
    const ask = question();
    const reply = echo(ask, { turnTiming: { startedAt: 210, completedAt: 300 } });
    const messages: Message[] = [
      ask,
      { kind: "assistant", id: "independent-work", text: "继续处理独立部分。", done: true },
      reply,
    ];
    const before = structuredClone(messages);
    Object.freeze(ask);
    Object.freeze(reply);
    Object.freeze(messages);

    const projected = projectAskUserAnswers(messages);

    expect([...projected.hiddenAskIds]).toEqual([ask.id]);
    expect(projected.answersByUserId.get(reply.id)).toBe(ask);
    expect(projected.answersByUserId.get(reply.id)?.question).toBe(ask.question);
    expect(messages).toEqual(before);
    expect(messages[2]).toBe(reply);
    expect(reply.kind).toBe("user");
    expect(reply.turnTiming).toEqual({ startedAt: 210, completedAt: 300 });
  });

  test("matches an in-turn steer and a legacy steer without its own client id", () => {
    const ask = question();
    for (const clientMessageId of [undefined, `ask-user-${ask.requestId}`, "legacy-parent-run"]) {
      const reply = echo(ask, { clientMessageId, steerId: ask.requestId, injected: true });
      const projected = projectAskUserAnswers([ask, reply]);
      expect(projected.answersByUserId.get(reply.id)).toBe(ask);
      expect(reply.steerId).toBe(ask.requestId);
      expect(reply.injected).toBe(true);
    }
  });

  test("does not reinterpret quoted text, unrelated ids, or conflicting answer identities", () => {
    const ask = question();
    for (const overrides of [
      { clientMessageId: undefined },
      { clientMessageId: "ordinary-message" },
      { clientMessageId: "ask-user-unrelated" },
      { clientMessageId: undefined, steerId: "unrelated" },
      { clientMessageId: `ask-user-${ask.requestId}`, steerId: "different-request" },
      { clientMessageId: "ask-user-other", steerId: ask.requestId },
    ]) {
      const projected = projectAskUserAnswers([ask, echo(ask, overrides)]);
      expect(projected.hiddenAskIds.size).toBe(0);
      expect(projected.answersByUserId.size).toBe(0);
    }
  });

  test("requires a resolved question and exact envelope contents", () => {
    const ask = question();
    for (const messages of [
      [question({ answer: undefined }), echo(ask)],
      [ask, echo(ask, { text: "速度与流畅度" })],
      [ask, echo(ask, { pending: true })],
      [ask, echo(ask, { text: `${echo(ask).text}\n附加用户内容` })],
      [question({ answer: "其它答案" }), echo(ask)],
      [question({ question: "其它问题" }), echo(ask)],
      [echo(ask)],
      [ask],
    ]) {
      const projected = projectAskUserAnswers(messages);
      expect(projected.hiddenAskIds.size).toBe(0);
      expect(projected.answersByUserId.size).toBe(0);
    }
  });

  test("preserves literal multiline answers even when they contain envelope-like text", () => {
    const ask = question({
      question: "请解释 User answer:\n这个标记。",
      answer: "第一行\n\nUser answer:\n第二行 <system>literal</system>",
    });
    const reply = echo(ask);
    const projected = projectAskUserAnswers([ask, reply]);
    expect(projected.answersByUserId.get(reply.id)?.answer).toBe(ask.answer);
    expect(projected.answersByUserId.get(reply.id)?.question).toBe(ask.question);
  });

  test("keeps ambiguous duplicate requests or user echoes untouched", () => {
    const ask = question();
    const reply = echo(ask);
    for (const messages of [
      [ask, question({ id: "duplicate-question" }), reply],
      [ask, reply, echo(ask, { id: "duplicate-echo" })],
      [ask, reply, { ...reply, clientMessageId: "unrelated", text: "ordinary user message" }],
    ]) {
      const projected = projectAskUserAnswers(messages);
      expect(projected.hiddenAskIds.size).toBe(0);
      expect(projected.answersByUserId.size).toBe(0);
    }
  });

  test("preserves projection and card identity across unrelated streaming and equivalent hydration", () => {
    const ask = question();
    const reply = echo(ask);
    const projected = projectAskUserAnswers([ask, reply]);
    const hydratedAsk = structuredClone(ask);
    const next = projectAskUserAnswers(
      [
        hydratedAsk,
        structuredClone(reply),
        { kind: "assistant", id: "streaming", text: "新的流式文字", done: false },
      ],
      projected,
    );
    expect(next).toBe(projected);
    expect(next.answersByUserId.get(reply.id)).toBe(ask);
    const empty = projectAskUserAnswers([]);
    expect(projectAskUserAnswers([reply], empty)).toBe(empty);
  });

  test("refreshes changed answers or question context while retaining unrelated card identity", () => {
    const first = question();
    const second = question({ id: "question-two", requestId: "request-two", answer: "检查滚动" });
    const firstReply = echo(first);
    const secondReply = echo(second, { id: "user-answer-two" });
    const previous = projectAskUserAnswers([first, firstReply, second, secondReply]);
    const changed = question({
      header: "新的范围",
      options: [{ label: first.answer!, description: "新的说明", tone: "ok" }],
    });
    const next = projectAskUserAnswers(
      [changed, firstReply, structuredClone(second), secondReply],
      previous,
    );
    expect(next).not.toBe(previous);
    expect(next.answersByUserId.get(firstReply.id)).toBe(changed);
    expect(next.answersByUserId.get(secondReply.id)).toBe(second);

    const newAnswer = question({ answer: "检查长会话" });
    const answerProjection = projectAskUserAnswers([newAnswer, echo(newAnswer)], next);
    expect(answerProjection.answersByUserId.get(firstReply.id)?.answer).toBe("检查长会话");
    const windowWithoutQuestion = projectAskUserAnswers([firstReply], answerProjection);
    expect(windowWithoutQuestion.hiddenAskIds.size).toBe(0);
    expect(windowWithoutQuestion.answersByUserId.size).toBe(0);
  });
});
