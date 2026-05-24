import React from "react";

interface Props {
  /** Current context tokens. */
  used: number;
  /** Model's max context. Falls back to 200k if not known. */
  max?: number;
}

/**
 * Compact circular progress ring shown in the composer row.
 *
 * Title (hover) shows: 已用 X / 共 Y · 剩 Z (P%) — so the user can
 * read the actual numbers without expanding into a tooltip popover.
 *
 * Color: green < 70%, amber 70–90%, red >= 90%. Same thresholds
 * core uses for context-management strategy choice, so the visual
 * matches the engine's behaviour.
 */
export function ContextRing({ used, max = 200_000 }: Props) {
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

  const title =
    `已用 ${formatTok(used)} / 共 ${formatTok(safeMax)}\n` +
    `剩 ${formatTok(remaining)} · ${pct}%`;

  return (
    <div className="context-ring" title={title} aria-label={title}>
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

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
