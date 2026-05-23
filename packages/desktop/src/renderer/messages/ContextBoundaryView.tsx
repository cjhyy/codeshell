import React from "react";
import type { ContextBoundaryMessage } from "../types";

export function ContextBoundaryView({ message }: { message: ContextBoundaryMessage }) {
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
