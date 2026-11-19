import React from "react";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type { GoalUserQuestion } from "../types";
import { goalQuestionRecommended } from "../../shared/goal-questions";

/** The option label chosen for each question id. Free-form answers use the main composer. */
export type GoalReplyChoices = Record<string, string>;

export function goalChoicesComplete(
  questions: readonly GoalUserQuestion[],
  choices: GoalReplyChoices,
): boolean {
  return questions.every((q) => !!choices[q.id]);
}

/** The reply sent to the model: one line per question, "header：answer". */
export function goalChoicesAnswer(
  questions: readonly GoalUserQuestion[],
  choices: GoalReplyChoices,
): string {
  if (questions.length === 1 && !questions[0]!.header) return choices[questions[0]!.id] ?? "";
  return questions.map((q) => `${q.header || q.question}：${choices[q.id] ?? ""}`).join("\n");
}

/** Option cards for each question: header, label, recommendation and description. */
export function GoalReplyChoiceList({
  questions,
  choices,
  disabled,
  showQuestion,
  onChoose,
}: {
  questions: readonly GoalUserQuestion[];
  choices: GoalReplyChoices;
  disabled: boolean;
  /** False when the banner already shows the single question as its text. */
  showQuestion: boolean;
  onChoose: (choices: GoalReplyChoices) => void;
}) {
  const { t } = useT();
  return (
    <div className="max-h-[45vh] min-w-0 space-y-3 overflow-y-auto pr-1">
      {questions.map((q) => {
        const recommended = goalQuestionRecommended(q);
        return (
          <fieldset
            key={q.id}
            className="min-w-0 space-y-1.5"
            disabled={disabled}
            data-goal-reply-question={q.id}
          >
            {(showQuestion || q.header) && (
              <legend className="flex min-w-0 items-baseline gap-2 text-sm text-foreground">
                {q.header && (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                    {q.header}
                  </span>
                )}
                {showQuestion && <span className="min-w-0 break-words">{q.question}</span>}
              </legend>
            )}
            <div className="grid gap-1.5" role="radiogroup" aria-label={q.question}>
              {q.options.map((option, index) => {
                const selected = choices[q.id] === option.label;
                return (
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    data-goal-reply-choice={option.label === recommended ? "default" : "option"}
                    className={cn(
                      "flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-60",
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background/60 hover:border-primary/50",
                    )}
                    onClick={() => onChoose({ ...choices, [q.id]: option.label })}
                  >
                    <span className="mt-px shrink-0 text-xs tabular-nums text-muted-foreground">
                      {index + 1}.
                    </span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <span className="font-medium">{option.label}</span>
                      {option.label === recommended && (
                        <span className="ml-1.5 text-xs text-primary">
                          {t("chat.goal.replyRecommended")}
                        </span>
                      )}
                      {option.description && (
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
