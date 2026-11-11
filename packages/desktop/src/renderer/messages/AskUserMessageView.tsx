import React, { memo, useEffect, useId, useRef, useState } from "react";
import type { AskUserAnswerHandler, AskUserMessage } from "../types";
import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { resolveAnswerTone } from "./askUserTone";
import { recommendedAnswer } from "./askUserDefault";

import { formatRemaining, useNow } from "./countdown";

export { formatRemaining };

interface Props {
  message: AskUserMessage;
  /** Flat question region within the composer, with no separate card chrome. */
  embedded?: boolean;
  /** Called with the chosen / typed answer, or the skipped label plus `skip`. */
  onAnswer: AskUserAnswerHandler;
  /** Drop the question's auto-continue deadline. Absent where unsupported. */
  onKeepWaiting?: (message: AskUserMessage) => Promise<void>;
}

/**
 * AskUserQuestion rendered inline in the chat stream.
 *
 * Three layouts:
 *   - Resolved (m.answer is set): question context and a user answer bubble
 *   - Multiple-choice: selectable rows and an always-visible optional text answer
 *   - Free-text: text answer, sharing the same explicit send action
 *
 * The answer is always wire-encoded as a single string. For
 * multiSelect we join selected labels with ", ".
 */
function AskUserMessageViewImpl({ message, onAnswer, onKeepWaiting, embedded = false }: Props) {
  const { t } = useT();
  // The host retires an expired card with its own resolution; lock the card at
  // the deadline so a late click can't look like it still counts meanwhile.
  const deadline = message.answer === undefined ? message.expiresAt : undefined;
  const now = useNow(deadline);
  const expired = deadline !== undefined && now >= deadline;
  // A model question's deadline can be dropped ("一直等"); it owns the countdown.
  const countdownActive =
    deadline !== undefined && !expired && message.keepWaitable === true && !!onKeepWaiting;
  const timeoutDefault = recommendedAnswer(message);
  const [keepWaitingState, setKeepWaitingState] = useState<"idle" | "pending" | "failed">("idle");
  const keepWaitingRef = useRef(false);
  /** Codex-style: any engagement with the card stops the auto-continue clock. */
  const keepWaiting = (): void => {
    if (!countdownActive || keepWaitingRef.current || !onKeepWaiting) return;
    keepWaitingRef.current = true;
    setKeepWaitingState("pending");
    void onKeepWaiting(message).then(
      () => setKeepWaitingState("idle"),
      () => {
        keepWaitingRef.current = false;
        setKeepWaitingState("failed");
      },
    );
  };
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [deferred, setDeferred] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const submittingRef = useRef(false);
  const composingRef = useRef(false);
  const questionId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  const locked = submitting || expired;
  useEffect(() => {
    if (submitting || !returnFocus.current) return;
    const opener = returnFocus.current;
    returnFocus.current = null;
    if (document.activeElement === document.body && opener.isConnected) opener.focus();
  }, [submitting]);

  if (message.answer !== undefined) {
    // An answered question becomes a user reply. Keep permission semantics on
    // the status icon, without treating an ordinary preference as an approval.
    const tone = resolveAnswerTone(message.answer, message.options);
    return (
      <div className="min-w-0 max-w-full px-4 py-1.5">
        <div className="mb-2 flex min-w-0 flex-col gap-1 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
          {message.header && <span className="text-xs font-medium">{message.header}</span>}
          <span className="text-sm leading-6">{message.question}</span>
        </div>
        <div className="flex min-w-0 justify-end">
          {/* Match UserMessageView's bubble, keeping answers as literal text. */}
          <div className="inline-flex min-w-0 max-w-[80%] items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
            {tone === "ok" && (
              <Check size={12} className="mt-1 shrink-0 text-status-ok" aria-hidden />
            )}
            {tone === "danger" && (
              <X size={12} className="mt-1 shrink-0 text-status-err" aria-hidden />
            )}
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
        <div className="my-2 min-w-0 rounded-2xl border border-border/70 bg-card p-4 text-sm">
          <p role="alert" className="text-status-err">
            {t("msg.ask.questionUnavailable")}
          </p>
        </div>
      </div>
    );
  }

  const hasOptions = !!message.options && message.options.length > 0;
  const submit = (val: string, skip = false): void => {
    const v = val.trim();
    if ((!v && !skip) || submittingRef.current || expired) return;
    submittingRef.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSubmitting(true);
    setSubmitFailed(false);
    void (async () => {
      try {
        await (skip
          ? onAnswer(message.requestId, t("msg.ask.skipped"), true)
          : onAnswer(message.requestId, v));
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

  const labels = Array.from(picked).map((index) => message.options![index].label);
  const answer = message.multiSelect
    ? [...labels, ...(draft.trim() ? [draft.trim()] : [])].join(", ")
    : draft.trim() || labels[0] || "";
  const allowFreeText = !hasOptions || !message.optionsOnly;

  return (
    <div className={cn("min-w-0 max-w-full", !embedded && "px-4 py-1")}>
      <div
        role="group"
        aria-labelledby={questionId}
        data-request-id={message.requestId}
        className={cn(
          "min-w-0 text-sm",
          embedded ? "px-1 py-2" : "my-2 rounded-2xl border border-border/70 bg-card p-4 shadow-sm",
        )}
      >
        <div className="mb-3 flex flex-col gap-2">
          {message.header && (
            <span className="text-xs font-medium text-muted-foreground">{message.header}</span>
          )}
          <span
            id={questionId}
            className="break-words font-medium leading-6 text-foreground [overflow-wrap:anywhere]"
          >
            {message.question}
          </span>
          {deadline !== undefined && !countdownActive && (
            <span className={cn("text-xs", expired ? "text-status-warn" : "text-muted-foreground")}>
              {expired
                ? t("msg.ask.expired")
                : t("msg.ask.expiresIn", { time: formatRemaining(deadline - now) })}
            </span>
          )}
        </div>

        {!deferred && (
          <>
            {hasOptions && (
              <ul className="flex flex-col gap-1">
                {message.options!.map((option, index) => {
                  const isPicked = picked.has(index);
                  const titleId = `${questionId}-option-${index}`;
                  const descriptionId = `${titleId}-description`;
                  const content = (
                    <span className="min-w-0 flex-1">
                      <span
                        id={titleId}
                        className={cn(
                          "block min-w-0 break-words font-medium leading-5 text-foreground [overflow-wrap:anywhere]",
                          option.tone === "danger" && "text-status-err",
                          option.tone === "ok" && "text-status-ok",
                        )}
                      >
                        {option.label}
                        {option.recommended && (
                          <Badge
                            variant="secondary"
                            className="ml-2 border-0 bg-muted/70 px-1.5 py-0 align-middle text-[10px] font-normal text-muted-foreground"
                          >
                            {t("msg.ask.recommended")}
                          </Badge>
                        )}
                      </span>
                      <span
                        id={descriptionId}
                        className="mt-0.5 block break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]"
                      >
                        {option.description}
                      </span>
                    </span>
                  );
                  const choiceClass = cn(
                    "flex w-full items-start gap-3 rounded-lg border border-transparent px-3 py-2 text-left hover:bg-muted/60",
                    isPicked && "border-primary/25 bg-primary/5",
                    locked && "cursor-default opacity-50",
                  );
                  return (
                    <li key={index} className="min-w-0">
                      {message.multiSelect ? (
                        <label
                          htmlFor={`${titleId}-checkbox`}
                          className={cn(
                            choiceClass,
                            "cursor-pointer focus-within:ring-2 focus-within:ring-ring",
                          )}
                        >
                          <Checkbox
                            id={`${titleId}-checkbox`}
                            checked={isPicked}
                            disabled={locked}
                            className="mt-0.5"
                            aria-labelledby={titleId}
                            aria-describedby={descriptionId}
                            onCheckedChange={(checked) => {
                              if (submittingRef.current || expired) return;
                              keepWaiting();
                              setPicked((previous) => {
                                const next = new Set(previous);
                                if (checked === true) next.add(index);
                                else next.delete(index);
                                return next;
                              });
                            }}
                          />
                          {content}
                        </label>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={locked}
                          aria-labelledby={titleId}
                          aria-describedby={descriptionId}
                          aria-pressed={isPicked}
                          className={cn(
                            choiceClass,
                            "h-auto justify-start whitespace-normal font-normal",
                          )}
                          onClick={() => {
                            if (submittingRef.current || expired) return;
                            keepWaiting();
                            setPicked(new Set([index]));
                            setDraft("");
                          }}
                        >
                          {content}
                          <span
                            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-muted-foreground"
                            aria-hidden
                          >
                            {isPicked && <span className="size-2 rounded-full bg-primary" />}
                          </span>
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {allowFreeText && (
              <Input
                className="mt-3 min-w-0 w-full rounded-lg"
                disabled={locked}
                aria-label={
                  hasOptions ? t("msg.ask.otherPlaceholder") : t("msg.ask.answerPlaceholder")
                }
                aria-describedby={questionId}
                placeholder={
                  hasOptions ? t("msg.ask.otherPlaceholder") : t("msg.ask.answerPlaceholder")
                }
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
                onChange={(e) => {
                  keepWaiting();
                  setDraft(e.target.value);
                  if (!message.multiSelect) setPicked(new Set());
                }}
                onKeyDown={(e) => {
                  if (
                    composingRef.current ||
                    e.nativeEvent.isComposing ||
                    e.nativeEvent.keyCode === 229
                  )
                    return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit(answer);
                  }
                }}
              />
            )}
          </>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/50 pt-2.5">
          {countdownActive ? (
            <span
              role="timer"
              aria-live="off"
              className={cn(
                "min-w-0 grow basis-48 text-xs leading-5 tabular-nums text-muted-foreground [overflow-wrap:anywhere]",
                deadline! - now <= 60_000 && "text-status-warn",
              )}
            >
              {t(
                !message.skippable
                  ? "msg.ask.autoContinueIn"
                  : timeoutDefault !== undefined
                    ? "msg.ask.autoChooseIn"
                    : "msg.ask.autoSkipIn",
                {
                  time: formatRemaining(deadline! - now),
                  label: timeoutDefault ?? "",
                },
              )}
            </span>
          ) : message.asynchronous ? (
            <span className="min-w-0 grow basis-48 text-xs leading-5 text-muted-foreground">
              {t("msg.ask.asyncHint")}
            </span>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {countdownActive && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={keepWaitingState === "pending" || locked}
                onClick={keepWaiting}
              >
                {t("msg.ask.keepWaiting")}
              </Button>
            )}
            {message.asynchronous && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={!deferred}
                onClick={() => setDeferred((value) => !value)}
              >
                {t(deferred ? "msg.ask.resume" : "msg.ask.later")}
              </Button>
            )}
            {message.skippable && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={locked}
                onClick={() => submit("", true)}
              >
                {t("msg.ask.skip")}
              </Button>
            )}
            {!deferred && (
              <Button
                type="button"
                size="sm"
                className="h-8 shrink-0 rounded-lg px-3"
                aria-label={t("msg.ask.sendAnswer")}
                disabled={locked || !answer}
                onClick={() => submit(answer)}
              >
                {t("chat.composer.send")}
              </Button>
            )}
          </div>
        </div>
        {keepWaitingState === "failed" && (
          <p role="alert" className="mt-2 text-xs text-status-err">
            {t("msg.ask.keepWaitingFailed")}
          </p>
        )}

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

export const AskUserMessageView = memo(function AskUserMessageView(props: Props) {
  // A new request owns fresh draft/selection state even if a caller reuses its slot.
  return <AskUserMessageViewImpl key={props.message.requestId} {...props} />;
});
