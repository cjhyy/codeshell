import React, { useRef, useState } from "react";
import { useAnchoredPopover } from "./useAnchoredPopover";
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
  /**
   * SESSION-CUMULATIVE prompt-cache counts (summed across the whole session,
   * reset on model switch). Drive the "本会话累计命中率" tooltip row. Both 0 /
   * undefined on a fresh session or providers with no cache info → row hidden.
   */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Session-cumulative prompt tokens (sum across every response). The hit-rate
   * denominator: uncached = sessionPromptTokens − read − creation. Distinct
   * from `used` (the CURRENT context size), which drives the ring fill.
   */
  sessionPromptTokens?: number;
}

/**
 * Prompt-cache hit rate, same formula as core's cacheHitRate:
 *   read / (read + creation + uncachedInput), uncachedInput = prompt − read − creation.
 * Returns null when there's no cache signal at all, so the tooltip hides the
 * row rather than showing a misleading 0%.
 */
function computeHitRate(
  prompt: number,
  read: number | undefined,
  creation: number | undefined,
): number | null {
  const r = read ?? 0;
  const cr = creation ?? 0;
  if (r === 0 && cr === 0) return null;
  const uncached = Math.max(0, prompt - r - cr);
  const denom = r + cr + uncached;
  if (denom === 0) return null;
  return r / denom;
}

// Fallback when the active model entry doesn't declare maxContextTokens.
// 200k is closer to what most current frontier models actually offer
// (GPT-5/Claude/Gemini Pro all sit at ≥200k); a 128k default kept making
// 200k-context models look ~50% fuller than they really were.
const FALLBACK_MAX = 200_000;

export function ContextRing({
  used,
  max,
  busy,
  cacheReadTokens,
  cacheCreationTokens,
  sessionPromptTokens,
}: Props) {
  const { t } = useT();
  const [hover, setHover] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchored to the viewport with flip + four-edge clamp so the card can't spill
  // off-screen when the TopBar narrows (was `absolute bottom-full right-0`).
  const popoverStyle = useAnchoredPopover(hover, anchorRef, popoverRef, {
    preferredSide: "top",
    align: "end",
    gap: 4,
  });

  const hasDeclaredMax = typeof max === "number" && max > 0;
  const safeMax = hasDeclaredMax ? (max as number) : FALLBACK_MAX;
  const ratio = Math.max(0, Math.min(1, used / safeMax));
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, safeMax - used);
  const hasUsage = used > 0;
  // Cumulative hit rate uses the cumulative prompt total as the denominator
  // (falls back to `used` for legacy states that predate sessionPromptTokens).
  const hitRate = computeHitRate(
    sessionPromptTokens ?? used,
    cacheReadTokens,
    cacheCreationTokens,
  );

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
      ref={anchorRef}
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
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="w-56 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
        >
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
              {hitRate !== null && (
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("chat.contextRing.cacheHitSession")}</span>
                  <span>{Math.round(hitRate * 100)}%</span>
                </div>
              )}
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
