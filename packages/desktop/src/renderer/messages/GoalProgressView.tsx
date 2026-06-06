import React, { memo, useState } from "react";
import { CircleDot, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import type { GoalProgressMessage } from "../types";

/** Default turn bump offered by the "再续" button. */
const EXTEND_TURNS = 50;

/**
 * Goal-mode progress marker bar — one per judge verdict.
 *
 *   ◎ 目标未达成 · 第 N 轮 — 还差:{gaps}      (status "not_met")
 *   ✓ 目标已达成 · 共 N 轮                     (status "met")
 *   ⚠ 目标续跑已达上限(N 轮) · 已停下          (status "exhausted")
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
  /** Extend the running goal by `addTurns` more turns (TODO 3.1). */
  onExtend?: (addTurns: number) => void;
}) {
  const { status, round, gaps } = message;
  const [extended, setExtended] = useState(false);

  // Approaching the turn cap while still running — offer a one-click extend so
  // an unattended goal doesn't get truncated. After clicking we show a brief
  // confirmation instead of the button.
  if (status === "approaching_limit") {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-status-warn">
        <Clock size={12} className="shrink-0" />
        <span className="shrink-0">
          目标接近轮次上限{message.turnsRemaining != null ? ` · 还剩 ${message.turnsRemaining} 轮` : ""}
        </span>
        {onExtend &&
          (extended ? (
            <span className="text-muted-foreground">— 已再续 {EXTEND_TURNS} 轮</span>
          ) : (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-accent"
              onClick={() => {
                setExtended(true);
                onExtend(EXTEND_TURNS);
              }}
            >
              再续 {EXTEND_TURNS} 轮
            </button>
          ))}
      </div>
    );
  }

  if (status === "met") {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-status-ok">
        <CheckCircle2 size={12} />
        <span>目标已达成 · 共 {round} 轮</span>
      </div>
    );
  }

  if (status === "exhausted") {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-status-warn">
        <AlertTriangle size={12} />
        <span>目标续跑已达上限({round} 轮) · 已停下</span>
      </div>
    );
  }

  // not_met — one re-prompt round.
  return (
    <div className="flex items-center gap-1.5 px-4 py-1 text-xs text-muted-foreground">
      <CircleDot size={12} className="shrink-0" />
      <span className="shrink-0">目标未达成 · 第 {round} 轮</span>
      {gaps ? (
        <span className="truncate text-muted-foreground/80">— 还差:{gaps}</span>
      ) : (
        <span className="text-muted-foreground/80">— 继续推进</span>
      )}
    </div>
  );
}

// Memoized — see Markdown / ToolCard for the rationale.
export const GoalProgressView = memo(GoalProgressViewImpl);
