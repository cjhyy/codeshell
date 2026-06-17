import React, { memo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Markdown, streamingMarkdownClassName } from "../Markdown";
import { stripMarkdownToPlain } from "../markdown/stripMarkdown";
import { formatMessageTime } from "../messages/time";
import type { AssistantMessage } from "../types";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

interface Props {
  message: AssistantMessage;
  /** Session workspace dir — lets Markdown resolve relative image paths. */
  cwd?: string | null;
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
function AssistantMessageViewImpl({ message, cwd }: Props) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  // Nothing to draw without text — this view renders only `message.text`
  // (tool calls are separate ToolMessages). A streaming assistant starts
  // empty (suppress until the first token), and replay emits a done empty
  // assistant for every tool-only turn (e.g. a TodoWrite turn with no prose):
  // transcript-reader fires stream_request_start → text_delta("") →
  // assistant_message, leaving done:true text:"". Guarding only the !done
  // case let those render as blank bubbles after refresh. Suppress both.
  if (message.text === "") return null;

  const onCopy = (): void => {
    const plain = stripMarkdownToPlain(message.text);
    void navigator.clipboard.writeText(plain);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group px-4 py-2 text-sm">
      {message.done ? (
        <Markdown text={message.text} cwd={cwd} />
      ) : (
        <div className={streamingMarkdownClassName}>
          <pre className="whitespace-pre-wrap font-sans">{message.text}</pre>
        </div>
      )}
      {message.done && (
        <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          {(() => {
            // Footer shows the absolute answer time (today→time, 昨天,
            // weekday this week, else full date) — not the process/elapsed
            // duration, which lives on the turn-process card instead.
            const when = formatMessageTime(message.doneAt);
            if (!when) return null;
            return (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {when}
              </span>
            );
          })()}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onCopy}
            aria-label={t("msg.assistant.copyAria")}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? t("msg.assistant.copied") : t("msg.assistant.copy")}</span>
          </Button>
        </div>
      )}
    </div>
  );
}

export const AssistantMessageView = memo(AssistantMessageViewImpl);
