import React, { useEffect, useRef } from "react";
import type { Message } from "./types";
import { ToolCallBlock } from "./ToolCallBlock";
import { Markdown } from "./Markdown";

export function MessageStream({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="stream">
      {messages.map((m) => {
        if (m.kind === "tool") return <ToolCallBlock key={m.id} message={m} />;

        if (m.kind === "user") {
          return (
            <div key={m.id} className="msg-row msg-row-user">
              <div className="msg-user-bubble">{m.text}</div>
            </div>
          );
        }

        if (m.kind === "assistant") {
          return (
            <div key={m.id} className={`msg-row msg-row-assistant ${m.done ? "done" : "streaming"}`}>
              {m.done ? (
                <Markdown text={m.text} />
              ) : (
                // While streaming, render plain text — re-parsing markdown
                // on every token causes layout thrash. Switch to Markdown
                // once `done` flips in the turn_complete reducer case.
                <div className="md-body md-streaming">
                  <pre>{m.text || "…"}</pre>
                </div>
              )}
            </div>
          );
        }

        return (
          <div key={m.id} className="msg-row msg-row-system">
            <div className="msg-system">{m.text}</div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
