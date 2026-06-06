import React from "react";
import type { TurnEndMessage } from "../types";

/**
 * Thin, non-foldable marker for how a turn ended when it wasn't a natural
 * completion (TODO 2.8): a right-aligned faint line with a divider, sitting
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

function label(message: TurnEndMessage): string {
  const t = formatElapsed(message.elapsedMs);
  switch (message.reason) {
    case "stopped":
      return t ? `你在 ${t} 后停止了` : "你停止了本轮";
    case "timeout":
      return t ? `本轮在 ${t} 后超时停止` : "本轮超时停止";
    case "error":
      return message.detail ? `本轮出错停止：${message.detail}` : "本轮出错停止";
  }
}

function TurnEndMessageViewImpl({ message }: { message: TurnEndMessage }) {
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{label(message)}</span>
    </div>
  );
}

export const TurnEndMessageView = React.memo(TurnEndMessageViewImpl);
