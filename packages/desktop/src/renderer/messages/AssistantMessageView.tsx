import React, { memo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Markdown } from "../Markdown";
import { stripMarkdownToPlain } from "../markdown/stripMarkdown";
import type { AssistantMessage } from "../types";

interface Props {
  message: AssistantMessage;
}

/**
 * One done/streaming assistant turn, plus a footer action row (just
 * a copy button today). Streaming uses the same plain `<pre>` shell
 * as before — we don't want to thrash ReactMarkdown re-parses on
 * every token. Once `done` we render proper markdown and surface
 * the copy affordance.
 *
 * Memoized — the reducer produces a new AssistantMessage object only
 * when that specific message's text/done changes, so siblings skip
 * re-render entirely during a long session.
 */
function AssistantMessageViewImpl({ message }: Props) {
  const [copied, setCopied] = useState(false);
  if (!message.done && message.text === "") return null;

  const onCopy = (): void => {
    const plain = stripMarkdownToPlain(message.text);
    void navigator.clipboard.writeText(plain);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group px-4 py-2 text-sm">
      {message.done ? (
        <Markdown text={message.text} />
      ) : (
        <div className="md-body md-streaming">
          <pre className="whitespace-pre-wrap font-sans">{message.text}</pre>
        </div>
      )}
      {message.done && (
        <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onCopy}
            aria-label="Copy reply as plain text"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export const AssistantMessageView = memo(AssistantMessageViewImpl);
