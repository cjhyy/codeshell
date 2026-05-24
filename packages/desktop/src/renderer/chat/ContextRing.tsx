import React, { useState } from "react";

interface Props {
  used: number;
  max?: number;
}

/**
 * Compact context-usage indicator in the composer row.
 *
 * Layout: a small ring + a percent number next to it. Hover anywhere
 * on the wrapper shows a custom popover with absolute numbers, so the
 * user doesn't have to wait on the browser's slow native title tooltip
 * (which also strips '\n' and disappears under sibling elements).
 *
 * Tone: green <70%, amber 70–90%, red ≥90%.
 */
export function ContextRing({ used, max = 200_000 }: Props) {
  const [hover, setHover] = useState(false);

  const safeMax = max > 0 ? max : 200_000;
  const ratio = Math.max(0, Math.min(1, used / safeMax));
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, safeMax - used);

  const size = 22;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - ratio);

  const tone =
    ratio >= 0.9 ? "var(--status-err)" :
    ratio >= 0.7 ? "var(--status-warn)" :
    "var(--status-ok)";

  return (
    <div
      className="context-ring-wrap"
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
        </svg>
      </div>
      <span className="context-ring-pct" style={{ color: tone }}>{pct}%</span>

      {hover && (
        <div className="context-ring-tooltip">
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
