import React, { memo, useEffect, useId, useRef, useState } from "react";
import type { AskUserMessage } from "../types";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { resolveAnswerTone, toneEchoStyle } from "./askUserTone";

interface Props {
  message: AskUserMessage;
  /** Called with the user's chosen / typed answer string. */
  onAnswer: (requestId: string, answer: string) => void | Promise<void>;
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
  const [deferred, setDeferred] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const submittingRef = useRef(false);
  const composingRef = useRef(false);
  const questionId = useId();
  const otherId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (submitting || !returnFocus.current) return;
    const opener = returnFocus.current;
    returnFocus.current = null;
    if (document.activeElement === document.body && opener.isConnected) opener.focus();
  }, [submitting]);

  if (message.answer !== undefined) {
    // Color the resolved echo by the chosen option's engine-supplied tone —
    // an affirmative choice is green ✓, a deny is red ✕, anything we can't map
    // (free text, multiSelect, LLM prompts without a tone) stays neutral. This
    // is what keeps a "拒绝" answer from rendering with the approve styling.
    const echo = toneEchoStyle(resolveAnswerTone(message.answer, message.options));
    return (
      // Sit in the same padded column as every other message view. A fixed
      // pixel width left this card narrower than the surrounding cards and
      // flush against the viewport edge at wide window sizes.
      <div className="min-w-0 max-w-full px-4 py-1">
        <div className="my-2 min-w-0 whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm [overflow-wrap:anywhere]">
          <div className="mb-2 flex flex-col gap-1">
            {message.header && (
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {message.header}
              </span>
            )}
            <span className="font-medium text-foreground">{message.question}</span>
          </div>
          <div
            className={cn(
              "inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-xl px-2 py-1 text-xs font-medium",
              echo.className,
            )}
          >
            {echo.icon === "check" && <Check size={12} className="mt-0.5 shrink-0" aria-hidden />}
            {echo.icon === "cross" && <X size={12} className="mt-0.5 shrink-0" aria-hidden />}
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {message.answer}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (typeof message.question !== "string" || !message.question.trim()) {
    return (
      <div className="min-w-0 max-w-full px-4 py-1">
        <div className="my-2 min-w-0 rounded-md border bg-card p-3 text-sm shadow-sm">
          <p role="alert" className="text-status-err">
            {t("msg.ask.questionUnavailable")}
          </p>
        </div>
      </div>
    );
  }

  const hasOptions = !!message.options && message.options.length > 0;
  const submit = (val: string): void => {
    const v = val.trim();
    if (!v || submittingRef.current) return;
    submittingRef.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSubmitting(true);
    setSubmitFailed(false);
    void (async () => {
      try {
        await onAnswer(message.requestId, v);
      } catch {
        // Keep every draft/selection intact so a failed send is retryable.
        setSubmitFailed(true);
      } finally {
        submittingRef.current = false;
        returnFocus.current = opener;
        setSubmitting(false);
      }
    })();
  };

  const submitMulti = (): void => {
    if (picked.size === 0 && !otherDraft.trim()) return;
    const labels = Array.from(picked).map((i) => message.options![i].label);
    const all = otherDraft.trim() ? [...labels, otherDraft.trim()] : labels;
    submit(all.join(", "));
  };

  return (
    <div className="min-w-0 max-w-full px-4 py-1">
      <div
        role="group"
        aria-labelledby={questionId}
        className="my-2 min-w-0 rounded-md border bg-card p-3 text-sm shadow-sm"
      >
        <div className="mb-3 flex flex-col gap-1">
          {message.header && (
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {message.header}
            </span>
          )}
          <span
            id={questionId}
            className="break-words font-medium text-foreground [overflow-wrap:anywhere]"
          >
            {message.question}
          </span>
        </div>

        {message.asynchronous && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("msg.ask.asyncHint")}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={!deferred}
              onClick={() => setDeferred((value) => !value)}
            >
              {t(deferred ? "msg.ask.resume" : "msg.ask.later")}
            </Button>
          </div>
        )}

        {!deferred &&
          (hasOptions ? (
            <>
              <ul className="flex flex-col gap-2">
                {message.options!.map((option, index) => {
                  const isPicked = picked.has(index);
                  const titleId = `${questionId}-option-${index}`;
                  const descriptionId = `${titleId}-description`;
                  const checkboxId = `${titleId}-checkbox`;
                  const content = (
                    <>
                      <span
                        id={titleId}
                        className={cn(
                          "block min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]",
                          option.tone === "danger" && "text-status-err",
                          option.tone === "ok" && "text-status-ok",
                        )}
                      >
                        {option.label}
                      </span>
                      <span
                        id={descriptionId}
                        className="mt-1 block break-words text-xs text-muted-foreground [overflow-wrap:anywhere]"
                      >
                        {option.description}
                      </span>
                    </>
                  );
                  return (
                    <li key={index} className="min-w-0">
                      {message.multiSelect ? (
                        <label
                          htmlFor={checkboxId}
                          className={cn(
                            "flex cursor-pointer items-start gap-2 rounded-md border p-2 transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring",
                            isPicked && "border-primary bg-primary/10",
                            submitting && "cursor-default opacity-50",
                          )}
                        >
                          <Checkbox
                            id={checkboxId}
                            checked={isPicked}
                            disabled={submitting}
                            className="mt-0.5"
                            aria-labelledby={titleId}
                            aria-describedby={descriptionId}
                            onCheckedChange={(checked) => {
                              if (submittingRef.current) return;
                              setPicked((previous) => {
                                const next = new Set(previous);
                                if (checked === true) next.add(index);
                                else next.delete(index);
                                return next;
                              });
                            }}
                          />
                          <span className="min-w-0 flex-1">{content}</span>
                        </label>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={submitting}
                          aria-labelledby={titleId}
                          aria-describedby={descriptionId}
                          className="block h-auto w-full whitespace-normal rounded-md border p-2 text-left font-normal transition-colors hover:bg-accent"
                          onClick={() => submit(option.label)}
                        >
                          {content}
                        </Button>
                      )}
                    </li>
                  );
                })}
                {!message.optionsOnly && (
                  <li className="min-w-0">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={submitting}
                      aria-expanded={otherOpen}
                      aria-controls={otherId}
                      className={cn(
                        "block h-auto w-full whitespace-normal rounded-md border p-2 text-left font-normal transition-colors hover:bg-accent",
                        otherOpen && "border-primary bg-primary/10",
                      )}
                      onClick={() => setOtherOpen((open) => !open)}
                    >
                      <span className="block font-medium text-foreground">
                        {t("msg.ask.other")}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {t("msg.ask.otherDesc")}
                      </span>
                    </Button>
                  </li>
                )}
              </ul>
              <div id={otherId} hidden={!otherOpen && !message.multiSelect}>
                {(otherOpen || message.multiSelect) && (
                  <div className="mt-3 flex items-center gap-2">
                    {otherOpen && (
                      <Input
                        autoFocus={!message.asynchronous}
                        disabled={submitting}
                        aria-label={t("msg.ask.otherPlaceholder")}
                        aria-describedby={questionId}
                        placeholder={t("msg.ask.otherPlaceholder")}
                        onCompositionStart={() => {
                          composingRef.current = true;
                        }}
                        onCompositionEnd={() => {
                          composingRef.current = false;
                        }}
                        onBlur={() => {
                          composingRef.current = false;
                        }}
                        value={otherDraft}
                        onChange={(e) => setOtherDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (
                            composingRef.current ||
                            e.nativeEvent.isComposing ||
                            e.nativeEvent.keyCode === 229
                          )
                            return;
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
                        disabled={submitting || (picked.size === 0 && !otherDraft.trim())}
                        onClick={submitMulti}
                      >
                        {t("msg.ask.submit")}
                      </Button>
                    ) : (
                      otherOpen && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={submitting || !otherDraft.trim()}
                          onClick={() => submit(otherDraft)}
                        >
                          {t("msg.ask.answer")}
                        </Button>
                      )
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                autoFocus={!message.asynchronous}
                disabled={submitting}
                aria-labelledby={questionId}
                placeholder={t("msg.ask.answerPlaceholder")}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onBlur={() => {
                  composingRef.current = false;
                }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    composingRef.current ||
                    e.nativeEvent.isComposing ||
                    e.nativeEvent.keyCode === 229
                  )
                    return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit(draft);
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                disabled={submitting || !draft.trim()}
                onClick={() => submit(draft)}
              >
                {t("msg.ask.answer")}
              </Button>
            </div>
          ))}
        {submitting && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {t("msg.ask.sending")}
          </p>
        )}
        {submitFailed && (
          <p role="alert" className="mt-2 text-xs text-status-err">
            {t("msg.ask.submitFailed")}
          </p>
        )}
      </div>
    </div>
  );
}

export const AskUserMessageView = memo(AskUserMessageViewImpl);
