import React from "react";
import { Button } from "@/components/ui/button";
import { Markdown, type MarkdownRootStatus } from "../Markdown";
import { useT } from "../i18n/I18nProvider";
import type { GoalQuestionDetail } from "../messageTypes";

interface Props {
  question: string;
  /** Option chips, default and consent level; absent for a bare question. */
  detail?: GoalQuestionDetail;
  disabled?: boolean;
  /** Send one chip's answer. Typed answers go through the main composer. */
  onReply?: (answer: string) => void | Promise<void>;
  failed?: boolean;
  sessionId?: string | null;
  cwd?: string | null;
  rootId?: string | null;
  rootStatus?: MarkdownRootStatus;
}

/**
 * The goal's open question, shown once above the composer. It has no input of
 * its own: the user answers in the main composer, or with one click on a chip.
 * A consent question offers explicit 同意 / 不同意 instead of model options.
 */
export const GoalReplyCard = React.memo(function GoalReplyCard({
  question,
  detail,
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
  const locked = disabled || submitting;
  const consent = detail?.level === "consent";
  const choices: Array<{ answer: string; label: string; primary: boolean; isDefault: boolean }> =
    consent
      ? [
          {
            answer: t("chat.goal.replyAgree"),
            label: t("chat.goal.replyAgree"),
            primary: true,
            isDefault: false,
          },
          {
            answer: t("chat.goal.replyDisagree"),
            label: t("chat.goal.replyDisagree"),
            primary: false,
            isDefault: false,
          },
        ]
      : [
          ...(detail?.options ?? []),
          // A free-text default is still one click away.
          ...(detail?.default && !detail.options?.includes(detail.default) ? [detail.default] : []),
        ].map((option) => ({
          answer: option,
          label: option,
          primary: false,
          isDefault: option === detail?.default,
        }));
  const submit = async (answer: string): Promise<void> => {
    if (disabled || submittingRef.current || !onReply) return;
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
      <div
        id={questionId}
        className="max-h-32 min-w-0 overflow-y-auto break-words text-sm [overflow-wrap:anywhere]"
      >
        <Markdown
          text={question}
          sessionId={sessionId}
          cwd={cwd}
          sessionMainRootId={rootId}
          rootStatus={rootStatus}
        />
      </div>
      {onReply && choices.length > 0 && (
        <div
          role="group"
          aria-label={t("chat.goal.replyOptions")}
          aria-describedby={questionId}
          className="flex min-w-0 flex-wrap gap-1.5"
        >
          {choices.map((choice) => (
            <Button
              key={choice.answer}
              type="button"
              size="sm"
              variant={choice.primary ? "default" : "outline"}
              disabled={locked}
              data-goal-reply-choice={choice.isDefault ? "default" : "option"}
              className="h-auto min-h-7 max-w-full whitespace-normal rounded-full px-3 py-1 text-left text-xs [overflow-wrap:anywhere]"
              onClick={() => void submit(choice.answer)}
            >
              {choice.label}
              {choice.isDefault && (
                <span className="text-muted-foreground">· {t("chat.goal.replyDefault")}</span>
              )}
            </Button>
          ))}
        </div>
      )}
      {failed && (
        <p role="alert" className="text-xs text-status-err">
          {t("chat.goal.replyFailed")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t(consent ? "chat.goal.replyConsentHint" : "chat.goal.replyHint")}
      </p>
    </div>
  );
});
