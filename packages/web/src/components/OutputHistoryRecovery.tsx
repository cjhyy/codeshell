import React, { useEffect, useRef, useState } from "react";
import type {
  OutputHistoryRecoveryAcceptance,
  OutputHistoryRecoveryPlan,
  OutputHistoryRecoveryReason,
  OutputHistoryRecoveryResult,
} from "@cjhyy/code-shell-core";
import { t as translate, type WebTranslationKey } from "../i18n/translate.js";

export interface OutputHistoryRecoveryProps {
  sessionId: string;
  /** Include the current workspace and connection identity; never display this value. */
  identity: string;
  failed: boolean;
  historicalGap?: boolean;
  disabled?: boolean;
  plan(sessionId: string): Promise<OutputHistoryRecoveryPlan>;
  apply(
    sessionId: string,
    acceptance: OutputHistoryRecoveryAcceptance,
  ): Promise<OutputHistoryRecoveryResult>;
  beforeApply?(): void;
  onApplied(): void;
  t?: (key: WebTranslationKey, params?: Record<string, string | number>) => string;
  timeoutMs?: number;
}

type Review =
  | { status: "idle" | "checking" | "applying" | "applied" }
  | {
      status: "ready";
      identity: string;
      plan: Extract<OutputHistoryRecoveryPlan, { status: "ready" }>;
    }
  | { status: "blocked"; reason: OutputHistoryRecoveryReason };

/** A review is local to one selection; late replies can never approve a different Session. */
export function useOutputHistoryRecovery(props: OutputHistoryRecoveryProps) {
  const [review, setReview] = useState<Review>({ status: "idle" });
  const lifetime = useRef({ identity: props.identity, serial: 0, live: true, working: false });
  if (lifetime.current.identity !== props.identity) {
    lifetime.current.identity = props.identity;
    lifetime.current.serial++;
    lifetime.current.working = false;
  }
  useEffect(() => {
    lifetime.current.live = true;
    setReview({ status: "idle" });
    return () => {
      lifetime.current.live = false;
      lifetime.current.serial++;
    };
  }, [props.identity]);
  const run = async <T,>(work: () => Promise<T>, complete: (result: T) => void) => {
    if (lifetime.current.working) return;
    lifetime.current.working = true;
    const serial = ++lifetime.current.serial;
    const identity = props.identity;
    const current = () =>
      lifetime.current.live &&
      lifetime.current.serial === serial &&
      lifetime.current.identity === identity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Recovery request expired")),
            props.timeoutMs ?? 30_000,
          );
        }),
      ]);
      if (current()) complete(result);
    } catch {
      if (current()) setReview({ status: "blocked", reason: "unavailable" });
    } finally {
      if (timer) clearTimeout(timer);
      if (current()) lifetime.current.working = false;
    }
  };
  const check = () => {
    if (props.disabled || lifetime.current.working) return;
    setReview({ status: "checking" });
    return run(
      () => props.plan(props.sessionId),
      (plan) => {
        if (plan.sessionId !== props.sessionId)
          return setReview({ status: "blocked", reason: "stale" });
        if (plan.status === "blocked") return setReview(plan);
        if (
          !plan.planId ||
          ![
            plan.comparison.turns,
            plan.comparison.userInputs,
            plan.comparison.toolCalls,
            plan.comparison.toolResults,
          ].every((value) => Number.isSafeInteger(value) && value >= 0)
        )
          return setReview({ status: "blocked", reason: "unavailable" });
        setReview({ status: "ready", identity: props.identity, plan });
      },
    );
  };
  const confirm = () => {
    if (
      props.disabled ||
      lifetime.current.working ||
      review.status !== "ready" ||
      review.identity !== props.identity ||
      review.plan.sessionId !== props.sessionId
    )
      return;
    const plan = review.plan;
    setReview({ status: "applying" });
    return run(
      async () => {
        props.beforeApply?.();
        return props.apply(props.sessionId, { planId: plan.planId, acceptHistoricalGap: true });
      },
      (result) => {
        if (result.sessionId !== props.sessionId)
          return setReview({ status: "blocked", reason: "stale" });
        if (result.status !== "applied")
          return setReview({ status: "blocked", reason: result.reason });
        setReview({ status: "applied" });
        props.onApplied();
      },
    );
  };
  const cancel = () => {
    lifetime.current.serial++;
    lifetime.current.working = false;
    setReview({ status: "idle" });
  };
  return { review, check, confirm, cancel };
}

export function OutputHistoryRecovery(props: OutputHistoryRecoveryProps) {
  const { review, check, confirm, cancel } = useOutputHistoryRecovery(props);
  const t = props.t ?? translate;
  if (!props.failed && !props.historicalGap && review.status !== "applied") return null;
  const prefix = "mobile.historyRecovery.";
  const pending = review.status === "checking" || review.status === "applying";
  const gap = props.historicalGap || review.status === "applied";
  return (
    <section
      role="status"
      aria-live="polite"
      style={{
        padding: "12px 16px",
        border: "1px solid currentColor",
        borderRadius: 8,
        margin: "8px 0",
        fontSize: 13,
      }}
    >
      <strong>{t(gap ? `${prefix}gapTitle` : `${prefix}title`)}</strong>
      <p>{t(gap ? `${prefix}gapNotice` : `${prefix}failed`)}</p>
      {review.status === "ready" ? (
        <>
          <p>{t(`${prefix}verified`, { ...review.plan.comparison })}</p>
          <p>{t(`${prefix}gapNotice`)}</p>
          <p>{t(`${prefix}preserve`)}</p>
          <p>{t(`${prefix}noReplay`)}</p>
          <button type="button" disabled={props.disabled} onClick={() => void confirm()}>
            {t(`${prefix}confirm`)}
          </button>{" "}
          <button type="button" onClick={cancel}>
            {t(`${prefix}cancel`)}
          </button>
        </>
      ) : props.failed ? (
        <>
          {review.status === "blocked" ? (
            <p role="alert">{t(`${prefix}reason.${review.reason}`)}</p>
          ) : null}
          <button type="button" disabled={props.disabled || pending} onClick={() => void check()}>
            {t(
              review.status === "checking"
                ? `${prefix}checking`
                : review.status === "applying"
                  ? `${prefix}applying`
                  : `${prefix}check`,
            )}
          </button>
        </>
      ) : null}
    </section>
  );
}
