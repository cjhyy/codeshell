import React, { memo } from "react";
import type { ContextBoundaryMessage } from "../types";

function ContextBoundaryViewImpl({ message }: { message: ContextBoundaryMessage }) {
  const delta = message.before - message.after;
  return (
    <div className="msg-row msg-ctx">
      <div className="msg-ctx-line">
        <span className="msg-ctx-label">— context compacted ({message.strategy}) —</span>
        <span className="msg-ctx-detail">
          {message.before.toLocaleString()} → {message.after.toLocaleString()} tokens
          {delta > 0 && ` (−${delta.toLocaleString()})`}
        </span>
      </div>
    </div>
  );
}

// Memoized — see Markdown / ToolCard for the rationale.
export const ContextBoundaryView = memo(ContextBoundaryViewImpl);
