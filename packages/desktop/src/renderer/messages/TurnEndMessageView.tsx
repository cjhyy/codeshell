import React from "react";
import type { TurnEndMessage } from "../types";
import { useT, type TFunction } from "../i18n/I18nProvider";

/**
 * Thin, non-foldable marker for how a turn ended when it wasn't a natural
 * completion (TODO 2.8): a compact status aligned with the assistant, sitting
 * below the assistant output it interrupted. Distinguishes manual stop /
 * timeout / error. Deliberately NOT a tool/thinking fold card.
 */
function formatElapsed(ms?: number): string {
  if (ms === undefined || ms < 0) return "";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

function label(message: TurnEndMessage, t: TFunction): string {
  const elapsed = formatElapsed(message.elapsedMs);
  switch (message.reason) {
    case "stopped":
      return elapsed ? t("msg.turnEnd.stoppedAt", { time: elapsed }) : t("msg.turnEnd.stopped");
    case "timeout":
      return elapsed ? t("msg.turnEnd.timeoutAt", { time: elapsed }) : t("msg.turnEnd.timeout");
    case "error":
      return message.detail
        ? t("msg.turnEnd.errorWithDetail", { detail: message.detail })
        : t("msg.turnEnd.error");
  }
}

function TurnEndMessageViewImpl({ message }: { message: TurnEndMessage }) {
  const { t } = useT();
  return (
    <div className="min-w-0 px-4 py-1 text-xs text-muted-foreground" data-message-kind="turn-end">
      <span className="break-words [overflow-wrap:anywhere]">{label(message, t)}</span>
    </div>
  );
}

export const TurnEndMessageView = React.memo(TurnEndMessageViewImpl);
