import React, { memo, useState } from "react";
import type { AskUserMessage } from "../types";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

interface Props {
  message: AskUserMessage;
  /** Called with the user's chosen / typed answer string. */
  onAnswer: (requestId: string, answer: string) => void;
}

/**
 * AskUserQuestion rendered inline in the chat stream.
 *
 * Three layouts:
 *   - Resolved (m.answer is set): pill with the answer, no inputs
 *   - Multiple-choice (options given): list of selectable rows + "其它…"
 *     entry that reveals a free-text input
 *   - Free-text (no options): just a text input
 *
 * The answer is always wire-encoded as a single string. For
 * multiSelect we join selected labels with ", ".
 */
function AskUserMessageViewImpl({ message, onAnswer }: Props) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherDraft, setOtherDraft] = useState("");
  const [picked, setPicked] = useState<Set<number>>(() => new Set());

  if (message.answer !== undefined) {
    return (
      <div className="my-2 max-w-[720px] rounded-md border bg-muted/30 p-3 text-sm">
        <div className="mb-2 flex flex-col gap-1">
          {message.header && <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{message.header}</span>}
          <span className="font-medium text-foreground">{message.question}</span>
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full bg-status-ok/10 px-2 py-1 text-xs font-medium text-status-ok">
          <Check size={12} /> {message.answer}
        </div>
      </div>
    );
  }

  const hasOptions = !!message.options && message.options.length > 0;
  const submit = (val: string): void => {
    const v = val.trim();
    if (!v) return;
    onAnswer(message.requestId, v);
  };

  const submitMulti = (): void => {
    if (picked.size === 0 && !otherDraft.trim()) return;
    const labels = Array.from(picked).map((i) => message.options![i].label);
    const all = otherDraft.trim() ? [...labels, otherDraft.trim()] : labels;
    submit(all.join(", "));
  };

  return (
    <div className="my-2 max-w-[720px] rounded-md border bg-card p-3 text-sm shadow-sm">
      <div className="mb-3 flex flex-col gap-1">
        {message.header && <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{message.header}</span>}
        <span className="font-medium text-foreground">{message.question}</span>
      </div>

      {hasOptions ? (
        <>
          <ul className="flex flex-col gap-2">
            {message.options!.map((o, i) => {
              const isPicked = picked.has(i);
              return (
                <li
                  key={i}
                  className={cn(
                    "cursor-pointer rounded-md border p-2 transition-colors hover:bg-accent",
                    isPicked && "border-primary bg-primary/10",
                  )}
                  onClick={() => {
                    if (message.multiSelect) {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      });
                    } else {
                      submit(o.label);
                    }
                  }}
                >
                  <div className="flex items-center gap-2">
                    {message.multiSelect && (
                      <span className={cn(
                        "flex h-4 w-4 items-center justify-center rounded-sm border text-primary",
                        isPicked && "border-primary bg-primary/10",
                      )}>
                        {isPicked ? <Check size={11} /> : null}
                      </span>
                    )}
                    <span className="font-medium text-foreground">{o.label}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{o.description}</div>
                </li>
              );
            })}
            {/* Closed-set prompts (optionsOnly) hide the free-text escape
                hatch: their answer is matched by exact label, so a typed
                answer like "允许" would never match and silently fail. */}
            {!message.optionsOnly && (
              <li
                className={cn(
                  "cursor-pointer rounded-md border p-2 transition-colors hover:bg-accent",
                  otherOpen && "border-primary bg-primary/10",
                )}
                onClick={() => setOtherOpen((o) => !o)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{t("msg.ask.other")}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{t("msg.ask.otherDesc")}</div>
              </li>
            )}
          </ul>
          {(otherOpen || message.multiSelect) && (
            <div className="mt-3 flex items-center gap-2">
              {otherOpen && (
                <Input
                  autoFocus
                  placeholder={t("msg.ask.otherPlaceholder")}
                  value={otherDraft}
                  onChange={(e) => setOtherDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !message.multiSelect) {
                      e.preventDefault();
                      submit(otherDraft);
                    }
                  }}
                />
              )}
              {message.multiSelect ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={picked.size === 0 && !otherDraft.trim()}
                  onClick={submitMulti}
                >
                  {t("msg.ask.submit")}
                </Button>
              ) : (
                otherOpen && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!otherDraft.trim()}
                    onClick={() => submit(otherDraft)}
                  >
                    {t("msg.ask.answer")}
                  </Button>
                )
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            placeholder={t("msg.ask.answerPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit(draft);
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={!draft.trim()}
            onClick={() => submit(draft)}
          >
            {t("msg.ask.answer")}
          </Button>
        </div>
      )}
    </div>
  );
}

export const AskUserMessageView = memo(AskUserMessageViewImpl);
