import type { AskUserMessage, Message, UserMessage } from "../messageTypes";

export interface AskUserAnswerProjection {
  /** Draw the resolved question at the real user reply's chronological position. */
  answersByUserId: Map<string, AskUserMessage>;
  /** The original local receipt is redundant once its durable user echo is visible. */
  hiddenAskIds: Set<string>;
}

const ANSWER_CLIENT_PREFIX = "ask-user-";

function answerRequestId(message: UserMessage): string | undefined {
  const clientRequestId = message.clientMessageId?.startsWith(ANSWER_CLIENT_PREFIX)
    ? message.clientMessageId.slice(ANSWER_CLIENT_PREFIX.length)
    : undefined;
  // A legacy steer can lack its own client id. Conflicting answer identities
  // are ambiguous, however, and must not hide either recorded message.
  if (clientRequestId !== undefined && message.steerId && clientRequestId !== message.steerId)
    return undefined;
  return clientRequestId ?? message.steerId;
}

function isExactAnswerEcho(message: UserMessage, question: AskUserMessage): boolean {
  // This is the host's async-user-answer envelope, not a free-form text parser.
  // Require its exact identity AND full contents so ordinary quoted user text,
  // malformed history or an unrelated steer never loses its visible contents.
  return (
    message.text ===
    `Answer to your earlier question:\n${question.question}\n\nUser answer:\n${question.answer}`
  );
}

function sameQuestion(left: AskUserMessage, right: AskUserMessage): boolean {
  if (left === right) return true;
  if (
    left.id !== right.id ||
    left.requestId !== right.requestId ||
    left.engineSessionId !== right.engineSessionId ||
    left.source !== right.source ||
    left.expiresAt !== right.expiresAt ||
    left.question !== right.question ||
    left.header !== right.header ||
    left.multiSelect !== right.multiSelect ||
    left.optionsOnly !== right.optionsOnly ||
    left.asynchronous !== right.asynchronous ||
    left.keepWaitable !== right.keepWaitable ||
    left.skippable !== right.skippable ||
    left.answer !== right.answer
  )
    return false;
  if (left.options === right.options) return true;
  if (!left.options || !right.options || left.options.length !== right.options.length) return false;
  return left.options.every((option, index) => {
    const other = right.options![index]!;
    return (
      option.label === other.label &&
      option.description === other.description &&
      option.tone === other.tone &&
      option.recommended === other.recommended
    );
  });
}

/**
 * Presentation only: keep the original user messages for turn boundaries,
 * history recovery and context selection. Render callers hide the matched ask
 * receipt and use its question/answer at the matching user's existing position.
 * Reuse unchanged projections across stream ticks so group memoization holds.
 */
export function projectAskUserAnswers(
  messages: readonly Message[],
  previous?: AskUserAnswerProjection,
): AskUserAnswerProjection {
  const questions = new Map<string, AskUserMessage | null>();
  for (const message of messages) {
    if (
      message.kind !== "ask_user" ||
      !message.requestId ||
      typeof message.question !== "string" ||
      typeof message.answer !== "string"
    )
      continue;
    questions.set(message.requestId, questions.has(message.requestId) ? null : message);
  }

  const echoes = new Map<string, UserMessage | null>();
  const userIdCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.kind !== "user" || message.pending) continue;
    userIdCounts.set(message.id, (userIdCounts.get(message.id) ?? 0) + 1);
    const requestId = answerRequestId(message);
    const question = requestId ? questions.get(requestId) : undefined;
    if (!requestId || !question || !isExactAnswerEcho(message, question)) continue;
    echoes.set(requestId, echoes.has(requestId) ? null : message);
  }

  const answersByUserId = new Map<string, AskUserMessage>();
  const hiddenAskIds = new Set<string>();
  for (const [requestId, echo] of echoes) {
    const question = questions.get(requestId);
    if (!question || !echo || userIdCounts.get(echo.id) !== 1) continue;
    const oldQuestion = previous?.answersByUserId.get(echo.id);
    answersByUserId.set(
      echo.id,
      oldQuestion && sameQuestion(oldQuestion, question) ? oldQuestion : question,
    );
    hiddenAskIds.add(question.id);
  }

  if (
    previous &&
    previous.answersByUserId.size === answersByUserId.size &&
    previous.hiddenAskIds.size === hiddenAskIds.size &&
    [...answersByUserId].every(([id, question]) => previous.answersByUserId.get(id) === question) &&
    [...hiddenAskIds].every((id) => previous.hiddenAskIds.has(id))
  )
    return previous;
  return { answersByUserId, hiddenAskIds };
}
