import React, { useState } from "react";
import { useT } from "../i18n/I18nProvider";

interface Props {
  used: number;
  /**
   * Active model's maxContextTokens, from settings.json. Undefined when
   * the user's chosen model entry doesn't declare one (e.g. openai
   * models in the default config). We fall back to FALLBACK_MAX and
   * surface a note in the hover tooltip so users don't misread the
   * ring as the wrong fullness.
   */
  max?: number;
  /** True while an agent run is in flight — show breathing animation. */
  busy?: boolean;
}

// Fallback when the active model entry doesn't declare maxContextTokens.
// 200k is closer to what most current frontier models actually offer
// (GPT-5/Claude/Gemini Pro all sit at ≥200k); a 128k default kept making
// 200k-context models look ~50% fuller than they really were.
const FALLBACK_MAX = 200_000;

export function ContextRing({ used, max, busy }: Props) {
  const { t } = useT();
  const [hover, setHover] = useState(false);

  const hasDeclaredMax = typeof max === "number" && max > 0;
  const safeMax = hasDeclaredMax ? (max as number) : FALLBACK_MAX;
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
    !hasUsage ? "hsl(var(--cs-muted-foreground))" :
    ratio >= 0.9 ? "hsl(var(--cs-status-err))" :
    ratio >= 0.7 ? "hsl(var(--cs-status-warn))" :
    "hsl(var(--cs-status-ok))";

  const pctLabel = !hasUsage ? (busy ? "·" : "—") : `${pct}%`;

  return (
    <div
      className={"relative inline-flex items-center gap-1" + (busy ? " animate-pulse" : "")}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="leading-none">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="hsl(var(--cs-border))"
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
      <span className="text-xs font-medium" style={{ color: tone }}>{pctLabel}</span>

      {hover && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
          {!hasUsage ? (
            <div className="text-sm">
              {busy ? t("chat.contextRing.waitingEngine") : t("chat.contextRing.newSession")}
              <div className="mt-1 text-xs text-muted-foreground">
                {t("chat.contextRing.max", { value: formatTok(safeMax) })}
                {!hasDeclaredMax && t("chat.contextRing.maxDefaultNote")}
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("chat.contextRing.used")}</span>
                <span>{formatTok(used)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("chat.contextRing.remaining")}</span>
                <span>{formatTok(remaining)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("chat.contextRing.maxLabel")}</span>
                <span>
                  {formatTok(safeMax)}
                  {!hasDeclaredMax && <span className="text-muted-foreground">{t("chat.contextRing.defaultSuffix")}</span>}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
              </div>
              {!hasDeclaredMax && (
                <div className="mt-2 text-xs text-muted-foreground">
                  {t("chat.contextRing.fallbackNote")}
                </div>
              )}
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
