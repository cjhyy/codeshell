import React from "react";
import { ChartNoAxesColumn } from "lucide-react";
import type { TurnUsageMessage } from "../types";
import { formatTok } from "../chat/ContextRing";
import { useT } from "../i18n/I18nProvider";

/**
 * What the turn just spent, in an optional footer below its output.
 * The TUI has always printed this after every turn; without
 * it the desktop gave no cost signal at all, so a 35-turn research run that
 * consumed 17.8M tokens looked the same as a one-line answer. The ContextRing
 * next to the composer shows how full the context window is — a different
 * question from what this turn cost.
 */
function TurnUsageMessageViewImpl({ message }: { message: TurnUsageMessage }) {
  const { t } = useT();
  const { promptTokens, cacheReadTokens, cacheCreationTokens } = message;
  // Cache counts are already included in promptTokens. Keep them as a breakdown,
  // rather than adding them to the headline or implying this includes output.
  const cacheMetrics = [
    { label: t("msg.turnUsage.cached"), value: cacheReadTokens },
    { label: t("msg.turnUsage.cacheWrite"), value: cacheCreationTokens },
  ].filter(({ value }) => value > 0);
  return (
    <div className="min-w-0 px-4 py-1 text-xs text-muted-foreground" data-message-kind="turn-usage">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5 py-1">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <ChartNoAxesColumn size={14} className="shrink-0" aria-hidden />
          <span>{t("msg.turnUsage.summary")}</span>
          <span className="font-medium tabular-nums text-foreground/80">
            {t("msg.turnUsage.tokens", { count: formatTok(promptTokens) })}
          </span>
        </div>
        {cacheMetrics.length > 0 && (
          <dl className="contents">
            {cacheMetrics.map(({ label, value }) => (
              <div
                key={label}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-muted/40 px-2 py-1"
              >
                <dt>{label}</dt>
                <dd className="font-medium tabular-nums text-foreground/80">{formatTok(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

export const TurnUsageMessageView = React.memo(TurnUsageMessageViewImpl);
