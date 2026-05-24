import React from "react";
import type { Message, ToolMessage } from "./types";
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
  selectedToolId?: string | null;
  onSelectTool?: (m: ToolMessage) => void;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
}

export function MessageStream({ messages, selectedToolId, onSelectTool, onAskUserAnswer }: Props) {
  const ref = useStickToBottom<HTMLDivElement>(messages.length);

  return (
    <div className="stream" ref={ref}>
      {messages.map((m) => {
        switch (m.kind) {
          case "tool":
            return (
              <ToolCard
                key={m.id}
                message={m}
                onSelect={onSelectTool}
                selectedId={selectedToolId}
              />
            );
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
          case "ask_user":
            return (
              <AskUserMessageView
                key={m.id}
                message={m}
                onAnswer={onAskUserAnswer ?? (() => undefined)}
              />
            );
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
