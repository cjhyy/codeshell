import React, { memo, useState } from "react";
import type { ThinkingMessage } from "../types";
import { ChevronDown, ChevronRight } from "../ui/icons";

// Memoized — see Markdown / ToolCard for the rationale. ThinkingMessage
// references are stable across text_delta dispatches, so default
// shallow compare correctly short-circuits.
function ThinkingMessageViewImpl({ message }: { message: ThinkingMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`msg-row msg-thinking ${message.done ? "done" : "streaming"}`}>
      <button className="msg-thinking-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="msg-thinking-label">
          {message.done ? "thinking" : "thinking…"}
        </span>
      </button>
      {open && <pre className="msg-thinking-body">{message.text}</pre>}
    </div>
  );
}

export const ThinkingMessageView = memo(ThinkingMessageViewImpl);
