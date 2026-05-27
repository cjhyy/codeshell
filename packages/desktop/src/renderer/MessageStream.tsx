import React, { useMemo, useState } from "react";
import type { Message } from "./types";
import { ToolCard } from "./tool-cards";
import { Markdown } from "./Markdown";
import { ThinkingMessageView } from "./messages/ThinkingMessageView";
import { AgentMessageView } from "./messages/AgentMessageView";
import { TaskListMessageView } from "./messages/TaskListMessageView";
import { ContextBoundaryView } from "./messages/ContextBoundaryView";
import { AskUserMessageView } from "./messages/AskUserMessageView";
import { ToolGroupCard } from "./messages/ToolGroupCard";
import { buildStreamItems } from "./messages/streamGroups";
import { useStickToBottom } from "./chat/stickToBottom";
import { decodeWireForDisplay } from "./chat/attachments";
import { Lightbox } from "./chat/Lightbox";

interface Props {
  messages: Message[];
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  /**
   * Optional trailing slot rendered after the last message but still
   * inside the scrollable stream. Used by the chat shell to drop a
   * pending ApprovalCard at the end of the transcript so it scrolls
   * with the rest of the conversation (Codex-style inline approvals).
   */
  trailing?: React.ReactNode;
  /**
   * Stable identity of `trailing`. When it changes (e.g. a new
   * approval envelope arrives), the stick-to-bottom hook treats it
   * the same as a new message and scrolls into view.
   */
  trailingKey?: string | null;
}

export function MessageStream({
  messages,
  onAskUserAnswer,
  trailing,
  trailingKey,
}: Props) {
  const ref = useStickToBottom<HTMLDivElement>(
    `${messages.length}:${trailingKey ?? ""}`,
  );
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(
    null,
  );

  // Collapse adjacent tool calls of the same category into a single
  // foldable group, but only for tools BEFORE the last assistant
  // reply — the in-flight tool run stays expanded so the user can
  // watch what's happening right now.
  const items = useMemo(() => buildStreamItems(messages), [messages]);

  return (
    <div className="stream" ref={ref}>
      {items.map((m) => {
        if (m.kind === "tool_group") {
          return <ToolGroupCard key={m.id} group={m} />;
        }
        switch (m.kind) {
          case "tool":
            // Tool cards now display their full args/result body inline
            // when expanded — no separate inspector pane to feed.
            return <ToolCard key={m.id} message={m} />;
          case "user": {
            const { text, images } = decodeWireForDisplay(m.text);
            return (
              <div key={m.id} className="msg-row msg-row-user">
                <div className="msg-user-bubble">
                  {text && <div className="msg-user-text">{text}</div>}
                  {images.length > 0 && (
                    <div className="msg-user-images">
                      {images.map((img, i) => (
                        <img
                          key={i}
                          src={img.dataUrl}
                          alt={img.name || "image"}
                          title={img.name || undefined}
                          onClick={() =>
                            setZoomed({
                              src: img.dataUrl,
                              alt: img.name || "image",
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          case "assistant":
            return (
              <div
                key={m.id}
                className={`msg-row msg-row-assistant ${m.done ? "done" : "streaming"}`}
              >
                {m.done ? (
                  <Markdown text={m.text} />
                ) : (
                  <div className="md-body md-streaming">
                    <pre>{m.text || "…"}</pre>
                  </div>
                )}
              </div>
            );
          case "thinking":
            return <ThinkingMessageView key={m.id} message={m} />;
          case "agent":
            return <AgentMessageView key={m.id} message={m} />;
          case "task_list":
            // task_list is rendered as a pinned panel above the
            // composer (see ChatView), not inline in the scroll stream
            // — that way the user keeps tasks in view as new messages
            // push old ones up.
            return null;
          case "context_boundary":
            return <ContextBoundaryView key={m.id} message={m} />;
          case "ask_user":
            // ask_user is also pinned above the composer. We still
            // render the resolved (answered) cards inline so the chat
            // history reflects the conversation.
            return m.answer !== undefined ? (
              <AskUserMessageView
                key={m.id}
                message={m}
                onAnswer={onAskUserAnswer ?? (() => undefined)}
              />
            ) : null;
          case "system":
            return (
              <div key={m.id} className="msg-row msg-row-system">
                <div className="msg-system">{m.text}</div>
              </div>
            );
        }
      })}
      {trailing}
      {zoomed && (
        <Lightbox
          src={zoomed.src}
          alt={zoomed.alt}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>
  );
}
