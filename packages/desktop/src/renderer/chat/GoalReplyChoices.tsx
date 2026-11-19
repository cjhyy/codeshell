import React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type { GoalUserQuestion } from "../types";

/** Per question id: a chosen option label, or the free-form "other" answer. */
export type GoalReplyChoices = Record<string, { label?: string; other?: string }>;

const RECOMMENDED = /\s*[(（](?:recommended|推荐)[)）]\s*$/i;

export function splitRecommended(label: string): { text: string; recommended: boolean } {
  const text = label.replace(RECOMMENDED, "").trim();
  return { text: text || label, recommended: text !== label.trim() };
}

function answerOf(choice: GoalReplyChoices[string] | undefined): string {
  if (!choice) return "";
  if (choice.other !== undefined) return choice.other.trim();
  return choice.label ? splitRecommended(choice.label).text : "";
}

export function goalChoicesComplete(
  questions: readonly GoalUserQuestion[],
  choices: GoalReplyChoices,
): boolean {
  return questions.every((q) => answerOf(choices[q.id]) !== "");
}

/** The reply sent to the model: one line per question, "header：answer". */
export function goalChoicesAnswer(
  questions: readonly GoalUserQuestion[],
  choices: GoalReplyChoices,
): string {
  if (questions.length === 1 && !questions[0]!.header) return answerOf(choices[questions[0]!.id]);
  return questions.map((q) => `${q.header || q.question}：${answerOf(choices[q.id])}`).join("\n");
}

export function GoalReplyChoiceList({
  questions,
  choices,
  disabled,
  onChange,
  onSubmitShortcut,
}: {
  questions: readonly GoalUserQuestion[];
  choices: GoalReplyChoices;
  disabled: boolean;
  onChange: (choices: GoalReplyChoices) => void;
  onSubmitShortcut: () => void;
}) {
  const { t } = useT();
  const set = (id: string, choice: GoalReplyChoices[string]) =>
    onChange({ ...choices, [id]: choice });
  return (
    <div className="max-h-[45vh] space-y-3 overflow-y-auto pr-1">
      {questions.map((q) => {
        const choice = choices[q.id];
        const otherActive = choice?.other !== undefined;
        return (
          <fieldset key={q.id} className="min-w-0 space-y-1.5" disabled={disabled}>
            <legend className="flex min-w-0 items-baseline gap-2 text-sm text-foreground">
              {q.header && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                  {q.header}
                </span>
              )}
              <span className="min-w-0 break-words">{q.question}</span>
            </legend>
            <div className="grid gap-1.5" role="radiogroup" aria-label={q.question}>
              {q.options.map((option, index) => {
                const { text, recommended } = splitRecommended(option.label);
                const selected = !otherActive && choice?.label === option.label;
                return (
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={cn(
                      "flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors",
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background/60 hover:border-primary/50",
                    )}
                    onClick={() => set(q.id, { label: option.label })}
                  >
                    <span className="mt-px shrink-0 text-xs tabular-nums text-muted-foreground">
                      {index + 1}.
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{text}</span>
                      {recommended && (
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
              <button
                type="button"
                role="radio"
                aria-checked={otherActive}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors",
                  otherActive
                    ? "border-primary bg-primary/10"
                    : "border-dashed border-border text-muted-foreground hover:border-primary/50",
                )}
                onClick={() => set(q.id, { other: choice?.other ?? "" })}
              >
                {t("chat.goal.replyOther")}
              </button>
              {otherActive && (
                <Input
                  autoFocus
                  value={choice?.other ?? ""}
                  aria-label={q.question}
                  placeholder={t("chat.goal.replyOtherPlaceholder")}
                  className="h-8 text-sm"
                  onChange={(event) => set(q.id, { other: event.target.value })}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey) &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      onSubmitShortcut();
                    }
                  }}
                />
              )}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
