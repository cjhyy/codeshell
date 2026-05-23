import React from "react";
import type { Message } from "./types";
import { ToolCallBlock } from "./ToolCallBlock";
import { Markdown } from "./Markdown";
import { ThinkingMessageView } from "./messages/ThinkingMessageView";
import { AgentMessageView } from "./messages/AgentMessageView";
import { TaskListMessageView } from "./messages/TaskListMessageView";
import { ContextBoundaryView } from "./messages/ContextBoundaryView";
import { useStickToBottom } from "./chat/stickToBottom";

export function MessageStream({ messages }: { messages: Message[] }) {
  // Stick-to-bottom: only auto-scroll when the user is already at
  // the bottom. Releases as soon as they scroll up, re-engages when
  // they return. Triggered by messages.length so per-delta text
  // appends don't fire scroll on every keystroke-equivalent.
  const ref = useStickToBottom<HTMLDivElement>(messages.length);

  return (
    <div className="stream" ref={ref}>
      {messages.map((m) => {
        switch (m.kind) {
          case "tool":
            return <ToolCallBlock key={m.id} message={m} />;
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
            return <TaskListMessageView key={m.id} message={m} />;
          case "context_boundary":
            return <ContextBoundaryView key={m.id} message={m} />;
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
