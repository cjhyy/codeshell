import React from "react";
import { ChevronRight } from "lucide-react";
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
    <details
      className="group min-w-0 px-4 py-1 text-[11px] text-muted-foreground"
      data-message-kind="turn-usage"
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className="shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <span>{t("msg.turnUsage.summary")}</span>
      </summary>
      <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 pl-4 tabular-nums">
        {parts.map((part) => (
          <span key={part} className="break-words">
            {part}
          </span>
        ))}
      </div>
    </details>
  );
}

export const TurnUsageMessageView = React.memo(TurnUsageMessageViewImpl);
