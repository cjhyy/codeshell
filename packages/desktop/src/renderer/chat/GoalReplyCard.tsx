import React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown, type MarkdownRootStatus } from "../Markdown";
import { useT } from "../i18n/I18nProvider";
import type { GoalUserQuestion } from "../types";
import { goalQuestionsText } from "../../shared/goal-questions";
import {
  GoalReplyChoiceList,
  goalChoicesAnswer,
  goalChoicesComplete,
  type GoalReplyChoices,
} from "./GoalReplyChoices";

/** Context longer than this starts collapsed. */
const LONG_CONTEXT_CHARS = 120;

interface Props {
  question: string;
  /** Structured choices; when present they replace the free-text box. */
  questions?: readonly GoalUserQuestion[];
  choices?: GoalReplyChoices;
  onChoicesChange?: (choices: GoalReplyChoices) => void;
  disabled?: boolean;
  onReply?: (answer: string) => void | Promise<void>;
  draft: string;
  onDraftChange: (draft: string) => void;
  failed?: boolean;
  sessionId?: string | null;
  cwd?: string | null;
  rootId?: string | null;
  rootStatus?: MarkdownRootStatus;
}

/** Keyed by the owning session/goal/question, so drafts cannot cross questions. */
export const GoalReplyCard = React.memo(function GoalReplyCard({
  question,
  questions,
  choices = {},
  onChoicesChange,
  disabled = false,
  onReply,
  draft,
  onDraftChange,
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
  const composingRef = React.useRef(false);
  const locked = disabled || submitting;
  const structured = questions && questions.length > 0 ? questions : undefined;
  // Without an explicit `question`, main fills it with the choices' text form;
  // the choices already show that, so it is not repeated as context.
  const context = structured && question === goalQuestionsText(structured) ? "" : question;
  const [showFull, setShowFull] = React.useState(false);
  const collapsible = context.length > LONG_CONTEXT_CHARS;
  const ready = structured ? goalChoicesComplete(structured, choices) : !!draft.trim();
  const submit = async (): Promise<void> => {
    if (!ready) return;
    const answer = structured ? goalChoicesAnswer(structured, choices) : draft.trim();
    if (!answer || disabled || submittingRef.current || !onReply) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onReply(answer);
    } catch {
      // The owner retains the draft/error across optimistic run state changes.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="min-w-0 space-y-2 border-t border-primary/20 py-2" data-goal-reply>
      <p id={questionId} className="text-xs font-medium text-primary">
        {t("chat.goal.barWaitingHint")}
      </p>
      {context && (
        <div className="min-w-0">
          <div
            className={
              collapsible && !showFull
                ? "line-clamp-2 min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
                : "max-h-40 min-w-0 overflow-y-auto break-words text-sm [overflow-wrap:anywhere]"
            }
          >
            {collapsible && !showFull ? (
              context
            ) : (
              <Markdown
                text={context}
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
      {onReply && (
        <form
          className="space-y-2"
          aria-labelledby={questionId}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {structured ? (
            <GoalReplyChoiceList
              questions={structured}
              choices={choices}
              disabled={locked}
              onChange={(next) => onChoicesChange?.(next)}
              onSubmitShortcut={() => void submit()}
            />
          ) : (
            <Textarea
              value={draft}
              rows={2}
              disabled={locked}
              aria-label={t("chat.goal.replyInput")}
              placeholder={t("chat.goal.replyPlaceholder")}
              className="max-h-32 min-h-0 resize-y text-sm"
              onChange={(event) => {
                onDraftChange(event.target.value);
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing &&
                  !composingRef.current &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          )}
          {failed && (
            <p role="alert" className="text-xs text-status-err">
              {t("chat.goal.replyFailed")}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("chat.goal.replyHint")}</span>
            <Button type="submit" size="sm" disabled={locked || !ready}>
              {t("chat.goal.replyContinue")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
});
