import React, { memo } from "react";
import { CircleDot, CheckCircle2, AlertTriangle } from "lucide-react";
import type { GoalProgressMessage } from "../types";

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
function GoalProgressViewImpl({ message }: { message: GoalProgressMessage }) {
  const { status, round, gaps } = message;

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
