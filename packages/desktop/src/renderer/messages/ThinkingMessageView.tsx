import React, { memo, useId, useState } from "react";
import { Brain, Loader2 } from "lucide-react";
import type { ThinkingMessage } from "../types";
import { ChevronRight } from "../ui/icons";
import { useT } from "../i18n/I18nProvider";
import { StreamingMarkdown } from "./StreamingMarkdown";

// Memoized — see Markdown / ToolCard for the rationale. ThinkingMessage
// references are stable across text_delta dispatches, so default
// shallow compare correctly short-circuits.
function ThinkingMessageViewImpl({ message }: { message: ThinkingMessage }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  // Empty thinking = nothing to reveal; the toggle alone is a blank block.
  // (Replay / empty thinking_delta can land here with text:"".)
  if (message.text === "") return null;
  return (
    <div className="cs-thinking" data-state={message.done ? "settled" : "running"}>
      <button
        type="button"
        className="cs-thinking-heading"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="cs-thinking-icon" aria-hidden="true">
          {message.done ? <Brain size={14} /> : <Loader2 size={14} className="animate-spin" />}
        </span>
        <span className="cs-thinking-title">
          {t(message.done ? "msg.thinking.title" : "msg.thinking.running")}
        </span>
        <ChevronRight
          size={12}
          className={
            "cs-thinking-chevron shrink-0 transition-transform " + (open ? "rotate-90" : "")
          }
          aria-hidden="true"
        />
      </button>
      {open && (
        <div id={bodyId} className="cs-thinking-body" aria-busy={!message.done}>
          <StreamingMarkdown text={message.text} done={message.done} />
        </div>
      )}
    </div>
  );
}

export const ThinkingMessageView = memo(ThinkingMessageViewImpl);
