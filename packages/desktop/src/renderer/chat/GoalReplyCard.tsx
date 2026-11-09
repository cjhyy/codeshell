import React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown, type MarkdownRootStatus } from "../Markdown";
import { useT } from "../i18n/I18nProvider";

interface Props {
  question: string;
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
  const submit = async (): Promise<void> => {
    const answer = draft.trim();
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
      <div className="max-h-40 min-w-0 overflow-y-auto break-words [overflow-wrap:anywhere]">
        <Markdown
          text={question}
          sessionId={sessionId}
          cwd={cwd}
          sessionMainRootId={rootId}
          rootStatus={rootStatus}
        />
      </div>
      {onReply && (
        <form
          className="space-y-2"
          aria-labelledby={questionId}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
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
          {failed && (
            <p role="alert" className="text-xs text-status-err">
              {t("chat.goal.replyFailed")}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("chat.goal.replyHint")}</span>
            <Button type="submit" size="sm" disabled={locked || !draft.trim()}>
              {t("chat.goal.replyContinue")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
});
