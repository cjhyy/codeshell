import type { AgentClient } from "@cjhyy/code-shell-core";
import type { ApprovalResult } from "@cjhyy/code-shell-core/internal";

export interface PendingQuestion {
  requestId: string;
  sessionId?: string;
  question: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
  asynchronous?: boolean;
  draft?: QuestionDraft;
  submitting?: boolean;
}

export interface QuestionDraft {
  phase: "pick" | "review";
  cursor: number;
  selected: number[];
  inputValue: string;
  reviewCursor: number;
}

export interface PendingQuestionsState {
  questions: PendingQuestion[];
  activeRequestId: string | null;
}

export const INITIAL_PENDING_QUESTIONS: PendingQuestionsState = {
  questions: [],
  activeRequestId: null,
};

type Action =
  | { type: "receive"; question: PendingQuestion }
  | { type: "open_next" }
  | { type: "defer"; requestId: string }
  | { type: "draft"; requestId: string; draft: QuestionDraft }
  | { type: "submitting"; requestId: string; submitting: boolean }
  | { type: "resolve"; requestId: string; sessionId?: string };

export function activeQuestion(state: PendingQuestionsState): PendingQuestion | null {
  // A required answer retains the existing blocking prompt, even when an
  // optional question was already open. Optional questions never steal focus.
  return (
    state.questions.find((question) => !question.asynchronous) ??
    state.questions.find((question) => question.requestId === state.activeRequestId) ??
    null
  );
}

export function reducePendingQuestions(
  state: PendingQuestionsState,
  action: Action,
): PendingQuestionsState {
  switch (action.type) {
    case "receive":
      if (state.questions.some((question) => question.requestId === action.question.requestId))
        return state;
      return { ...state, questions: [...state.questions, action.question] };
    case "open_next":
      return {
        ...state,
        activeRequestId:
          state.questions.find((question) => question.asynchronous)?.requestId ?? null,
      };
    case "defer": {
      const question = state.questions.find((item) => item.requestId === action.requestId);
      if (!question?.asynchronous || question.submitting) return state;
      return {
        questions: [...state.questions.filter((item) => item !== question), question],
        activeRequestId: null,
      };
    }
    case "draft":
      return {
        ...state,
        questions: state.questions.map((question) =>
          question.requestId === action.requestId
            ? { ...question, draft: { ...action.draft, selected: [...action.draft.selected] } }
            : question,
        ),
      };
    case "submitting":
      return {
        ...state,
        questions: state.questions.map((question) =>
          question.requestId === action.requestId
            ? { ...question, submitting: action.submitting }
            : question,
        ),
      };
    case "resolve": {
      const questions = state.questions.filter(
        (question) =>
          question.requestId !== action.requestId ||
          (action.sessionId !== undefined && question.sessionId !== action.sessionId),
      );
      return {
        questions,
        activeRequestId: questions.some((question) => question.requestId === state.activeRequestId)
          ? state.activeRequestId
          : null,
      };
    }
  }
}

/** Answer the originating task even if the user switched sessions meanwhile. */
export function answerPendingQuestion(
  client: Pick<AgentClient, "approve">,
  question: PendingQuestion,
  decision: ApprovalResult,
): Promise<void> {
  return question.sessionId
    ? client.approve(question.sessionId, question.requestId, decision)
    : client.approve(question.requestId, decision);
}
