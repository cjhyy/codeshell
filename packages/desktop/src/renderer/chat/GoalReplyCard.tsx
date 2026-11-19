import React from "react";
import { Button } from "@/components/ui/button";
import { Markdown, type MarkdownRootStatus } from "../Markdown";
import { useT } from "../i18n/I18nProvider";
import type { GoalQuestionDetail } from "../messageTypes";
import { goalQuestionContext } from "../../shared/goal-questions";
import {
  GoalReplyChoiceList,
  goalChoicesAnswer,
  goalChoicesComplete,
  type GoalReplyChoices,
} from "./GoalReplyChoices";

/** Background beside structured choices starts collapsed past this length. */
const LONG_CONTEXT_CHARS = 120;

interface Props {
  question: string;
  /** Consent level and structured choices; absent for a bare question. */
  detail?: GoalQuestionDetail;
  /** Options picked so far, kept by the owner across remounts. */
  choices?: GoalReplyChoices;
  onChoicesChange?: (choices: GoalReplyChoices) => void;
  disabled?: boolean;
  /** Send a picked answer. Typed answers go through the main composer. */
  onReply?: (answer: string) => void | Promise<void>;
  failed?: boolean;
  sessionId?: string | null;
  cwd?: string | null;
  rootId?: string | null;
  rootStatus?: MarkdownRootStatus;
}

/**
 * The goal's open question, shown once above the composer. It has no input of
 * its own: the user answers in the main composer, or by picking options. One
 * question is answered with one click; several are sent together once each
 * has a pick. A consent question offers explicit 同意 / 不同意 instead.
 */
export const GoalReplyCard = React.memo(function GoalReplyCard({
  question,
  detail,
  choices = {},
  onChoicesChange,
  disabled = false,
  onReply,
  failed = false,
  sessionId,
  cwd,
  rootId,
  rootStatus,
}: Props) {
  const { t } = useT();
  const questionId = React.useId();
  const [submitting, setSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  const [showFull, setShowFull] = React.useState(false);
  const locked = disabled || submitting;
  const consent = detail?.level === "consent";
  const questions = !consent && detail?.questions?.length ? detail.questions : undefined;
  // The choices already show a question that the text only restates.
  const context = goalQuestionContext(question, questions);
  // A lone question without a header is the banner's text; its cards follow it.
  const lone = questions?.length === 1 && !context ? questions[0]! : undefined;
  const shown = context || (lone && !lone.header ? lone.question : "");
  // Only background beside the choices collapses; a question is always shown whole.
  const collapsible = !!questions && !!context && context.length > LONG_CONTEXT_CHARS;
  const submit = async (answer: string): Promise<void> => {
    if (!answer || disabled || submittingRef.current || !onReply) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onReply(answer);
    } catch {
      // The owner reports the failure; the question stays open for a retry.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      className="min-w-0 space-y-1.5 border-t border-primary/20 py-2"
      data-goal-reply
      data-goal-reply-level={consent ? "consent" : "preference"}
    >
      {shown && (
        <div className="min-w-0">
          <div
            id={questionId}
            className={
              collapsible && !showFull
                ? "line-clamp-2 min-w-0 break-words text-sm [overflow-wrap:anywhere]"
                : "max-h-32 min-w-0 overflow-y-auto break-words text-sm [overflow-wrap:anywhere]"
            }
          >
            {collapsible && !showFull ? (
              shown
            ) : (
              <Markdown
                text={shown}
                sessionId={sessionId}
                cwd={cwd}
                sessionMainRootId={rootId}
                rootStatus={rootStatus}
              />
            )}
          </div>
          {collapsible && (
            <button
              type="button"
              className="mt-0.5 text-xs text-primary hover:underline"
              aria-expanded={showFull}
              onClick={() => setShowFull((value) => !value)}
            >
              {showFull ? t("chat.goal.replyShowLess") : t("chat.goal.replyShowMore")}
            </button>
          )}
        </div>
      )}
      {onReply && consent && (
        <div
          role="group"
          aria-label={t("chat.goal.replyOptions")}
          aria-describedby={questionId}
          className="flex min-w-0 flex-wrap gap-1.5"
        >
          {(["replyAgree", "replyDisagree"] as const).map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={key === "replyAgree" ? "default" : "outline"}
              disabled={locked}
              data-goal-reply-choice="option"
              className="h-auto min-h-7 rounded-full px-3 py-1 text-xs"
              onClick={() => void submit(t(`chat.goal.${key}`))}
            >
              {t(`chat.goal.${key}`)}
            </Button>
          ))}
        </div>
      )}
      {onReply && questions && (
        <GoalReplyChoiceList
          questions={questions}
          choices={choices}
          disabled={locked}
          showQuestion={!lone || !!lone.header}
          onChoose={(next) => {
            onChoicesChange?.(next);
            if (questions.length === 1) void submit(goalChoicesAnswer(questions, next));
          }}
        />
      )}
      {failed && (
        <p role="alert" className="text-xs text-status-err">
          {t("chat.goal.replyFailed")}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t(consent ? "chat.goal.replyConsentHint" : "chat.goal.replyHint")}
        </p>
        {onReply && questions && questions.length > 1 && (
          <Button
            type="button"
            size="sm"
            data-goal-reply-submit
            disabled={locked || !goalChoicesComplete(questions, choices)}
            onClick={() => void submit(goalChoicesAnswer(questions, choices))}
          >
            {t("chat.goal.replyContinue")}
          </Button>
        )}
      </div>
    </div>
  );
});
