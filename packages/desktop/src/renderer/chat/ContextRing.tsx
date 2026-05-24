import React, { useState } from "react";

interface Props {
  used: number;
  max?: number;
  /** True while an agent run is in flight — show breathing animation. */
  busy?: boolean;
}

/**
 * Compact context-usage indicator in the composer row.
 *
 * Three visual states:
 *   - Idle, no tokens yet (fresh session): ring grey, label "—".
 *     Without this users mistake "0%" for "history was wiped".
 *   - Idle with usage: ring filled, label "XX%".
 *   - Busy (agent running): label "·" with a gentle pulse so the user
 *     sees that token count is in flight and will land after the turn.
 *
 * Hover shows a popover with 已用 / 剩余 / 上限 and a thin progress bar.
 */
export function ContextRing({ used, max = 200_000, busy }: Props) {
  const [hover, setHover] = useState(false);

  const safeMax = max > 0 ? max : 200_000;
  const ratio = Math.max(0, Math.min(1, used / safeMax));
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, safeMax - used);
  const hasUsage = used > 0;

  const size = 22;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - ratio);

  const tone =
    !hasUsage ? "var(--fg-muted)" :
    ratio >= 0.9 ? "var(--status-err)" :
    ratio >= 0.7 ? "var(--status-warn)" :
    "var(--status-ok)";

  const pctLabel = !hasUsage ? (busy ? "·" : "—") : `${pct}%`;

  return (
    <div
      className={`context-ring-wrap${busy ? " busy" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="context-ring">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={stroke}
          />
          {hasUsage && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={tone}
              strokeWidth={stroke}
              strokeDasharray={c}
              strokeDashoffset={offset}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
      </div>
      <span className="context-ring-pct" style={{ color: tone }}>{pctLabel}</span>

      {hover && (
        <div className="context-ring-tooltip">
          {!hasUsage ? (
            <div className="context-ring-tt-empty">
              {busy ? "已发送，等待引擎统计…" : "新会话，尚未消耗上下文"}
              <div className="context-ring-tt-sub">上限 {formatTok(safeMax)}</div>
            </div>
          ) : (
            <>
              <div className="context-ring-tt-row">
                <span className="context-ring-tt-label">已用</span>
                <span className="context-ring-tt-val">{formatTok(used)}</span>
              </div>
              <div className="context-ring-tt-row">
                <span className="context-ring-tt-label">剩余</span>
                <span className="context-ring-tt-val">{formatTok(remaining)}</span>
              </div>
              <div className="context-ring-tt-row">
                <span className="context-ring-tt-label">上限</span>
                <span className="context-ring-tt-val">{formatTok(safeMax)}</span>
              </div>
              <div className="context-ring-tt-bar">
                <div className="context-ring-tt-bar-fill" style={{ width: `${pct}%`, background: tone }} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
