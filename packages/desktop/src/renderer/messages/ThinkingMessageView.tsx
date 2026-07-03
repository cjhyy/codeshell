import React, { memo, useState } from "react";
import type { ThinkingMessage } from "../types";
import { ChevronDown, ChevronRight } from "../ui/icons";
import { StreamingMarkdown } from "./StreamingMarkdown";

// Memoized — see Markdown / ToolCard for the rationale. ThinkingMessage
// references are stable across text_delta dispatches, so default
// shallow compare correctly short-circuits.
function ThinkingMessageViewImpl({ message }: { message: ThinkingMessage }) {
  const [open, setOpen] = useState(false);
  // Empty thinking = nothing to reveal; the toggle alone is a blank block.
  // (Replay / empty thinking_delta can land here with text:"".)
  if (message.text === "") return null;
  return (
    <div className="px-4 py-1">
      <button
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{message.done ? "thinking" : "thinking…"}</span>
      </button>
      {open && (
        <div className="mt-1 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
          <StreamingMarkdown text={message.text} done={message.done} />
        </div>
      )}
    </div>
  );
}

export const ThinkingMessageView = memo(ThinkingMessageViewImpl);
