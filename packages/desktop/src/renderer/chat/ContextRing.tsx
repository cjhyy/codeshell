import React from "react";

interface Props {
  /** Current context tokens. */
  used: number;
  /** Optional max for ratio. Falls back to a reasonable default (200k). */
  max?: number;
}

/**
 * Compact circular progress ring shown in the composer row, telling
 * the user how full the current session's context is.
 */
export function ContextRing({ used, max = 200_000 }: Props) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, used / max)) : 0;
  const pct = Math.round(ratio * 100);
  const size = 22;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - ratio);

  const tone =
    ratio >= 0.9 ? "var(--status-err)" :
    ratio >= 0.7 ? "var(--status-warn)" :
    "var(--accent)";

  return (
    <div className="context-ring" title={`上下文 ${used.toLocaleString()} / ${max.toLocaleString()} (${pct}%)`}>
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
  );
}
