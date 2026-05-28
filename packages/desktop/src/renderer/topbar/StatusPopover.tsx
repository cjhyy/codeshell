import React, { useEffect, useState } from "react";
import { formatElapsed, type LiveActivity } from "./liveActivity";

interface Props {
  activity: LiveActivity;
  busy: boolean;
}

/**
 * Codex-style status popover anchored under the TopBar's status dot.
 * Shows the current activity / step count / elapsed when busy, or a
 * minimal "idle" line otherwise. Re-renders once per second via its
 * own interval so the elapsed counter ticks without re-rendering the
 * whole App.
 */
export function StatusPopover({ activity, busy }: Props) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

  if (!busy) {
    return (
      <div className="status-popover">
        <div className="status-popover-line status-popover-muted">空闲</div>
      </div>
    );
  }

  const elapsedMs =
    activity.turnStartedAt > 0
      ? Math.max(0, nowMs - activity.turnStartedAt)
      : 0;
  const elapsed = activity.turnStartedAt > 0 ? formatElapsed(elapsedMs) : "—";
  const activityLabel = activity.lastToolName || "思考中";

  return (
    <div className="status-popover">
      <div className="status-popover-line">
        <span className="status-popover-key">当前</span>
        <span className="status-popover-val">
          {activityLabel}
          {activity.toolInFlight ? "…" : ""}
        </span>
      </div>
      <div className="status-popover-line">
        <span className="status-popover-key">已处理</span>
        <span className="status-popover-val">{activity.toolCount} 步</span>
      </div>
      <div className="status-popover-line">
        <span className="status-popover-key">用时</span>
        <span className="status-popover-val">{elapsed}</span>
      </div>
    </div>
  );
}
