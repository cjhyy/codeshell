import React, { memo, useState } from "react";
import { CircleDot, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GoalProgressMessage } from "../types";
import { useT } from "../i18n/I18nProvider";

/** Options the "再续" button passes up — mirrors core's GoalExtension. */
export interface GoalExtendOpts {
  addTurns?: number;
  addStopBlocks?: number;
  addTokenBudget?: number;
  addTimeBudgetMs?: number;
}

/** Default bumps offered by the "再续" button, per limit dimension. */
const EXTEND_TURNS = 50;
const EXTEND_STOP_BLOCKS = 15;

/**
 * Goal-mode progress marker bar — one per judge verdict.
 *
 *   ◎ 目标未达成 · 第 N 轮 — 还差:{gaps}      (status "not_met")
 *   ✓ 目标已达成 · 共 N 轮                     (status "met")
 *   ⚠ 目标续跑已达上限(N 轮) · 已停下          (status "exhausted")
 *   ⏲ 目标接近续跑上限 · 还剩 N 次   [再续 N 次] (status "approaching_limit")
 *
 * Counting the "目标未达成" bars tells the user how many rounds the goal ran;
 * the trailing "目标已达成 · 共 N 轮" repeats the total. Copy is the judge's
 * voice (mirrors goal-stop-hook's 「目标尚未达成 / 还差」). `gaps` is whatever
 * the judge already produced — no extra LLM call.
 */
function GoalProgressViewImpl({
  message,
  onExtend,
}: {
  message: GoalProgressMessage;
  /** Extend the running goal (TODO 3.1). opts target the nearest ceiling. */
  onExtend?: (opts: GoalExtendOpts) => void;
}) {
  const { t } = useT();
  const { status, round, gaps } = message;
  // One-shot disable after clicking. Each marker is a fresh component (fresh
  // id), and the reducer replaces/prunes this marker once the run advances, so
  // no persistent "already extended" state is needed.
  const [clicked, setClicked] = useState(false);

  // Approaching a stop ceiling while still running — offer a one-click extend so
  // an unattended goal isn't truncated. The button targets whichever limit is
  // closest (`nearest`): the stop-block cap (the common case) or maxTurns.
  if (status === "approaching_limit") {
    const byStopBlocks = message.nearest === "stopBlocks";
    const label = byStopBlocks
      ? t("msg.goal.extendTimes", { count: EXTEND_STOP_BLOCKS })
      : t("msg.goal.extendTurns", { count: EXTEND_TURNS });
    const remaining = byStopBlocks ? message.stopBlocksRemaining : message.turnsRemaining;
    const headline = byStopBlocks
      ? t("msg.goal.approachingStopLimit")
      : t("msg.goal.approachingTurnLimit");
    const remainingText =
      remaining != null
        ? byStopBlocks
          ? t("msg.goal.remainingTimes", { count: remaining })
          : t("msg.goal.remainingTurns", { count: remaining })
        : "";
    // Always bump turns a little too, so a stop-block extend doesn't later hit
    // maxTurns; the streak reset makes the extra harmless.
    const opts: GoalExtendOpts = byStopBlocks
      ? { addStopBlocks: EXTEND_STOP_BLOCKS, addTurns: EXTEND_TURNS }
      : { addTurns: EXTEND_TURNS };
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-status-warn">
        <Clock size={12} className="shrink-0" />
        <span className="shrink-0">
          {headline}
          {remainingText}
        </span>
        {onExtend &&
          (clicked ? (
            <span className="text-muted-foreground">{t("msg.goal.extended", { label })}</span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 py-0 text-[11px]"
              onClick={() => {
                setClicked(true);
                onExtend(opts);
              }}
            >
              {label}
            </Button>
          ))}
      </div>
    );
  }

  if (status === "met") {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-status-ok">
        <CheckCircle2 size={12} />
        <span>{t("msg.goal.metRounds", { count: round })}</span>
      </div>
    );
  }

  if (status === "exhausted") {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-status-warn">
        <AlertTriangle size={12} />
        <span>{t("msg.goal.exhausted", { count: round })}</span>
      </div>
    );
  }

  // not_met — one re-prompt round.
  return (
    <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-muted-foreground">
      <CircleDot size={12} className="shrink-0" />
      <span className="shrink-0">{t("msg.goal.notMetRound", { count: round })}</span>
      {gaps ? (
        <span className="truncate text-muted-foreground/80">{t("msg.goal.gap", { gaps })}</span>
      ) : (
        <span className="text-muted-foreground/80">{t("msg.goal.keepGoing")}</span>
      )}
    </div>
  );
}

// Memoized — see Markdown / ToolCard for the rationale.
export const GoalProgressView = memo(GoalProgressViewImpl);
