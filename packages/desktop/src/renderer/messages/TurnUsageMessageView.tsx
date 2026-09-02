import React from "react";
import type { TurnUsageMessage } from "../types";
import { formatTok } from "../chat/ContextRing";
import { useT } from "../i18n/I18nProvider";

/**
 * What the turn just spent, as a thin right-aligned line matching
 * TurnEndMessageView. The TUI has always printed this after every turn; without
 * it the desktop gave no cost signal at all, so a 35-turn research run that
 * consumed 17.8M tokens looked the same as a one-line answer. The ContextRing
 * next to the composer shows how full the context window is — a different
 * question from what this turn cost.
 */
function TurnUsageMessageViewImpl({ message }: { message: TurnUsageMessage }) {
  const { t } = useT();
  const { promptTokens, cacheReadTokens, cacheCreationTokens } = message;
  // Cache reads are the bulk of a long turn's tokens and are billed differently,
  // so show them separately instead of folding everything into one number.
  const parts = [t("msg.turnUsage.tokens", { count: formatTok(promptTokens) })];
  if (cacheReadTokens > 0) {
    parts.push(t("msg.turnUsage.cached", { count: formatTok(cacheReadTokens) }));
  }
  if (cacheCreationTokens > 0) {
    parts.push(t("msg.turnUsage.cacheWrite", { count: formatTok(cacheCreationTokens) }));
  }
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{parts.join(" · ")}</span>
    </div>
  );
}

export const TurnUsageMessageView = React.memo(TurnUsageMessageViewImpl);
