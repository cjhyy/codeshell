import React, { memo } from "react";
import type { ContextBoundaryMessage } from "../types";

function ContextBoundaryViewImpl({ message }: { message: ContextBoundaryMessage }) {
  const delta = message.before - message.after;
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-2 text-xs text-muted-foreground">
      <span>— context compacted ({message.strategy}) —</span>
      <span>
        {message.before.toLocaleString()} → {message.after.toLocaleString()} tokens
        {delta > 0 && ` (−${delta.toLocaleString()})`}
      </span>
    </div>
  );
}

// Memoized — see Markdown / ToolCard for the rationale.
export const ContextBoundaryView = memo(ContextBoundaryViewImpl);
