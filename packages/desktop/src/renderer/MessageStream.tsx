import React from "react";
import type { Message } from "./types";
import { ToolCard } from "./tool-cards";
import { Markdown } from "./Markdown";
import { ThinkingMessageView } from "./messages/ThinkingMessageView";
import { AgentMessageView } from "./messages/AgentMessageView";
import { TaskListMessageView } from "./messages/TaskListMessageView";
import { ContextBoundaryView } from "./messages/ContextBoundaryView";
import { AskUserMessageView } from "./messages/AskUserMessageView";
import { useStickToBottom } from "./chat/stickToBottom";

interface Props {
  messages: Message[];
  onAskUserAnswer?: (requestId: string, answer: string) => void;
}

export function MessageStream({ messages, onAskUserAnswer }: Props) {
  const ref = useStickToBottom<HTMLDivElement>(messages.length);

  return (
    <div className="stream" ref={ref}>
      {messages.map((m) => {
        switch (m.kind) {
          case "tool":
            // Tool cards now display their full args/result body inline
            // when expanded — no separate inspector pane to feed.
            return <ToolCard key={m.id} message={m} />;
          case "user":
            return (
              <div key={m.id} className="msg-row msg-row-user">
                <div className="msg-user-bubble">{m.text}</div>
              </div>
            );
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
    </div>
  );
}
