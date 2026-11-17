import React, { createContext, useContext, useEffect, useRef, useState } from "react";
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
  /** Read and verify normal history; never accepts a historical gap. */
  reload?(): void | Promise<void>;
  reloading?: boolean;
  t?: (key: WebTranslationKey, params?: Record<string, string | number>) => string;
  timeoutMs?: number;
  /** A host stylesheet owns the card and its buttons; the inline fallback is dropped. */
  className?: string;
}

/**
 * A host shell provides this so a session whose recovery cannot pass is not a
 * dead end: the user can continue in a fresh conversation instead.
 */
export const OutputHistoryRecoveryExit = createContext<(() => void) | undefined>(undefined);

type Review =
  | { status: "idle" | "checking" | "applying" | "applied" | "reloading" }
  | {
      status: "ready";
      identity: string;
      plan: Extract<OutputHistoryRecoveryPlan, { status: "ready" }>;
    }
  | { status: "blocked"; reason: OutputHistoryRecoveryReason; reloadFailed?: boolean };

/** A review is local to one selection; late replies can never approve a different Session. */
export function useOutputHistoryRecovery(props: OutputHistoryRecoveryProps) {
  const [review, setReview] = useState<Review>({ status: "idle" });
  const reloadIdentity = useRef<string | undefined>(undefined);
  const latestProps = useRef(props);
  latestProps.current = props;
  const lifetime = useRef({ identity: props.identity, serial: 0, live: true, working: false });
  if (lifetime.current.identity !== props.identity) {
    reloadIdentity.current = undefined;
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
  const run = async <T,>(
    work: () => Promise<T>,
    complete: (result: T) => void,
    failed = () => setReview({ status: "blocked", reason: "unavailable" }),
  ) => {
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
      if (current()) failed();
    } finally {
      if (timer) clearTimeout(timer);
      if (current()) lifetime.current.working = false;
    }
  };
  const check = () => {
    if (props.disabled || props.reloading || lifetime.current.working) return;
    reloadIdentity.current = undefined;
    setReview({ status: "checking" });
    return run(
      () => props.plan(props.sessionId),
      (plan) => {
        if (plan.sessionId !== props.sessionId)
          return setReview({ status: "blocked", reason: "stale" });
        if (plan.status === "blocked") {
          if (plan.reason === "not_needed") reloadIdentity.current = props.identity;
          return setReview(plan);
        }
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
      props.reloading ||
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
        if (result.status !== "applied") {
          if (result.reason === "not_needed") reloadIdentity.current = props.identity;
          return setReview({ status: "blocked", reason: result.reason });
        }
        setReview({ status: "applied" });
        props.onApplied();
      },
    );
  };
  const cancel = () => {
    reloadIdentity.current = undefined;
    lifetime.current.serial++;
    lifetime.current.working = false;
    setReview({ status: "idle" });
  };
  const reload = () => {
    const current = latestProps.current;
    if (
      !current.reload ||
      !current.failed ||
      current.disabled ||
      current.reloading ||
      current.sessionId !== props.sessionId ||
      !lifetime.current.live ||
      lifetime.current.working ||
      lifetime.current.identity !== props.identity ||
      reloadIdentity.current !== props.identity ||
      review.status !== "blocked" ||
      review.reason !== "not_needed"
    )
      return;
    setReview({ status: "reloading" });
    return run(
      async () => current.reload!(),
      // Only the host's fresh history commit can clear failed/read-only state.
      () => setReview({ status: "blocked", reason: "not_needed" }),
      () => setReview({ status: "blocked", reason: "not_needed", reloadFailed: true }),
    );
  };
  return { review, check, confirm, cancel, reload };
}

export function OutputHistoryRecovery(props: OutputHistoryRecoveryProps) {
  const { review, check, confirm, cancel, reload } = useOutputHistoryRecovery(props);
  const startNew = useContext(OutputHistoryRecoveryExit);
  const t = props.t ?? translate;
  if (!props.failed && !props.historicalGap && review.status !== "applied") return null;
  const prefix = "mobile.historyRecovery.";
  const pending = review.status === "checking" || review.status === "applying";
  const reloading = props.reloading || review.status === "reloading";
  const needsReload = props.failed && review.status === "blocked" && review.reason === "not_needed";
  const gap = props.historicalGap || review.status === "applied";
  return (
    <section
      role="status"
      aria-live="polite"
      className={props.className}
      style={
        props.className
          ? undefined
          : {
              padding: "12px 16px",
              border: "1px solid currentColor",
              borderRadius: 8,
              margin: "8px 0",
              fontSize: 13,
            }
      }
    >
      <strong>
        {t(
          reloading
            ? `${prefix}reloading`
            : needsReload
              ? `${prefix}reloadTitle`
              : gap
                ? `${prefix}gapTitle`
                : `${prefix}title`,
        )}
      </strong>
      <p>
        {t(
          reloading
            ? `${prefix}reloadPending`
            : needsReload
              ? review.reloadFailed
                ? `${prefix}reloadFailed`
                : `${prefix}reloadDescription`
              : gap
                ? `${prefix}gapNotice`
                : `${prefix}failed`,
        )}
      </p>
      {reloading || needsReload ? (
        <>
          {props.reload && (
            <button
              type="button"
              disabled={props.disabled || reloading}
              onClick={() => void reload()}
            >
              {t(`${prefix}reload`)}
            </button>
          )}
          {startNew && (
            <>
              {" "}
              <button type="button" disabled={pending} onClick={startNew}>
                {t(`${prefix}startNew`)}
              </button>
            </>
          )}
        </>
      ) : review.status === "ready" ? (
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
          {startNew ? (
            <>
              {" "}
              <button type="button" disabled={pending} onClick={startNew}>
                {t(`${prefix}startNew`)}
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
